import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findClaims, withoutClaims } from '../../src/lib/agent/claims';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { renderReport, SYSTEM_PROMPT } from '../../src/lib/agent/prompt';
import { keepAnalysis, type CachedAnalysis } from '../../src/lib/analysis-cache';
import { creatorSendsOf } from '../../src/lib/chain/behavior';
import { fetchDeployerHistory } from '../../src/lib/chain/deployer';
import { getLogsBatched, type RawLog } from '../../src/lib/chain/logs';
import type { RpcClient } from '../../src/lib/chain/rpc';
import { findRoutedSales } from '../../src/lib/chain/trades';
import {
  collect,
  creatorHistoryCache,
  feesFromHooks,
  retryRateLimited,
} from '../../src/lib/collect';
import {
  mostHoldersFromCreator,
  type HolderDistributionData,
  type LaunchReplayData,
  type TokenReport,
} from '../../src/lib/contracts';
import { RateLimitError } from '../../src/lib/errors';
import { toFacts, type ReportFacts } from '../../src/lib/facts';
import { buildGlance, partialNotice } from '../../src/lib/glance';
import { linkCreatorToHolders } from '../../src/lib/holders/links';
import { createIndexerClient } from '../../src/lib/indexer/client';
import { CATALOG } from '../../src/lib/specialists/catalog';
import type { SpecialistContext } from '../../src/lib/specialists/types';
import { makeReport } from '../specialists/helpers';

/**
 * Regressions from the fourth audit of displayed facts (staging, 18/10/2026).
 * Each fixture uses the addresses, transactions and values read on chain for
 * that token; the rate limits are the public node's own answer, replayed.
 */

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const TOKEN_LAUNCHED = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
/** The pons factory without `getLaunchedToken` that launched GNRG (its symbol reads ponsA24d). */
const PONS_FACTORY = '0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe';
const GNRG_BLOCK = 0x5700000;
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const DOPPLER_HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
const DEAD = '0x000000000000000000000000000000000000dead';
const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

const transfer = (
  token: string,
  from: string,
  to: string,
  data: string,
  tx: string,
  block: string,
  logIndex = '0x0',
): RawLog => ({
  address: token,
  topics: [TRANSFER, pad(from), pad(to)],
  data,
  blockNumber: block,
  transactionHash: tx,
  logIndex,
});

/** The public node's answer when it rate-limits a call: HTTP 200, a JSON-RPC error. */
const RATE_LIMITED = { code: -32005, message: 'request limit reached' };

type RpcCall = { id?: number; method: string; params: unknown[] };
type Answer = { result: unknown } | { error: { code: number; message: string } };

/** A chain node that answers each JSON-RPC call through `answer`, batches included. */
function stubChain(answer: (call: RpcCall) => Answer, other?: (url: string) => Response) {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).hostname.endsWith('.robinhood.com')) {
      const raw = JSON.parse(String(init?.body ?? '{}')) as RpcCall | RpcCall[];
      const out = Array.isArray(raw)
        ? raw.map((r) => ({ jsonrpc: '2.0', id: r.id, ...answer(r) }))
        : { jsonrpc: '2.0', id: raw.id, ...answer(raw) };
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (other) return other(url);
    if (url.includes('dexscreener')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  creatorHistoryCache.clear();
});

// ---------------------------------------------------------------------------
// 1. A degraded run is not a clean finding

// GNRG (0x6587…e250), a pons launch: its creator 0x2fc2…eb41 named by the
// launch event; the analysis of 04:19 UTC lost the creator's history to
// "rate-limit : robinhood-rpc : request limit reached".
const GNRG = '0x6587e8bdf0f6a55e13c013e158bb66a949bbe250';
const GNRG_CREATOR = '0x2fc2fffed0543c54418f3fc2ea432e3b7edaeb41';
const GNRG_LAUNCH_DATA =
  '0x0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73' +
  '000000000000000000000000668942551affd4ee3a2e570366aaef28b56c3a97' +
  '0000000000000000000000000000000000000000000000000000000000000000'.repeat(4) +
  '00000000000000000000000000000000000000000000000000005af3107a4000';
const gnrgLaunchLog = {
  address: PONS_FACTORY,
  topics: [
    TOKEN_LAUNCHED,
    pad(GNRG),
    pad(GNRG_CREATOR),
    pad('0x5361b35dc58b7c906c3c3c6ca77808b4c00664a8'),
  ],
  data: GNRG_LAUNCH_DATA,
  blockNumber: `0x${GNRG_BLOCK.toString(16)}`,
  transactionHash: '0xabc',
  logIndex: '0x0',
};

/**
 * A pons node: the launch lookup answers, the creator's history is what
 * `history` says (rate-limited by default), every other read is empty.
 */
