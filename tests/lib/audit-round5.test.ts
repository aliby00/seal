import { afterEach, describe, expect, it, vi } from 'vitest';
import { findClaims, withoutClaims } from '../../src/lib/agent/claims';
import { renderLaunch, renderReport } from '../../src/lib/agent/prompt';
import { keepAnalysis, type CachedAnalysis } from '../../src/lib/analysis-cache';
import {
  BLOCKS_PER_SECOND,
  findMarketsById,
  INITIALIZE_TOPIC,
  MarketIndex,
  NATIVE,
  POOL_MANAGER,
  type IndexedMarket,
} from '../../src/lib/chain/pools';
import type { RawLog } from '../../src/lib/chain/logs';
import type { BatchOutcome, RpcClient, RpcRequest } from '../../src/lib/chain/rpc';
import { feePayers, readPoolRules } from '../../src/lib/collect';
import type { LaunchReplay, LaunchedToken, ListedPool, TokenReport } from '../../src/lib/contracts';
import { questionsFailed, readFailed } from '../../src/lib/failed-reads';
import { toFacts, type ReportFacts } from '../../src/lib/facts';
import { buildGlance, partialNotice } from '../../src/lib/glance';
import { listedPools, pickPrimaryPair, type DexScreenerPair } from '../../src/lib/market';
import { feePayerWords } from '../../src/lib/set-aside';
import { unansweredOf, type SpecialistAnswer } from '../../src/lib/specialists/brief';
import { CATALOG } from '../../src/lib/specialists/catalog';
import { fromReport, gatherContext } from '../../src/lib/specialists/context';
import { shortAnswer } from '../../src/lib/specialists/plain';
import type { SpecialistContext } from '../../src/lib/specialists/types';
import fixture from '../chain/fixtures/audit-round5.json';
import { makeReport } from '../specialists/helpers';

/**
 * Regressions from the fifth audit of displayed facts (staging, 18/10/2026).
 * The pools are DexScreener's listing of each token read that day, and the
 * `Initialize` of each of their v4 pools as the PoolManager logged it; the
 * texts and answers are the analyses staging served.
 */

const DOPPLER = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
const HOOK_9921 = '0x992118de23b4ebe9f527dacbbb7d8d4bbbf8e044';
const HOOK_E5E7 = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';

type TokenPools = {
  token: string;
  pairs: DexScreenerPair[];
  initialize: RawLog[];
};
const POOLS = fixture.pools as unknown as {
  latestBlock: number;
  readAt: number;
  tokens: Record<string, TokenPools>;
};

/** A node serving the fixture's `Initialize` logs, one id per query, as the real one demands. */
function poolNode(logs: readonly RawLog[]): RpcClient & { queries: RpcRequest[] } {
  const queries: RpcRequest[] = [];
  const answer = (request: RpcRequest): BatchOutcome<unknown> => {
    queries.push(request);
    if (request.method === 'eth_blockNumber')
      return { ok: true, value: `0x${POOLS.latestBlock.toString(16)}` };
    if (request.method !== 'eth_getLogs') return { ok: false, error: 'not served' };
    const filter = request.params[0] as {
      address: string;
      topics: (string | string[] | null)[];
      fromBlock: string;
      toBlock: string;
    };
    const id = filter.topics[1];
    if (Array.isArray(id)) {
      // The node's own answer to a list of ids over a long range.
      return {
        ok: false,
        error: 'only 100000 are allowed for this request; send one value per position',
      };
    }
    const from = Number(filter.fromBlock);
    const to = Number(filter.toBlock);
    if (to - from + 1 > 10_000_000) return { ok: false, error: 'query spans too many blocks' };
    return {
      ok: true,
      value: logs.filter(
        (l) =>
          l.address === POOL_MANAGER &&
          l.topics[0] === INITIALIZE_TOPIC &&
          l.topics[1] === id &&
          Number(l.blockNumber) >= from &&
          Number(l.blockNumber) <= to,
      ),
    };
  };
  return {
    queries,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const r = answer({ method, params });
      if (!r.ok) throw new Error(r.error);
      return r.value as T;
    },
    async callBatch<T>(requests: RpcRequest[]): Promise<BatchOutcome<T>[]> {
      return requests.map((r) => answer(r) as BatchOutcome<T>);
    },
  };
}

