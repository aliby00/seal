import { afterEach, describe, expect, it, vi } from 'vitest';
import { withoutClaims, withoutEmphasis } from '../../src/lib/agent/claims';
import { servedText } from '../../src/lib/agent/investigate';
import { renderReport, SYSTEM_PROMPT } from '../../src/lib/agent/prompt';
import { sourcesFailed } from '../../src/lib/analysis-cache';
import { fetchDeployerHistory, type TokenOrigin } from '../../src/lib/chain/deployer';
import { MarketIndex, NATIVE, type IndexedMarket } from '../../src/lib/chain/pools';
import type { RpcClient } from '../../src/lib/chain/rpc';
import { collect, creatorHistoryCache } from '../../src/lib/collect';
import type { LaunchReplayData, TokenReport } from '../../src/lib/contracts';
import {
  failedReadsOfSources,
  HOOK_COUNT_UNREAD_NOTE,
  readFailed,
  UNREAD,
} from '../../src/lib/failed-reads';
import { toFacts } from '../../src/lib/facts';
import { buildGlance, partialNotice } from '../../src/lib/glance';
import { partialOf, type SpecialistAnswer } from '../../src/lib/specialists/brief';
import { CATALOG, HOOK_COUNT_UNREAD } from '../../src/lib/specialists/catalog';
import type { SpecialistContext } from '../../src/lib/specialists/types';
import { makeReport } from '../specialists/helpers';

/**
 * Regressions from the sixth audit of displayed facts (staging, 18/10/2026):
 * the texts and figures are the analyses staging served that day.
 */

const DOPPLER = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
const AML = '0xd202f27a48649524b8555eac3365d366be8a1e18';

afterEach(() => {
  vi.unstubAllGlobals();
  creatorHistoryCache.clear();
});

// ---------------------------------------------------------------------------
// 1. Every hook's markets counted chain-wide; a window said as a window