function ponsNode(history: (call: RpcCall, n: number) => Answer | undefined) {
  let blockNumbers = 0;
  let historyCalls = 0;
  return (call: RpcCall): Answer => {
    if (call.method === 'eth_blockNumber') {
      blockNumbers += 1;
      // The first is the launch lookup's; the next one opens the history.
      if (blockNumbers > 1) {
        historyCalls += 1;
        const out = history(call, historyCalls);
        if (out) return out;
      }
      return { result: '0x5742e28' };
    }
    if (call.method === 'eth_getLogs') {
      const filter = call.params[0] as {
        address?: string;
        topics?: (string | null)[];
        fromBlock?: string;
        toBlock?: string;
      };
      // GNRG's one launch record, in the window and on the factory that hold it.
      const holds =
        filter.topics?.[0] === TOKEN_LAUNCHED &&
        filter.address?.toLowerCase() === PONS_FACTORY &&
        Number(filter.fromBlock ?? 0) <= GNRG_BLOCK &&
        Number(filter.toBlock ?? GNRG_BLOCK) >= GNRG_BLOCK;
      return { result: holds ? [gnrgLaunchLog] : [] };
    }
    if (call.method === 'eth_getBlockByNumber') return { result: { timestamp: '0x6a000000' } };
    if (call.method === 'eth_call') return { result: '0x' };
    return { result: null };
  };
}