/** The token's listed pools with their rules read, as the collection reads them. */
async function poolsOf(name: string): Promise<{ pools: ListedPool[]; pair: string | null }> {
  const t = POOLS.tokens[name]!;
  const pair =
    pickPrimaryPair(
      t.pairs.filter((p) => p.baseToken?.address?.toLowerCase() === t.token),
    )?.pairAddress?.toLowerCase() ?? null;
  vi.useFakeTimers({ now: POOLS.readAt, toFake: ['Date'] });
  try {
    const pools = await readPoolRules(
      poolNode(t.initialize),
      listedPools(t.token, t.pairs),
      Promise.resolve([]),
      POOLS.latestBlock,
      pair,
    );
    return { pools, pair };
  } finally {
    vi.useRealTimers();
  }
}

async function reportOf(name: string): Promise<TokenReport> {
  const { pools, pair } = await poolsOf(name);
  const t = POOLS.tokens[name]!;
  return makeReport(t.token, (r) => {
    r.market.data.pair = pair;
    r.market.data.pools = pools;
    r.market.data.txns = { h1: { buys: 5, sells: 4 }, h24: { buys: 3524, sells: 2465 } };
  });
}

function contextOf(report: TokenReport): SpecialistContext {
  return { token: report.token, report, ...fromReport(report.token, report) };
}

const MARKET_QUESTIONS = ['code-reuse', 'sell-path', 'rule-change'] as const;
const NO_HOOK = /no hook|without trading rules|no contract sits between a sell and the pool/i;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1. The market whose rules are read is the main pool, and every pool counts