describe('the markets on a hook (item 1)', () => {
  const market: IndexedMarket = {
    id: `0x${'d'.repeat(64)}`,
    currency0: NATIVE,
    currency1: AML,
    fee: 0,
    tickSpacing: 60,
    hook: DOPPLER,
    blockNumber: 91_540_000,
    transactionHash: `0x${'c'.repeat(64)}`,
    token: AML,
  };
  const siblings = Array.from({ length: 14 }, (_, i) => ({
    ...market,
    id: `0x${String(i + 1).padStart(64, '0')}`,
    currency1: `0x${String(i + 1).padStart(40, '0')}`,
    token: `0x${String(i + 1).padStart(40, '0')}`,
    blockNumber: 91_545_161 + i,
  }));

  it('AML on Doppler’s hook: the indexer’s count over the whole chain, as for every hook', () => {
    const f = CATALOG['code-reuse'].run({
      token: AML,
      market,
      hookUse: { markets: 210_175, pairs: 1_000, indexedTo: 91_585_881 },
      index: new MarketIndex(siblings),
    } as SpecialistContext);
    expect(f.facts[0]).toBe(
      `The trading rules (hook) ${DOPPLER} are used by 210175 market(s) on Robinhood Chain, this one included (every Uniswap v4 market the SEAL indexer has read, up to block 91585881).`,
    );
    expect(f.limits).not.toContain(HOOK_COUNT_UNREAD);
  });

  it('the indexer silent: the window is said, and the read is partial', () => {
    const f = CATALOG['code-reuse'].run({
      token: AML,
      market,
      hookUse: null,
      index: new MarketIndex(siblings),
    } as SpecialistContext);
    expect(f.facts[0]).toBe(
      `Among the markets created in about the last 50 minutes (blocks 91545161 to 91545174) only, 14 other markets use the trading rules (hook) ${DOPPLER}: a count of that recent window, not of the whole chain.`,
    );
    expect(f.limits[0]).toBe(HOOK_COUNT_UNREAD);
    const answers = [{ ...f, title: 'Code Reuse', question: 'q' }] as SpecialistAnswer[];
    expect(partialOf(answers)).toEqual([{ read: 'questions', note: HOOK_COUNT_UNREAD_NOTE }]);
    // Without an indexer configured, the window is all there is: no partial read.
    const without = CATALOG['code-reuse'].run({
      token: AML,
      market,
      index: new MarketIndex(siblings),
    } as SpecialistContext);
    expect(without.limits).not.toContain(HOOK_COUNT_UNREAD);
    expect(partialOf([{ ...without, title: '', question: '' }] as SpecialistAnswer[])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. No word of emphasis from the prompt in the text

describe('the prompt’s words of emphasis (item 2)', () => {
  it('ROBINHOOD and OWN: "EXACTEMENT" and "EXACTLY" are dropped from the text', () => {
    expect(
      withoutEmphasis(
        'EXACTEMENT 6 of the 8 largest displayed holders received tokens from the creator.',
      ),
    ).toBe('6 of the 8 largest displayed holders received tokens from the creator.');
    expect(
      withoutEmphasis(
        'Also, EXACTLY 70 early buyers purchased 78.04% of supply within 60 seconds.',
      ),
    ).toBe('Also, 70 early buyers purchased 78.04% of supply within 60 seconds.');
    expect(withoutEmphasis('The creator NEVER sold. NO sale was seen on THIS TOKEN.')).toBe(
      'The creator never sold. No sale was seen on this token.',
    );
    // A name copied from the chain keeps its capitals.
    expect(withoutEmphasis('The token calls itself "NO ONLY EXACTLY".')).toBe(
      'The token calls itself "NO ONLY EXACTLY".',
    );
    // Through both paths the model's text is served by.
    const report = makeReport(AML);
    expect(withoutClaims('What is reassuring\n\nEXACTLY 3 wallets bought.', report).text).toBe(
      'What is reassuring\n\n3 wallets bought.',
    );
    expect(servedText('What is reassuring\n\nEXACTEMENT 3 wallets bought.')).toBe(
      'What is reassuring\n\n3 wallets bought.',
    );
  });

  it('the facts given to the model are in English and carry no emphasis', () => {
    const launch = {
      launchBlock: 100,
      windowSeconds: 600,
      supply: '1000',
      moves: [],
      movesInWindow: 0,
      summary: {
        moves: 120,
        earlySeconds: 60,
        creatorAtLaunch: 0.02,
        creatorBought: 0.02,
        creatorSold: 0,
        early: { wallets: 70, contracts: 1, share: 0.7804, heldNow: 0.2498, unread: 0 },
        bundle: null,
      },
    } as unknown as LaunchReplayData;
    const report = makeReport(AML, (r) => {
      r.failedReads = [{ read: 'creator-sales', note: UNREAD.ownSales }];
      r.launch = { completeness: 'full', sources: [], data: launch };
      r.holders.data.creatorLinks = {
        sentTo: 3,
        holders: [],
        distributors: [],
        burned: 0,
      } as unknown as NonNullable<TokenReport['holders']['data']['creatorLinks']>;
    });
    const prompt = renderReport(report);
    expect(prompt).toMatch(/Early buyers .*: 70 addresses \(1 of them contract\)/);
    expect(prompt).toMatch(/of the \d+ largest holders shown received tokens from the creator/);
    expect(prompt).not.toMatch(/EXACT|[éèàùç]|\b(?:NEVER|ONLY|NOT|CREATOR|THIS TOKEN)\b/);
    // Every all-caps word left is a name or a unit, not an instruction.
    const shouted = new Set(prompt.match(/\b[A-Z]{3,}\b/g) ?? []);
    for (const word of shouted) expect(['SEAL', 'USD', 'ETH', 'EIP']).toContain(word);
    expect(SYSTEM_PROMPT).toMatch(/never write a word in capitals for emphasis/);
  });
});

// ---------------------------------------------------------------------------
// 3. A sentence that sums up, or names "the two", of nothing before it

describe('orphan sentences (item 3)', () => {
  const report = makeReport(AML);

  it('MUT8: "The two reads…" opening a section goes', () => {
    const said =
      'What is reassuring\n\nThe hook has no upgrade slot.\n\n' +
      'Where the signals diverge\n\nThe two reads use different methods, so the link depends on which one you weigh. The supply sits in three contracts.';
    expect(withoutClaims(said, report).text).toBe(
      'What is reassuring\n\nThe hook has no upgrade slot.\n\nWhere the signals diverge\n\nThe supply sits in three contracts.',
    );
  });

  it('Mike: "Together, that means…" after one sentence about something else goes', () => {
    const said =
      'What is reassuring\n\nNo liquidity removal was observed on this pool in its first 11 days. Together, that means no visible holder cluster tied to the creator remains.\n\n' +
      'What deserves attention\n\nThe creator sold this token.';
    expect(withoutClaims(said, report).text).toBe(
      'What is reassuring\n\nNo liquidity removal was observed on this pool in its first 11 days.\n\nWhat deserves attention\n\nThe creator sold this token.',
    );
  });

  it('a sum the sentences before it state, and "the two reads" they name, stay', () => {
    const said =
      'Where the signals diverge\n\nThe holder read covers 3 pages. The transfer read covers every transfer. The two reads use different methods. Together, the reads show the holders only in part.';
    expect(withoutClaims(said, report).text).toBe(said);
  });

  it('a section left with nothing is left out, the others are served', () => {
    const said =
      'What is reassuring\n\nTogether, that means nothing.\n\nWhat deserves attention\n\nThe creator sold this token.';
    expect(withoutClaims(said, report).text).toBe(
      'What deserves attention\n\nThe creator sold this token.',
    );
    expect(SYSTEM_PROMPT).toMatch(/Each section must stand on its own/);
  });
});

// ---------------------------------------------------------------------------
// 4. A failed source is always a failed read

describe('failed sources and failed reads, one test (item 4)', () => {
  it('Wheel Smith: "its sales by its creator could not be read this time" is a failed read', () => {
    const families = {
      creator: {
        completeness: 'partial',
        sources: [
          {
            note: 'creator read from its launchpad 0xf05a… launch record; 1 launch found across the known launchpads',
          },
          { note: UNREAD.ownSales },
        ],
      },
      holders: { sources: [{ note: '3 pages read — remaining holders not covered' }] },
      market: { sources: [{}] },
    };
    const all = [
      ...families.creator.sources,
      ...families.holders.sources,
      ...families.market.sources,
    ];
    expect(sourcesFailed(all)).toBe(true);
    expect(failedReadsOfSources(families)).toEqual([
      { read: 'creator-sales', note: UNREAD.ownSales },
    ]);
    // A failed holders or market source is named too.
    expect(
      failedReadsOfSources({
        creator: { completeness: 'full', sources: [] },
        holders: { sources: [{ note: 'rate-limit : blockscout : 429' }] },
        market: { sources: [{ note: 'timeout : dexscreener : request timed out after 8000 ms' }] },
      }).map((f) => f.read),
    ).toEqual(['holders', 'market']);
  });

  it('the sale confirmed anyway stands, and the notice says the read was partial', () => {
    const report = makeReport(AML, (r) => {
      r.creator.sources.push({
        name: 'robinhood-rpc',
        fetchedAt: r.collectedAt,
        note: UNREAD.ownSales,
      });
      r.failedReads = [
        {
          read: 'creator-sales',
          note: `${UNREAD.ownSales}; a sale by the creator was still confirmed, by a trade in its market`,
        },
      ];
      r.creator.data.tokens = [
        {
          address: AML,
          pool: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
          launchedAtBlock: 1,
          launchedAt: null,
          outcome: 'undetermined',
          graduationProgress: 0,
          creatorDumped: true,
          liquidityPulled: false,
        },
      ];
    });
    const facts = toFacts(report);
    expect(readFailed(facts.failed, 'creator-sales')).toBe(true);
    const glance = buildGlance({ facts })!;
    expect(partialNotice(glance.partial!)).toMatch(/whether the creator sold this token/);
    expect(glance.items.find((i) => i.id === 'sales')?.title).toMatch(/sold into the pool/);
    expect(renderReport(report)).toMatch(/a sale was still confirmed by a trade in its market/);
  });
});

// ---------------------------------------------------------------------------
// 5. AI: 80 launches within the route's time

describe('a long creator history within the route’s time (item 5)', () => {
  const origin: TokenOrigin = {
    token: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
    creator: '0x9b1513dfdfc023fa6e576b130066ec05b6f1bfa1',
    role: 'launcher',
    blockNumber: 80_000_000,
    transactionHash: `0x${'1'.repeat(64)}`,
    venues: { pools: [], v4Markets: [], hooks: [], saleRecipients: [] },
  };
  const others = Array.from({ length: 79 }, (_, i) => ({
    token: `0x${String(i + 1).padStart(40, 'a')}`,
    blockNumber: 70_000_000 + i * 10_000,
    transactionHash: `0x${String(i + 1).padStart(64, 'b')}`,
  }));
  const node = () => {
    const receipts: string[] = [];
    const rpc = {
      async call() {
        return '0x';
      },
      async callBatch(batch: { method: string; params: unknown[] }[]) {
        return batch.map((r) => {
          if (r.method === 'eth_getTransactionReceipt') receipts.push(String(r.params[0]));
          if (r.method === 'eth_getLogs') return { ok: true, value: [] };
          if (r.method === 'eth_getBlockByNumber')
            return { ok: true, value: { timestamp: '0x6a000000' } };
          if (r.method === 'eth_getCode') return { ok: true, value: '0x' };
          if (r.method === 'eth_getTransactionCount') return { ok: true, value: '0x52e' };
          return { ok: true, value: null };
        });
      },
    } as unknown as RpcClient;
    return { rpc, receipts };
  };
  const options = {
    latestBlock: 91_585_881,
    maxListingQueries: 0,
    indexed: { launches: others, covered: new Set<string>() },
    now: () => new Date('2026-10-18T07:00Z'),
  };

  it('a listing in time: the most recent other launches are checked', async () => {
    const { rpc, receipts } = node();
    const history = await fetchDeployerHistory(rpc, origin, {
      ...options,
      checkOthersBy: 10,
      clock: () => 0,
    });
    // The ten most recent launches, this one among them.
    expect(receipts).toHaveLength(9);
    expect(history.sources.map((s) => s.note)).not.toContain(UNREAD.otherChecks);
  });

  it('a listing too late: the others are listed, left unchecked, and the read said partial', async () => {
    const { rpc, receipts } = node();
    const history = await fetchDeployerHistory(rpc, origin, {
      ...options,
      checkOthersBy: 10,
      clock: () => 11,
    });
    expect(receipts).toHaveLength(0);
    expect(history.data.counts.launched).toBe(80);
    expect(history.data.tokens.filter((t) => t.creatorDumped !== null)).toHaveLength(0);
    expect(history.sources.map((s) => s.note)).toContain(UNREAD.otherChecks);
    expect(sourcesFailed(history.sources)).toBe(true);
    expect(
      failedReadsOfSources({
        creator: history,
        holders: { sources: [] },
        market: { sources: [] },
      }),
    ).toEqual([{ read: 'creator-launches', note: UNREAD.otherChecks }]);
    // The launches are all listed: the count is not "at least".
    const report = makeReport(origin.token, (r) => {
      r.creator = history;
      r.failedReads = [{ read: 'creator-launches', note: UNREAD.otherChecks }];
    });
    expect(renderReport(report)).not.toMatch(/at least 80/);
  });

  it('a history past its deadline is a failed read, served, not the route’s 504', async () => {
    // GNRG's launch record, as in the fourth audit's fixture.
    const GNRG = '0x6587e8bdf0f6a55e13c013e158bb66a949bbe250';
    const TOKEN_LAUNCHED = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
    const PONS_FACTORY = '0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe';
    const BLOCK = 0x5700000;
    const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
    const launchLog = {
      address: PONS_FACTORY,
      topics: [
        TOKEN_LAUNCHED,
        pad(GNRG),
        pad('0x2fc2fffed0543c54418f3fc2ea432e3b7edaeb41'),
        pad('0x5361b35dc58b7c906c3c3c6ca77808b4c00664a8'),
      ],
      data:
        '0x0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73' +
        '000000000000000000000000668942551affd4ee3a2e570366aaef28b56c3a97' +
        '0000000000000000000000000000000000000000000000000000000000000000'.repeat(4) +
        '00000000000000000000000000000000000000000000000000005af3107a4000',
      blockNumber: `0x${BLOCK.toString(16)}`,
      transactionHash: '0xabc',
      logIndex: '0x0',
    };
    type Call = { id: number; method: string; params: unknown[] };
    // The launch lookup is answered at once, the creator's history hangs.
    let blockNumbers = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!new URL(url).hostname.endsWith('.robinhood.com')) {
        return url.includes('dexscreener')
          ? new Response('[]', { status: 200 })
          : new Response('{}', { status: 404 });
      }
      const raw = JSON.parse(String(init?.body ?? '{}')) as Call | Call[];
      const calls = Array.isArray(raw) ? raw : [raw];
      // The second block number opens the creator's history: it hangs.
      if (calls.some((c) => c.method === 'eth_blockNumber')) {
        blockNumbers += 1;
        if (blockNumbers === 2) await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      const answer = (c: Call) => {
        let result: unknown = null;
        if (c.method === 'eth_blockNumber') result = '0x5742e28';
        else if (c.method === 'eth_getLogs') {
          const f = c.params[0] as {
            address?: string;
            topics?: string[];
            fromBlock?: string;
            toBlock?: string;
          };
          const holds =
            f.topics?.[0] === TOKEN_LAUNCHED &&
            f.address?.toLowerCase() === PONS_FACTORY &&
            Number(f.fromBlock ?? 0) <= BLOCK &&
            Number(f.toBlock ?? BLOCK) >= BLOCK;
          result = holds ? [launchLog] : [];
        } else if (c.method === 'eth_call') result = '0x';
        return { jsonrpc: '2.0', id: c.id, result };
      };
      return new Response(JSON.stringify(Array.isArray(raw) ? calls.map(answer) : answer(raw)), {
        status: 200,
      });
    });
    const started = Date.now();
    const report = await collect(GNRG, { retryDelaysMs: [0, 0], historyDeadlineMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_900);
    expect(report.creator.completeness).toBe('unavailable');
    expect(report.creator.sources[0]?.note).toMatch(/did not finish in time/);
    expect(report.failedReads?.map((f) => f.read)).toContain('creator');
  }, 10_000);
});