describe('GNRG: the creator’s history rate-limited (item 1)', () => {
  it('says the creator could not be read, and never that it did not sell', async () => {
    stubChain(ponsNode(() => ({ error: RATE_LIMITED })));
    const report = await collect(GNRG, { retryDelaysMs: [0, 0] });

    expect(report.creator.completeness).toBe('unavailable');
    expect(report.creator.sources[0]?.note).toBe(
      'rate-limit : robinhood-rpc : request limit reached',
    );
    expect(report.failedReads?.map((f) => f.read)).toEqual(
      expect.arrayContaining(['creator', 'launch-replay']),
    );

    const facts = toFacts(report);
    expect(facts.failed?.map((f) => f.read)).toContain('creator');
    const glance = buildGlance({ facts })!;
    const titles = glance.items.map((i) => i.title).join(' ');
    expect(titles).not.toMatch(/did not sell|No other launch/);
    expect(glance.partial).toEqual(
      expect.arrayContaining([
        'who created it and what they did before',
        'the first minutes after its launch',
      ]),
    );
    expect(partialNotice(glance.partial!)).toMatch(/^Partial report: some reads failed/);
    expect(partialNotice(glance.partial!)).toMatch(/Try again/);

    // Never cached, whichever way the body is built.
    const body: CachedAnalysis = {
      token: GNRG,
      explanation: 'x',
      completeness: report.completeness,
      sources: [],
      costUsd: 0,
      collectedAt: report.collectedAt,
      offline: false,
      facts,
    };
    expect(keepAnalysis(body, true)).toBe(false);

    // The model is told what failed and forbidden to state those absences.
    const prompt = renderReport(report);
    expect(prompt).toMatch(/LECTURES EN ÉCHEC CETTE FOIS/);
    expect(prompt).toMatch(/le créateur et son historique : rate-limit/);
    expect(SYSTEM_PROMPT).toMatch(/never state an absence one of them would have settled/);

    // And its text is checked: GNRG's absences are cut.
    const said =
      'What is reassuring\n\nThe creator did not sell into the pool. The pool recorded 6 buys.\n\n' +
      'What deserves attention\n\nNo other launch by this creator was found on the launchpads SEAL can list. Most of the supply sits in the pool.';
    expect(findClaims(said, report)).toHaveLength(2);
    expect(withoutClaims(said, report).text).toBe(
      'What is reassuring\n\nThe pool recorded 6 buys.\n\nWhat deserves attention\n\nMost of the supply sits in the pool.',
    );
    // "could not be read" is the honest wording, and stays.
    expect(
      findClaims(
        'What deserves attention\n\nWhether the creator sold could not be read this time.',
        report,
      ),
    ).toEqual([]);
    // The text served without the model says the report is partial too.
    expect(offlineExplanation(report)).toMatch(/Partial report: some reads failed this time/);
  });

  it('asks the history again after a rate limit, and keeps a read that then answers', async () => {
    // Refused once, then answered: the report is whole.
    stubChain(ponsNode((_, n) => (n === 1 ? { error: RATE_LIMITED } : undefined)));
    const report = await collect(GNRG, { retryDelaysMs: [0, 0] });
    expect(report.creator.completeness).not.toBe('unavailable');
    expect(report.creator.data.creator.toLowerCase()).toBe(GNRG_CREATOR);
    expect(report.failedReads?.map((f) => f.read) ?? []).not.toContain('creator');
  });

  it('retries a rate limit within the time left, and nothing else', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const value = await retryRateLimited(
      async () => {
        calls += 1;
        if (calls < 3) throw new RateLimitError('robinhood-rpc');
        return 'read';
      },
      { delaysMs: [1_500, 3_000], sleep },
    );
    expect(value).toBe('read');
    expect(sleep.mock.calls).toEqual([[1_500], [3_000]]);

    // Another error is not retried.
    calls = 0;
    await expect(
      retryRateLimited(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { delaysMs: [0], sleep },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);

    // Past the deadline, the rate limit is reported rather than waited out.
    let t = 0;
    await expect(
      retryRateLimited(
        async () => {
          t += 20_000;
          throw new RateLimitError('robinhood-rpc');
        },
        { delaysMs: [1_500], sleep, now: () => t, startedAt: 0 },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

// MEME (0x385f…8e18), first run: "no launch record found, and the token's
// first mint was not found": the node had refused the mint search.
describe('MEME: the first mint not read is not a first mint not found (item 1)', () => {
  const MEME = '0x385f4f8ae47651ce5f58f5265395a669f8281e18';

  it('reports the creator as unread, and does not cache it', async () => {
    stubChain((call) => {
      if (call.method === 'eth_blockNumber') return { result: '0x5742e28' };
      if (call.method === 'eth_getLogs') {
        const topics = (call.params[0] as { topics?: string[] }).topics ?? [];
        // No pons launch; the mint search is rate-limited, every window.
        if (topics[0] === TOKEN_LAUNCHED) return { result: [] };
        return { error: RATE_LIMITED };
      }
      if (call.method === 'eth_call') return { result: '0x' };
      return { result: null };
    });
    const report = await collect(MEME, { retryDelaysMs: [0, 0] });
    const note = report.creator.sources[0]?.note ?? '';
    expect(note).not.toMatch(/first mint was not found/);
    expect(note).toMatch(/could not be read/);
    expect(report.failedReads?.map((f) => f.read)).toContain('creator');
    const facts = toFacts(report);
    expect(keepAnalysis({ sources: [], facts } as unknown as CachedAnalysis, true)).toBe(false);
  });
});

// AI (0x2e8c…1e18), first run: launched=1 against 80, because the indexer,
// which lists its Doppler launches, did not answer.
describe('AI: the indexer’s silence leaves the other launches unread (item 1)', () => {
  it('a failed indexer read is told apart from a 404, and not memoised', async () => {
    let status = 500;
    const fetch = vi.fn(async () => new Response('{}', { status }));
    const client = createIndexerClient({
      url: 'http://ix:8795',
      token: 'a-token-long-enough-for-this',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const creator = '0x9b1513dfdfc023fa6e576b130066ec05b6f1bfa1';
    await expect(client.creatorAnswer!(creator)).resolves.toEqual({
      value: undefined,
      failed: true,
    });
    status = 404;
    // Asked again, not served the failure from the memo.
    await expect(client.creatorAnswer!(creator)).resolves.toEqual({
      value: undefined,
      failed: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('marks the launches unread, says so in the glance, and keeps it out of the cache', async () => {
    vi.stubEnv('INDEXER_URL', 'http://indexer.seal.test');
    vi.stubEnv('INDEXER_TOKEN', 'a-token-long-enough-for-this-test');
    stubChain(
      ponsNode(() => undefined),
      (url) =>
        url.includes('indexer.seal.test')
          ? new Response('upstream', { status: 503 })
          : new Response('[]', { status: 200 }),
    );
    const report = await collect(GNRG, { retryDelaysMs: [0, 0] });
    expect(report.creator.completeness).not.toBe('unavailable');
    expect(report.failedReads?.map((f) => f.read)).toContain('creator-launches');
    // The five-minute history cache does not keep it either.
    expect(creatorHistoryCache.size).toBe(0);

    const facts = toFacts(report);
    const glance = buildGlance({ facts })!;
    const record = glance.items.find((i) => i.id === 'record');
    expect(record?.title).toBe(
      'Whether this creator launched other tokens could not be read this time.',
    );
    expect(record?.figure).toBe('?');
    expect(glance.partial).toContain('the creator’s other launches');

    const answer = CATALOG['creator-history'].run({
      token: GNRG,
      report,
    } as SpecialistContext);
    expect(answer.signal).toBe('unknown');
    expect(answer.facts.join(' ')).not.toMatch(/No other launch/);
  });

  it('the facts of the served AI report: the record line becomes "could not be read"', () => {
    // The creator block of AI's first run, as served at 04:10 UTC.
    const facts: ReportFacts = {
      failed: [{ read: 'creator-launches', note: 'the SEAL indexer did not answer' }],
      creator: {
        measured: true,
        address: '0x9b1513dfdfc023fa6e576b130066ec05b6f1bfa1',
        launched: 1,
        detailed: 1,
        graduated: 0,
        abandoned: 0,
        undetermined: 1,
        active: 0,
        checked: 0,
        soldIntoPool: 0,
        liquidityPulled: 0,
        salesChecked: 0,
        liquidityChecked: 0,
        source: 'deployer',
        role: 'launcher',
        launchContract: '0x22e99278308b393ea1260859b181ad7e78f5eeed',
        launchesListed: false,
        transactionCount: 1326,
        launchpad: 'Doppler launchpad 0x22e9…',
        creatorFrom: 'launch-record',
        notListed: ['pons', 'flap.sh', 'Doppler', 'contracts deployed directly'],
        graduation: 'not-measured',
      },
      holders: {
        measured: true,
        holderCount: 58484,
        pooled: 0.065,
        top1: 0.033,
        top10: 0.177,
        top: [{ address: '0x1', share: 0.033, kind: 'wallet' }],
      },
      market: {
        measured: true,
        priceUsd: 0.01,
        liquidityUsd: 3_000_000,
        volume24hUsd: 208_300,
        buys24h: 87,
        sells24h: 249,
        fdvUsd: null,
        graduation: null,
      },
    };
    const glance = buildGlance({ facts })!;
    expect(glance.headline).not.toMatch(/No other launch/);
    expect(glance.items.map((i) => i.title).join(' ')).not.toMatch(/No other launch/);
    expect(glance.partial).toEqual(['the creator’s other launches']);
  });
});

// ---------------------------------------------------------------------------
// 2. KEL: the router of the creator's sale is not a recipient

const KEL = '0xf703a6ef83465fbe73d0d31bb274e8dc3f3a1e18';
const KEL_CREATOR = '0xc43b39276bf35f7a78837ff4153b768bdaea5cf4';
const KEL_ROUTER = '0xbdbae060cbab0e9cfe802a7513dd5ecb36cda6c3';
const KEL_HOP = '0x8f10b468b06c6fd214b65f87778827f7d113f996';
const KEL_MARKET = '0x37a01de74ba161e9bc1f2af5bb545adbfb62e500d0c7b147da138d5220655c39';
const KEL_SALE_TX = '0xf808e8e2af2dff9d9a5e4f20de6f4701c673dc8e294aa3db8cc3cc67a5646c48';
const KEL_SOLD = '0x00000000000000000000000000000000000000000000fa124252162a01adb598';
const KEL_BLOCK = '0x56db56d';

describe('KEL: the router of a sale is not an address the creator sent to (item 2)', () => {
  // Read on chain: creator → router → 0x8f10… → PoolManager, which swapped.
  const saleReceipt = {
    from: KEL_CREATOR,
    contractAddress: null,
    logs: [
      transfer(KEL, KEL_CREATOR, KEL_ROUTER, KEL_SOLD, KEL_SALE_TX, KEL_BLOCK, '0x3'),
      transfer(KEL, KEL_ROUTER, KEL_HOP, KEL_SOLD, KEL_SALE_TX, KEL_BLOCK, '0x5'),
      transfer(KEL, KEL_HOP, POOL_MANAGER, KEL_SOLD, KEL_SALE_TX, KEL_BLOCK, '0x6'),
      {
        address: POOL_MANAGER,
        topics: [V4_SWAP, KEL_MARKET, pad(KEL_HOP)],
        data: '0x' + '0'.repeat(64),
        blockNumber: KEL_BLOCK,
        transactionHash: KEL_SALE_TX,
        logIndex: '0x7',
      },
    ],
  };
  const rpc = {
    async call() {
      throw new Error('not used');
    },
    async callBatch(batch: { method: string; params: unknown[] }[]) {
      return batch.map((r) => {
        const p = r.params[0] as { address?: string; topics?: string[] };
        let value: unknown = null;
        if (r.method === 'eth_getLogs') {
          value =
            p.address === KEL && p.topics?.[1] === pad(KEL_CREATOR) ? [saleReceipt.logs[0]] : [];
        } else if (r.method === 'eth_getCode') value = '0x';
        else if (r.method === 'eth_getTransactionCount') value = '0x7';
        else if (r.method === 'eth_getBlockByNumber') value = { timestamp: '0x6a000000' };
        else if (r.method === 'eth_getTransactionReceipt')
          value = r.params[0] === KEL_SALE_TX ? saleReceipt : null;
        else if (r.method === 'eth_getTransactionByHash') value = { from: KEL_CREATOR };
        return { ok: true, value };
      });
    },
  } as unknown as RpcClient;

  it('the sale is found, and the router is not counted as a recipient', async () => {
    const out = { through: new Set<string>(), unread: new Set<string>() };
    const sold = await findRoutedSales(
      rpc,
      KEL_CREATOR,
      [{ token: KEL, to: KEL_ROUTER, hash: KEL_SALE_TX }],
      () => new Set([POOL_MANAGER]),
      undefined,
      KEL,
      out,
    );
    expect([...sold]).toEqual([KEL]);
    expect([...out.through]).toEqual([KEL_SALE_TX]);

    const history = await fetchDeployerHistory(
      rpc,
      {
        token: KEL,
        creator: KEL_CREATOR,
        role: 'launcher',
        launchContract: '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862',
        blockNumber: 0x56d0000,
        transactionHash: '0x01',
        venues: {
          pools: [],
          v4Markets: [KEL_MARKET],
          hooks: [DOPPLER_HOOK],
          saleRecipients: [POOL_MANAGER],
        },
      },
      { latestBlock: 0x5700000, maxListingQueries: 0, now: () => new Date('2026-10-18T00:00Z') },
    );
    const own = history.data.tokens.find((t) => t.address === KEL);
    expect(own?.creatorDumped).toBe(true);
    expect(own?.creatorRecipients).toBe(0);
    expect(own?.creatorSends?.distinct).toBe(0);
  });

  it('two holders are not "most of the holders received it from the creator"', () => {
    // The facts as served: 2 holders, 1 recipient (the router).
    expect(mostHoldersFromCreator(1, 2)).toBe(false);
    expect(mostHoldersFromCreator(10_100, 10_030)).toBe(true);
    expect(mostHoldersFromCreator(25, 50)).toBe(false);
    const report = makeReport(KEL, (r) => {
      r.holders.data.holderCount = 2;
      r.holders.data.top = [
        { address: '0xa7f6bc4d8429ea499726972ff2feed7bd12eb991', share: 0.999999, kind: 'wallet' },
      ] as HolderDistributionData['top'];
      r.creator.data.creator = KEL_CREATOR;
      r.creator.data.tokens = [
        {
          address: KEL,
          pool: POOL_MANAGER,
          launchedAtBlock: 1,
          launchedAt: null,
          outcome: 'undetermined',
          graduationProgress: 0,
          liquidityPulled: false,
          creatorDumped: true,
          creatorRecipients: 1,
        },
      ];
    });
    const f = CATALOG['holder-spread'].run({ token: KEL, report } as SpecialistContext);
    const text = f.facts.join(' ');
    expect(text).not.toMatch(/most of the holders/);
    expect(text).toMatch(/directly to 1 address[.,: ]/);
    expect(text).not.toMatch(/1 addresses/);
    expect(renderReport(report)).not.toMatch(/la plupart l’ont reçu du créateur/);
  });
});

// ---------------------------------------------------------------------------
// 3. WAFER: every recipient of the creator is listed

const WAFER = '0x9182f4791dd6ac83323a935760c5cfe2ad25361b';
const WAFER_CREATOR = '0x53170e88ff105607a04d6d65af861136dcab708c';
const WAFER_WALLET = '0x07207d05bce42d7ee2a096f386b605e9ce223b15';

describe('WAFER: the creator’s send to a wallet is said beside its burns (item 3)', () => {
  // The creator's transfers of WAFER, read on chain: twelve burns, and
  // 0.11 % to the wallet 0x0720…3b15 (tx 0xbe4c4f41…), still held.
  const burns: [string, string, string][] = [
    [
      '0xa482b63849a3ef4810ad610551001618d080bcc837b1de90407055cfe666300f',
      '0x566637e',
      '12ac34f633f367aaeb53b4',
    ],
    [
      '0xfeb2d950fccd788bb49c7a8e81059587bb9faef642ce5c89247199352763dff9',
      '0x566b692',
      '89b8cdd58a366aeea747',
    ],
    [
      '0x7df511e46d2c2ba3eb0034591e14d085c29643dffe8caa749cdcb383aae49099',
      '0x566cdbe',
      '765af4e6e6c573b652e3',
    ],
    [
      '0x8f15daedb8e6bfc2c8368097b51e7ef763ac6e8b3e735e871840f036293a56c6',
      '0x566de4c',
      '4258c2d588011100a3bd',
    ],
    [
      '0xf7132aa5afc43e83b306809abef49e91ea12573f56d516f59dc2762040aa9ec9',
      '0x566f50d',
      '637333d6ebd8fc6a21a3',
    ],
    [
      '0xfdd190d042d2e0fdb25cbafa33f1cd6be3ae6d82f1b03cc889cda62a921b71bc',
      '0x56719d4',
      '5ca5faec6f124bf62b1b',
    ],
    [
      '0xdbb222feede1aabe14819a4cad702c7771c58ba2708e48d77aeecaf203317639',
      '0x5674fe7',
      '3eb89a99135156ca90d1',
    ],
    [
      '0x5ce08d3908fd8747472e6e235757a332d101e072bdc217a36900aa30a039faf4',
      '0x5684aab',
      '7b90bd7d0f46ae18e3f7',
    ],
    [
      '0x5932af2aa6f76ad9c627cfbb4faee2754cb77840758fe41deedada45df380e5f',
      '0x56896e4',
      '8827602c979f1be26ab7',
    ],
    [
      '0x98557ab1edcbe383871651ef2ff2d04bcd01827a6ec67cb4c9ed9e29bb84f1b7',
      '0x56a821e',
      '4f6a6403345e05f141aa',
    ],
    [
      '0x2331dbd79fa14c601459b7447076f070ffff2ed5ab7e16b2903ae30c41d6fcd4',
      '0x56dae49',
      '8394e02bc45cb5cec01b',
    ],
    [
      '0x171e5971865683df8c367dfd9e6d0eae0eea0ad2104addd4f879aaa31381feb8',
      '0x5728094',
      '66a964ee444fb134b864',
    ],
  ];
  const word = (hex: string) => `0x${hex.padStart(64, '0')}`;
  const logs: RawLog[] = [
    ...burns.map(([tx, block, value]) =>
      transfer(WAFER, WAFER_CREATOR, DEAD, word(value), tx, block),
    ),
    transfer(
      WAFER,
      WAFER_CREATOR,
      WAFER_WALLET,
      word('eac7c69b9da634474529'),
      '0xbe4c4f41119f1e21a322946f27877a4fc00c6fb2666c0eaf3f7c05b83a4b96b0',
      '0x56dd698',
    ),
  ];
  const holders: HolderDistributionData = {
    token: WAFER,
    countedSupply: '1',
    holderCount: 384,
    top: [
      { address: '0x4dbc64257b8acf203b9deff46fd82f628f185444', share: 0.064534, kind: 'wallet' },
      { address: '0xebfaad57777089b71624bb10d766d0d9d24a152b', share: 0.044623, kind: 'wallet' },
      { address: '0x58f59b4d62696778d9a093001923d1905b2b7e10', share: 0.039424, kind: 'wallet' },
    ] as HolderDistributionData['top'],
    concentration: { top1: 0.064534, top10: 0.332756 },
    distinctTraders: null,
  };

  it('lists the wallet, its share and the total sent, so "only a burn" cannot be said', async () => {
    const sends = creatorSendsOf(logs, WAFER, WAFER_CREATOR, new Set([POOL_MANAGER]));
    expect(sends.distinct).toBe(1);
    const links = await linkCreatorToHolders({} as RpcClient, {
      token: WAFER,
      sends,
      holders,
      supply: 10n ** 27n,
      setAside: new Set(),
      fromBlock: 0,
      toBlock: 1,
    });
    expect(links.burned).toBeCloseTo(0.028007, 6);
    expect(links.recipients).toEqual([{ address: WAFER_WALLET, share: 0.001108, listed: false }]);
    expect(links.sentShare).toBeCloseTo(0.001108, 6);

    const report = makeReport(WAFER, (r) => {
      r.creator.data.creator = WAFER_CREATOR;
      r.creator.data.tokens = [
        {
          address: WAFER,
          pool: POOL_MANAGER,
          launchedAtBlock: 1,
          launchedAt: null,
          outcome: 'undetermined',
          graduationProgress: 0,
          liquidityPulled: null,
          creatorDumped: false,
          creatorRecipients: 1,
          creatorSends: sends,
        },
      ];
      r.holders.data = { ...holders, creatorLinks: links };
    });
    const f = CATALOG['holder-spread'].run({ token: WAFER, report } as SpecialistContext);
    expect(f.facts.join(' ')).toMatch(
      `the creator sent this token directly to 1 address, 0.1% of the supply in all: ${WAFER_WALLET} (0.1%)`,
    );
    const prompt = renderReport(report);
    expect(prompt).toMatch(
      `TOUS les destinataires du créateur hors marchés et burn : ${WAFER_WALLET} (0.11 %)`,
    );
    expect(prompt).toMatch(/1 adresse a reçu du créateur/);

    // WAFER's served sentence is cut.
    const said =
      'What is reassuring\n\nNone of the largest holders received tokens from the creator; the only creator transfer outside markets went to a burn address. The hook has no upgrade slot.';
    expect(findClaims(said, report).map((c) => c.kind)).toEqual(['count']);
  });
});

// ---------------------------------------------------------------------------
// 4. MEME: the fees paid out by Doppler's hook, summed

const MEME = '0x385f4f8ae47651ce5f58f5265395a669f8281e18';
const MEME_CREATOR = '0xa72a5b06927badb020d235f5f43ce56507ab2399';
const MEME_LAUNCH_BLOCK = 0x3335a94;

describe('MEME: every transfer from the hook to the creator is a fee taken (item 4)', () => {
  // The 28 transfers of MEME from Doppler's hook 0x4e34… to its creator,
  // read on chain over the token's life (0xb3a283eb… the first).
  const logs = JSON.parse(
    readFileSync(new URL('../chain/fixtures/meme-hook-fees.json', import.meta.url), 'utf8'),
  ) as RawLog[];

  it('sums them: 0.52 % over 28 transfers', () => {
    const fees = feesFromHooks(logs, [DOPPLER_HOOK], MEME_LAUNCH_BLOCK, 10n ** 27n);
    expect(fees.transfers).toBe(28);
    expect(fees.share).toBeCloseTo(0.005213, 6);
    expect(fees.hooks).toEqual([DOPPLER_HOOK]);
    // A transfer from anyone else, or in the launch block, is not a fee.
    expect(
      feesFromHooks(logs, ['0x6f02324d20cc679d0e585290caa6b16bacbc0f77'], 0, 1n).transfers,
    ).toBe(0);
    expect(feesFromHooks(logs, [DOPPLER_HOOK], 0x6000000, 10n ** 27n).transfers).toBe(0);
  });

  it('says it in the liquidity question, the glance and the prompt', () => {
    const fees = feesFromHooks(logs, [DOPPLER_HOOK], MEME_LAUNCH_BLOCK, 10n ** 27n);
    const report = makeReport(MEME, (r) => {
      r.creator.data.creator = MEME_CREATOR;
      r.creator.data.tokens = [
        {
          address: MEME,
          pool: POOL_MANAGER,
          launchedAtBlock: MEME_LAUNCH_BLOCK,
          launchedAt: null,
          outcome: 'undetermined',
          graduationProgress: 0,
          liquidityPulled: null,
          creatorDumped: true,
          feesCollected: true,
          feesTaken: fees,
        },
      ];
    });
    const answer = CATALOG['liquidity-move'].run({ token: MEME, report } as SpecialistContext);
    expect(answer.signal).toBe('observation');
    expect(answer.facts[0]).toBe(
      `The creator received 0.5% of the supply from the market’s trading rules (hook) ${DOPPLER_HOOK}, in 28 transfers: trading fees taken out of the market without removing its liquidity.`,
    );
    const facts = toFacts(report);
    expect(facts.creator.ownFees).toEqual({ share: fees.share, transfers: 28 });
    expect(facts.creator.feesCollected).toBe(1);
    const glance = buildGlance({ facts })!;
    expect(glance.items.find((i) => i.id === 'liquidity')?.title).toBe(
      'The creator received 0.5% of the supply from the market’s trading rules (hook), in 28 transfers: trading fees taken out of the market.',
    );
    expect(renderReport(report)).toMatch(/ont versé au créateur 0.52 % de l’offre en 28 transfert/);
  });
});

// ---------------------------------------------------------------------------
// 5. What the text may say: no hook, counts, bought or held

describe('the wording checks of the fourth audit (item 5)', () => {
  it('MEME: no hook is not "nothing can be rewritten later"', () => {
    const report = makeReport(MEME);
    const said =
      'What is reassuring\n\nThe token’s Uniswap v4 pool has no trading rules (hook), so nothing sits between a seller and the pool and nothing can be rewritten later. Sells are happening.';
    expect(findClaims(said, report).map((c) => c.kind)).toEqual(['immutable']);
    expect(SYSTEM_PROMPT).toMatch(/only means there is no hook to rewrite/);
    const answer = CATALOG['rule-change'].run({
      token: MEME,
      report,
      market: { hook: '0x0000000000000000000000000000000000000000' },
    } as unknown as SpecialistContext);
    expect(answer.facts).toEqual([
      'This market has no trading rules (hook), so there is no hook to rewrite.',
    ]);
    expect(answer.limits[0]).toMatch(/token’s own contract can be changed is not checked/);
  });

  const summary = (early: Partial<NonNullable<LaunchReplayData['summary']>['early']>) =>
    ({
      moves: 4,
      earlySeconds: 60,
      creatorAtLaunch: 0,
      creatorBought: 0,
      creatorSold: 0,
      creatorFirstBuyAt: null,
      creatorLastSaleAt: null,
      creatorSaleConfirmed: false,
      creatorTx: null,
      early: { wallets: 0, share: 0, within: 0, heldNow: 0, unread: 0, contracts: 0, ...early },
      bundle: null,
      receiptsRead: 0,
      receiptsWanted: 0,
      balancesRead: 0,
      balancesWanted: 0,
    }) as NonNullable<LaunchReplayData['summary']>;
  const withLaunch = (token: string, s: NonNullable<LaunchReplayData['summary']>) =>
    makeReport(token, (r) => {
      r.launch = {
        completeness: 'full',
        sources: [],
        data: {
          token,
          launchBlock: 1,
          launchedAt: null,
          windowSeconds: 600,
          supply: '1',
          moves: [],
          movesInWindow: 0,
          summary: s,
        } as unknown as LaunchReplayData,
      };
    });

  it('ECOGPT: three early buyers are not "the two early buyers"', () => {
    // ECOGPT: 3 addresses (1 a contract) bought 3.48 % within 38 s.
    const report = withLaunch(
      '0x003b1a443ac7696728da395d5c607bab917a7777',
      summary({ wallets: 3, share: 0.034848, within: 38, contracts: 1 }),
    );
    const said =
      'Where the signals diverge\n\nThe market shows 11 trades. The two early buyers in the first minute no longer hold anything.';
    expect(findClaims(said, report).map((c) => c.kind)).toEqual(['count']);
    expect(findClaims('Where\n\nThe 3 early buyers no longer hold anything.', report)).toEqual([]);
    expect(renderReport(report)).toMatch(/EXACTEMENT 3 adresses \(dont 1 contrat\)/);
  });

  it('MUT8: 97 % bought by early buyers is not 97 % they held', () => {
    // MUT8: 189 addresses bought 97.16 % within 60 s; they hold 64.59 % today.
    const report = withLaunch(
      '0x48d343cae84ab737c46ce63cb74c926609eb03bb',
      summary({
        wallets: 189,
        share: 0.971589,
        within: 59.7,
        heldNow: 0.645948,
        unread: 92,
        contracts: null,
      }),
    );
    const said =
      'Where the signals diverge\n\nThe trading looks lively. Yet the apparent breadth of 189 early buyers holding 97% at launch is misleading.';
    expect(findClaims(said, report).map((c) => c.kind)).toEqual(['count']);
    expect(
      findClaims(
        'Where\n\n189 early buyers bought 97% of the supply and hold 64.6% today.',
        report,
      ),
    ).toEqual([]);
    expect(renderReport(report)).toMatch(/ont ACHETÉ au total 97.16 % de l’offre/);
  });

  it('BOOMER: six linked top holders are not "five of the top holders"', () => {
    const VIA = '0xa7e40b342146af9d9db4a559a9dfc99756027082';
    const top = [
      ['0x06e52db5d5922c07891bf3a1db751563580b1988', 0.010662],
      ['0x11bd5979b8583bee134f6b9eee3dd426a5a1f7b3', 0.01583],
      ['0x5eae646bba71a2417b359092ded75ed3a237e27e', 0.005689],
      ['0xa86b760000000000000000000000000000000001', null],
      ['0x2f595a0000000000000000000000000000000002', null],
      ['0xd1c77a04b87393e98a1220532e72e8f7d0a31c5a', 0.011176],
      ['0x0aa1306df82e38911cd5b5520629912ad036e704', 0.010745],
      ['0x3200a9f8c14ebc24b9ed7e047ccd3cda0c068de0', 0.01093],
    ] as const;
    const report = makeReport('0x127cdc74e44e3c60422b7e792ebe480c0f873ed5', (r) => {
      r.holders.data.top = top.map(([address, share]) => ({
        address,
        share: 0.02,
        kind: 'wallet',
        ...(share !== null ? { fromCreator: { share, via: VIA } } : {}),
      })) as HolderDistributionData['top'];
      r.holders.data.creatorLinks = {
        sentTo: 2,
        burned: 0,
        holders: top
          .filter(([, share]) => share !== null)
          .map(([address, share]) => ({ address, share: share as number, via: VIA })),
        distributors: [{ address: VIA, share: 0.652, recipients: 1281, complete: true }],
      };
    });
    const said =
      'What deserves attention\n\nThe creator sent roughly 65% to one contract. Five of the top holders received tokens through the first contract.';
    expect(findClaims(said, report).map((c) => c.kind)).toEqual(['count']);
    // The glance's own wording: the largest, and 5 other.
    expect(
      findClaims(
        'What\n\nThe largest holder and 5 other of the largest holders received tokens from the creator.',
        report,
      ),
    ).toEqual([]);
    expect(renderReport(report)).toMatch(/EXACTEMENT 6 des 8 plus gros détenteurs affichés/);
  });

  it('GNRG: the creator’s trades in the pool are said with their direction', () => {
    const report = makeReport(GNRG, (r) => {
      r.market.data.volumeUsd = null;
      r.market.data.activity = {
        source: 'indexer',
        pool: '0x5361b35dc58b7c906c3c3c6ca77808b4c00664a8',
        pairToken: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
        coveredFrom: '2026-10-11T17:57:33.000Z',
        indexedTo: 1,
        h1: { buys: 0, sells: 0, traders: 0, volume: '0', lastTradeAt: null },
        h24: { buys: 0, sells: 0, traders: 0, volume: '0', lastTradeAt: null },
        d7: { buys: 6, sells: 0, traders: 4, volume: '0', lastTradeAt: null },
        sinceLaunch: {
          buys: 6,
          sells: 0,
          traders: 4,
          volume: '0',
          lastTradeAt: null,
          complete: true,
        },
        creatorTraded: true,
        creatorTrades: { buys: 1, sells: 0 },
      };
    });
    const prompt = renderReport(report);
    expect(prompt).toMatch(/Swaps du créateur dans ce pool : 1 achat\(s\), 0 vente\(s\)/);
    // An older report without the direction: the model is told not to mention it.
    delete report.market.data.activity!.creatorTrades;
    expect(renderReport(report)).toMatch(
      /le sens de ses échanges n’est pas donné ici : ne le mentionne pas/,
    );
  });
});

// The served reports of the audit that fed these fixtures.
describe('a whole report keeps its count of failed reads (item 1)', () => {
  it('a report without failures is kept, one with a failure is not', () => {
    const base = makeReport(GNRG);
    const kept = toFacts(base);
    expect(kept.failed).toBeUndefined();
    const body = { sources: [], offline: false, facts: kept } as unknown as CachedAnalysis;
    expect(keepAnalysis(body, true)).toBe(true);
    const partial = toFacts({
      ...base,
      failedReads: [
        { read: 'launch-replay', note: 'rate-limit : robinhood-rpc : request limit reached' },
      ],
    } as TokenReport);
    expect(keepAnalysis({ ...body, facts: partial }, true)).toBe(false);
  });
});

describe('a log read cut short by its size is a limit, by a rate limit a failure (item 1)', () => {
  const node = (error: string) =>
    ({
      async call() {
        throw new Error('not used');
      },
      async callBatch(batch: unknown[]) {
        return batch.map(() => ({ ok: false, error }));
      },
    }) as unknown as RpcClient;

  it('tells them apart', async () => {
    const filter = { addresses: [DOPPLER_HOOK], topics: [TRANSFER] };
    const range = { fromBlock: 0, toBlock: 10 };
    const big = await getLogsBatched(node('query exceeds limit of 10000 results'), filter, range, {
      split: false,
    });
    expect(big).toMatchObject({ truncated: true, tooBroad: true });
    const limited = await getLogsBatched(node('request limit reached'), filter, range, {
      split: false,
    });
    expect(limited.truncated).toBe(true);
    expect(limited.tooBroad).toBeUndefined();
  });
});