describe('the main pool and every other pool (item 1)', () => {
  it('finds each pool’s Initialize where its creation time puts it, one id per query', async () => {
    for (const name of ['BOOMER', 'MEME', 'BONER', 'WHEELSMITH', 'WORM', 'ASTEROID']) {
      const t = POOLS.tokens[name]!;
      const node = poolNode(t.initialize);
      const ids = t.initialize.map((l) => l.topics[1]!);
      const created = new Map(t.pairs.map((p) => [p.pairAddress!.toLowerCase(), p.pairCreatedAt]));
      const { markets, unread } = await findMarketsById(
        node,
        ids.map((id) => ({ id, createdAt: created.get(id) ?? null })),
        POOLS.latestBlock,
        { now: POOLS.readAt, fullScanFor: 0 },
      );
      // ASTEROID's main pool, 82 M blocks back, found at ~9.9 blocks a second.
      expect(markets.map((m) => m.id).sort(), name).toEqual([...ids].sort());
      expect(unread).toBe(false);
      expect(node.queries).toHaveLength(ids.length);
    }
    expect(BLOCKS_PER_SECOND).toBeGreaterThan(9.7);
  });

  it('searches the whole chain for the main pool when its creation time is not given', async () => {
    const t = POOLS.tokens.ASTEROID!;
    const node = poolNode(t.initialize);
    const id = t.initialize[0]!.topics[1]!;
    const { markets } = await findMarketsById(node, [{ id }], POOLS.latestBlock, {
      now: POOLS.readAt,
    });
    expect(markets[0]?.hook).toBe(DOPPLER);
    expect(markets[0]?.blockNumber).toBe(9_681_917);
  });

  it.each([
    ['BOOMER', HOOK_9921, '0xf4a65e0f'],
    ['BONER', DOPPLER, '0x9c89b043'],
    ['WHEELSMITH', HOOK_9921, '0x37c81007'],
    ['WORM', HOOK_E5E7, '0xf49ee5b6'],
    ['ASTEROID', DOPPLER, '0x15a09db7'],
  ])('%s: reads the hook of its main pool, never "no hook"', async (name, hook, main) => {
    const report = await reportOf(name);
    expect(report.market.data.pair?.startsWith(main)).toBe(true);
    const context = contextOf(report);
    expect(context.market?.hook).toBe(hook);
    expect(context.hook?.hook).toBe(hook);
    for (const id of MARKET_QUESTIONS) {
      const f = CATALOG[id].run(context);
      expect(f.facts.join(' '), `${name} ${id}`).not.toMatch(
        /^This market runs without|This market has no trading rules|no contract sits between a sell and the pool/,
      );
    }
    expect(CATALOG['sell-path'].run(context).signal).not.toBe('reassurance');
  });

  it('BOOMER: the recent index’s hookless pool no longer stands for the token', async () => {
    // The regression of round 4: the live index held only a BOOMER/USDG pool
    // opened minutes before, hookless, and it was read as the market.
    const report = await reportOf('BOOMER');
    const recent: IndexedMarket = {
      id: '0x52f2f0f1c2fc19953b2966292b5e5bcb9f9330033c8c9f47e83f83c645232688',
      currency0: report.token,
      currency1: '0x5fc5360d00000000000000000000000000000000',
      fee: 3000,
      tickSpacing: 60,
      hook: NATIVE,
      blockNumber: POOLS.latestBlock - 1_000,
      transactionHash: `0x${'1'.repeat(64)}`,
      token: report.token,
    };
    const index = new MarketIndex([recent]);
    const dead = poolNode([]);
    vi.stubEnv('INDEXER_URL', '');
    vi.stubEnv('BLOCKSCOUT_API_KEY', '');
    const context = await gatherContext(dead, report.token, report, index);
    expect(context.market?.id.startsWith('0xf4a65e0f')).toBe(true);
    expect(context.hook?.hook).toBe(HOOK_9921);
  });

  it('MEME: its main pool has no hook, and a pool beside it with one is said', async () => {
    const report = await reportOf('MEME');
    const context = contextOf(report);
    expect(context.market?.hook).toBe(NATIVE);
    const reuse = CATALOG['code-reuse'].run(context);
    expect(reuse.facts[0]).toMatch(
      /^The main pool of this token \(0x4652…1b17, \$\d+\.\dk liquidity\) runs without trading rules \(hook\)\.$/,
    );
    expect(reuse.facts.join(' ')).toMatch(
      /Another pool of this token \(0x8660…ec1f, \$85\.\dk liquidity\) runs trading rules \(hook\) 0x08e52564bad99e05a694b4809f397edca417a080/,
    );
    const sell = CATALOG['sell-path'].run(context);
    expect(sell.signal).toBe('observation');
    expect(sell.facts.join(' ')).not.toMatch(/no contract sits between a sell and the pool\./);
    expect(sell.facts[0]).toMatch(/no contract sits between a sell in that pool and the pool/);
    expect(CATALOG['rule-change'].run(context).signal).toBe('observation');
    expect(shortAnswer({ ...reuse, title: '', question: '' } as SpecialistAnswer)).toBe(
      'Its main pool has no special trading rules; another pool has',
    );
  });

  it.each(['RH', 'OWN'])('%s: a v3/v2 main pool still has no hook', async (name) => {
    const report = await reportOf(name);
    const context = contextOf(report);
    expect(context.market).toBeNull();
    const sell = CATALOG['sell-path'].run(context);
    expect(sell.facts[0]).toMatch(
      /^No Uniswap v4 trading rules \(hook\) sit in front of trades in its main pool/,
    );
    expect(sell.facts.join(' ')).not.toMatch(/runs trading rules/);
    expect(CATALOG['code-reuse'].run(context).signal).toBe('unknown');
    // OWN's $12 v4 pool is dust, not a pool that weighs.
    expect(context.otherPools?.some((p) => p.version === 'v4')).toBe(false);
  });

  it('a main pool whose rules could not be read is unknown, never hookless', async () => {
    const t = POOLS.tokens.BOOMER!;
    const pair = '0xf4a65e0f8e6022800a8ed713b1dae86548d198b8b483f73c7180de3d09fc0935';
    const pools = await readPoolRules(
      poolNode([]),
      listedPools(t.token, t.pairs),
      Promise.resolve([]),
      POOLS.latestBlock,
      pair,
    );
    expect(pools.find((p) => p.id === pair)?.v4).toBeNull();
    const report = makeReport(t.token, (r) => {
      r.market.data.pair = pair;
      r.market.data.pools = pools;
    });
    const context = await gatherContext(poolNode([]), t.token, report);
    expect(context.mainRulesUnread).toBe(true);
    for (const id of MARKET_QUESTIONS) {
      const f = CATALOG[id].run(context);
      expect(f.signal).toBe('unknown');
      expect(f.facts.join(' ')).not.toMatch(NO_HOOK);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. A question that ran out of time is a read that failed

describe('timeouts are failed reads (item 2)', () => {
  const answers = fixture.ai.specialists as SpecialistAnswer[];

  it('AI: six questions out of time make the report partial and keep it out of every cache', () => {
    const unanswered = unansweredOf(answers);
    expect(unanswered).toEqual([
      'code-reuse',
      'wallet-age',
      'funding-trace',
      'name-clone',
      'liquidity-move',
      'rule-change',
    ]);
    const failed = questionsFailed(unanswered, answers.length);
    expect(failed?.read).toBe('questions');
    expect(failed?.note).toMatch(/^6 of the 10 questions did not finish in time/);
    const report = makeReport(fixture.ai.token, (r) => {
      r.failedReads = [failed!];
    });
    const facts = toFacts(report);
    expect(readFailed(facts.failed, 'questions')).toBe(true);
    const glance = buildGlance({ facts, specialists: answers })!;
    expect(partialNotice(glance.partial!)).toMatch(/some of the ten questions/);
    expect(renderReport(report)).toMatch(/some of the ten questions/);
    const body = {
      token: fixture.ai.token,
      explanation: 'x',
      completeness: 'full',
      sources: [],
      costUsd: 0,
      collectedAt: report.collectedAt,
      offline: false,
      specialists: answers,
    } as CachedAnalysis;
    // Even without the failed read on the facts, the answers alone say it.
    expect(keepAnalysis(body, true)).toBe(false);
  });

  it('a timeout leaves the main pool’s rules answered from the report', async () => {
    const report = await reportOf('BOOMER');
    const context = { token: report.token, report, ...fromReport(report.token, report) };
    expect(CATALOG['sell-path'].run(context).facts.join(' ')).toMatch(
      /may change the amount of any trade/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Doppler's contract named by its role, unless it is the main pool's hook

describe('who paid the creator fees (item 3)', () => {
  it('MEME: Doppler’s launch contract, not the market’s hook; ASTEROID, BONER: the main pool’s hook', async () => {
    const meme = await poolsOf('MEME');
    const [memePayer] = feePayers([DOPPLER], meme.pair, meme.pools);
    expect(memePayer?.role).toBe('launch');
    expect(feePayerWords([memePayer!], [DOPPLER])).toBe(
      `Doppler’s launch contract, which holds the positions of the markets Doppler opens and pays out their fees (${DOPPLER})`,
    );
    for (const name of ['ASTEROID', 'BONER']) {
      const { pools, pair } = await poolsOf(name);
      const [payer] = feePayers([DOPPLER], pair, pools);
      expect(payer?.role, name).toBe('main-hook');
      expect(feePayerWords([payer!], [DOPPLER])).toBe(
        `the trading rules (hook) of its main pool, ${DOPPLER}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. ASTEROID: the size of the fees, "launches", and the other launches' count

function asteroidReport(): TokenReport {
  const a = fixture.asteroid;
  return makeReport(a.token, (r) => {
    r.creator.data.tokens = a.timeline.map(
      (t) =>
        ({
          address: t.address,
          pool: '0x',
          launchedAtBlock: t.block,
          launchedAt: null,
          outcome: 'undetermined',
          graduationProgress: 0,
          creatorDumped: t.sold,
          liquidityPulled: t.pulled,
          ...(t.current
            ? {
                feesCollected: true,
                feesTaken: {
                  share: a.creatorFacts.ownFees.share,
                  transfers: a.creatorFacts.ownFees.transfers,
                  hooks: [DOPPLER],
                  payers: [{ address: DOPPLER, role: 'main-hook' as const }],
                },
              }
            : {}),
        }) as LaunchedToken,
    );
    r.creator.data.counts.launched = a.timeline.length;
  });
}

describe('ASTEROID (item 4)', () => {
  it('gives the size of the fees in the glance, and writes "launches"', () => {
    const facts: ReportFacts = toFacts(asteroidReport());
    expect(facts.creator.liquidityChecked).toBe(9);
    const item = buildGlance({ facts })!.items.find((i) => i.id === 'liquidity');
    expect(item?.title).toBe(
      `The launch liquidity was never withdrawn on the 9 launches checked. On this token, the creator received 6.9% of the supply from the trading rules (hook) of its main pool, ${DOPPLER}, in 52 transfers: trading fees taken out of the market.`,
    );
  });

  it('corrects "8 of 10 other checked launches" to the others’ own count, 7 of 9', () => {
    const report = asteroidReport();
    const served = fixture.asteroid.explanation;
    expect(served).toContain('sold in 8 of 10 other checked launches');
    const { text, dropped } = withoutClaims(served, report);
    expect(dropped).toEqual([]);
    expect(text).toContain('sold in 7 of 9 other checked launches');
    expect(text).not.toContain('8 of 10 other');
    // A count of the others that is neither theirs nor the total is cut.
    expect(
      findClaims('The creator sold in 5 of 9 other launches checked.', report).map((c) => c.kind),
    ).toEqual(['count']);
    // The prompt says both numbers, and which one goes with "other".
    expect(renderReport(report)).toMatch(
      /the count is 7 of 9; 8 of 10 is the total with this token included/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. MUT8: the launch transaction delivered to contracts, not into pools

describe('MUT8 (item 5)', () => {
  const summary = fixture.mut8.summary as NonNullable<LaunchReplay['data']['summary']>;
  const launch = (codeSizes?: number[]): LaunchReplay => ({
    completeness: 'full',
    sources: [],
    data: {
      token: fixture.mut8.token,
      launchBlock: 90_457_875,
      launchedAt: '2026-10-17T00:00:00.000Z',
      windowSeconds: 600,
      supply: '1000000000000000000000000000',
      moves: [],
      movesInWindow: summary.moves,
      summary: {
        ...summary,
        creatorTx: { ...summary.creatorTx!, ...(codeSizes ? { codeSizes } : {}) },
      },
    },
  });

  it('cuts "which delivered into pools" and says plainly they are not pools', () => {
    const report = makeReport(fixture.mut8.token, (r) => {
      r.launch = launch([45, 45, 45]);
    });
    const kinds = findClaims(fixture.mut8.explanation, report).map((c) => c.kind);
    expect(kinds).toContain('into-pools');
    const { text } = withoutClaims(fixture.mut8.explanation, report);
    expect(text).not.toMatch(/delivered into pools/);
    const prompt = renderLaunch(report.launch!).join('\n');
    expect(prompt).toMatch(/their code size: 45 bytes, that is minimal proxies, EIP-1167 clones/);
    expect(prompt).toMatch(/They are not pools, not burn addresses and not the creator/);
    const glance = buildGlance({ facts: toFacts(report), launch: report.launch!.data })!;
    expect(glance.items.find((i) => i.id === 'launch-buys')?.title).toMatch(
      /to 3 contracts other than the creator’s wallet, none of them a pool;/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. A cut never leaves a dangling sentence, and a true one is kept

describe('AML (item 6)', () => {
  const report = makeReport(fixture.aml.token, (r) => {
    r.creator.data.tokens = [
      {
        address: fixture.aml.token,
        pool: '0x',
        launchedAtBlock: 91_141_466,
        launchedAt: null,
        outcome: 'undetermined',
        graduationProgress: 0,
        creatorDumped: true,
        liquidityPulled: false,
        feesCollected: true,
      } as LaunchedToken,
    ];
  });

  it('keeps "the creator sold … within its first launch window": a time, not a record', () => {
    const said =
      'What deserves attention\n\nThe creator sold this token within its first launch window. It also took tokens out of the liquidity position as collected fees without removing liquidity.';
    expect(findClaims(said, report)).toEqual([]);
    expect(withoutClaims(said, report).text).toBe(said);
  });

  it('gives the next sentence its subject back when the one before is cut', () => {
    const said = `What deserves attention\n\nThe creator’s record looks clean. ${fixture.aml.explanation.split('\n\n')[3]}`;
    const { text, dropped } = withoutClaims(said, report);
    expect(dropped.map((c) => c.kind)).toEqual(['clean-record']);
    expect(text?.split('\n\n')[1]).toMatch(
      /^The creator took tokens out of the liquidity position as collected fees/,
    );
    expect(text).not.toMatch(/\bIt also\b/);
  });

  it('drops a sentence that points at nothing any more', () => {
    const said =
      'What deserves attention\n\nNothing can be rewritten later. This is a strong signal. Only 0.15% of supply circulates.';
    const { text } = withoutClaims(said, report);
    expect(text).toBe('What deserves attention\n\nOnly 0.15% of supply circulates.');
  });
});

// ---------------------------------------------------------------------------
// 7. The hook's markets over the whole history; timing said exactly

describe('hook sharing and timing (item 7)', () => {
  it('MUT8 and its siblings on 0xe5e7…: the indexer’s count over every market', () => {
    const market: IndexedMarket = {
      id: `0x${'e'.repeat(64)}`,
      currency0: NATIVE,
      currency1: fixture.mut8.token,
      fee: 0,
      tickSpacing: 60,
      hook: HOOK_E5E7,
      blockNumber: 90_457_875,
      transactionHash: `0x${'c'.repeat(64)}`,
      token: fixture.mut8.token,
    };
    const context: SpecialistContext = {
      token: fixture.mut8.token,
      market,
      hookUse: { markets: 4, pairs: 4, indexedTo: 91_500_000 },
      index: new MarketIndex([]),
    };
    const f = CATALOG['code-reuse'].run(context);
    expect(f.facts[0]).toBe(
      `The trading rules (hook) ${HOOK_E5E7} are used by 4 market(s) on Robinhood Chain, this one included (every Uniswap v4 market the SEAL indexer has read, up to block 91500000).`,
    );
    // Without the indexer, the window is said, and this market is not counted in it.
    const windowed = CATALOG['code-reuse'].run({
      ...context,
      hookUse: undefined,
      index: new MarketIndex([
        { ...market, id: `0x${'f'.repeat(64)}`, blockNumber: 91_540_000, hook: NATIVE },
      ]),
    });
    expect(windowed.facts[0]).toMatch(
      /^Among the markets created in about the last 50 minutes \(blocks 91540000 to 91540000\) only, 0 other markets use .*not of the whole chain\.$/,
    );
    expect(windowed.limits.join(' ')).toMatch(/this market was created before them/);
    expect(shortAnswer({ ...windowed, title: '', question: '' } as SpecialistAnswer)).toBe(
      'No other recent market uses its trading rules',
    );
  });

  it('KEL: the funder bought at +11 s and sold back at +83 s, 72 s later, said as such', () => {
    const launch = fixture.kel.launch as unknown as LaunchReplay['data'];
    const funder = fixture.kel.funding.funding!.path[0]!.address;
    const lines = renderLaunch({ completeness: 'full', sources: [], data: launch }, { funder });
    expect(lines.join('\n')).toContain(
      `- Round trip: ${funder} (the first funder of the creator’s wallet) bought at +11 s and sold back at +83 s, 72 s later.`,
    );
  });
});
