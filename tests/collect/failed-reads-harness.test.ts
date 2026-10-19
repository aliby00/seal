import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTIONAL_READS, type OptionalRead } from '../../src/lib/reads';
import { keepAnalysis } from '../../src/lib/analysis-cache';
import type { ReadId } from '../../src/lib/contracts';
import { UpstreamError } from '../../src/lib/errors';

/**
 * The failure harness: every read of a collection is made to fail in turn,
 * and each failure must come out in the report's failed reads — the partial
 * notice the reader sees, and what keeps the report out of every cache.
 *
 * ASTEROID on staging, 18/10/2026: the fees its market's hook paid the
 * creator (6.907 % of the supply in 52 transfers from Doppler's 0x4e34…)
 * were read over a window the node cut short; the report went out without
 * them, `facts.failed` empty, and was cached. Asked again, it had them.
 *
 * The chain, the indexer and the market are fakes here: every read answers
 * unless the case at hand makes it fail.
 */

const TOKEN = '0xfd82d8db539b6ace0d50815845133767e24f1e18';
const CREATOR = '0xf53e580690c1bdcab8292eaee58a479e375e372c';
const FACTORY = '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75';
const POOL = '0x1111111111111111111111111111111111111111';
const HOLDER = '0x2222222222222222222222222222222222222222';
const DOPPLER_HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
const V4_POOL = `0x${'ab'.repeat(32)}`;
const SUPPLY = 995557779589434776495248711n;
const LAUNCH_BLOCK = 9_681_917;
const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;

type Fail = Partial<
  Record<
    | 'findLaunchOf'
    | 'fetchCreatorHistory'
    | 'listCreatorLaunches'
    | 'findFirstMintLog'
    | 'fetchDeployerHistory'
    | 'fetchGraduationStatus'
    | 'readLaunchReplay'
    | 'fetchHolderDistribution'
    | 'recheckContracts'
    | 'readPoolsShare'
    | 'linkCreatorToHolders'
    | 'readAddressRoles'
    | 'fetchPairs'
    | 'findMarketsById'
    | 'getLogsBatched'
    | 'eth_getTransactionCount',
    boolean
  >
>;

const state = vi.hoisted(() => ({
  scenario: 'pons' as 'pons' | 'deployer',
  fail: {} as Record<string, boolean>,
  /** The fee read answers, but some windows were not read. */
  feesTruncated: false,
  /** A part of the replay (its receipts) failed. */
  replayPartFailed: false,
  /** The indexer answers, or says it failed, per read. */
  indexerFailed: {} as Record<string, boolean>,
  pairs: true,
}));

const boom = () => new UpstreamError('robinhood-rpc', 'injected failure');

function fakeRpc() {
  return {
    async call(method: string) {
      if (method === 'eth_blockNumber') return '0x5000000';
      if (method === 'eth_call') return `0x${SUPPLY.toString(16)}`;
      return '0x';
    },
    async callBatch(requests: { method: string }[]) {
      if (requests.some((r) => state.fail[r.method])) throw boom();
      return requests.map((r) => ({
        ok: true,
        value: r.method === 'eth_getTransactionCount' ? '0x57d' : '0x',
      }));
    },
  };
}

function ownToken() {
  return {
    address: TOKEN,
    pool: POOL,
    launchedAtBlock: LAUNCH_BLOCK,
    launchedAt: '2026-07-14T00:00:00.000Z',
    outcome: 'undetermined',
    graduationProgress: 0,
    liquidityPulled: false,
    creatorDumped: true,
    salesWindow: {
      fromBlock: LAUNCH_BLOCK,
      toBlock: 0x5000000,
      days: 96,
      wholeLife: true,
    },
    creatorRecipients: 1,
    creatorSends: {
      recipients: [{ address: HOLDER, value: (SUPPLY / 100n).toString() }],
      distinct: 1,
      burned: '0',
    },
  };
}

function history(source: 'pons' | 'deployer') {
  return {
    completeness: 'partial',
    sources: [{ name: 'robinhood-rpc', fetchedAt: '2026-10-18T08:11:00.000Z' }],
    data: {
      creator: CREATOR,
      ...(source === 'deployer'
        ? {
            origin: {
              source: 'deployer',
              role: 'launcher',
              launchesListed: true,
              transactionCount: 1405,
              launchpadsRead: ['Doppler launchpad 0x22e9…'],
              launchpadsNotRead: [],
            },
          }
        : {}),
      tokens: [ownToken()],
      counts: {
        launched: 1,
        graduated: 0,
        abandoned: 0,
        undetermined: 1,
        liquidityPulled: 0,
        creatorDumped: 1,
      },
      scannedRange: { fromBlock: 0, toBlock: 0x5000000 },
    },
  };
}

/** 52 transfers from Doppler's hook to the creator, 6.9066 % of the supply in all (ASTEROID). */
function feeLogs() {
  const each = (SUPPLY * 69066n) / 1_000_000n / 52n;
  return Array.from({ length: 52 }, (_, i) => ({
    address: TOKEN,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      pad(DOPPLER_HOOK),
      pad(CREATOR),
    ],
    data: `0x${each.toString(16).padStart(64, '0')}`,
    blockNumber: `0x${(LAUNCH_BLOCK + 1000 + i).toString(16)}`,
    transactionHash: `0x${i.toString(16).padStart(64, '0')}`,
    logIndex: '0x0',
  }));
}

vi.mock('../../src/lib/chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/chain')>();
  const guard = async <T>(name: string, value: () => T) => {
    if (state.fail[name]) throw boom();
    return value();
  };
  return {
    ...real,
    createRpcClient: () => fakeRpc(),
    findLaunchOf: (..._: unknown[]) =>
      guard('findLaunchOf', () =>
        state.scenario === 'pons'
          ? {
              token: TOKEN,
              deployer: CREATOR,
              dexFactory: FACTORY,
              pairToken: FACTORY,
              pool: POOL,
              positionId: 1n,
              initialBuyAmount: 0n,
              blockNumber: LAUNCH_BLOCK,
              factory: FACTORY,
              transactionHash: '0xabc',
            }
          : undefined,
      ),
    fetchCreatorHistory: () => guard('fetchCreatorHistory', () => history('pons')),
    listCreatorLaunches: () =>
      guard('listCreatorLaunches', () => ({
        launches: [],
        truncated: false,
        read: ['flap.sh'],
        unread: [],
      })),
    findFirstMintLog: () =>
      guard('findFirstMintLog', () => ({
        address: TOKEN,
        topics: [],
        data: '0x',
        blockNumber: `0x${LAUNCH_BLOCK.toString(16)}`,
        transactionHash: '0xabc',
        logIndex: '0x0',
      })),
    traceTokenOrigin: async () => ({
      token: TOKEN,
      creator: CREATOR,
      role: 'launcher',
      blockNumber: LAUNCH_BLOCK,
      transactionHash: '0xabc',
      venues: { pools: [], v4Markets: [V4_POOL], saleRecipients: [], curves: [], hooks: [] },
      creatorFrom: 'launch-record',
    }),
    fetchDeployerHistory: () => guard('fetchDeployerHistory', () => history('deployer')),
    fetchGraduationStatus: () =>
      guard('fetchGraduationStatus', () => ({
        graduated: false,
        pairedEth: 1,
        thresholdEth: 10,
        progress: 0.1,
        pairedPrincipalWei: 1n,
        thresholdWei: 10n,
      })),
    readLaunchReplay: () =>
      guard('readLaunchReplay', () => ({
        completeness: state.replayPartFailed ? 'partial' : 'full',
        sources: [
          { name: 'robinhood-rpc', fetchedAt: '', note: '12 moves in the first 10 minutes' },
          ...(state.replayPartFailed
            ? [
                {
                  name: 'robinhood-rpc',
                  fetchedAt: '',
                  note: 'the receipts that tell trades from liquidity changes, and who sent them, could not be read this time',
                },
              ]
            : []),
        ],
        data: {
          token: TOKEN,
          launchBlock: LAUNCH_BLOCK,
          launchedAt: null,
          windowSeconds: 600,
          supply: SUPPLY.toString(),
          moves: [],
          movesInWindow: 12,
        },
      })),
  };
});

vi.mock('../../src/lib/holders', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/holders')>();
  return {
    ...real,
    fetchHolderDistribution: async () => {
      if (state.fail.fetchHolderDistribution) throw boom();
      return {
        completeness: 'full',
        sources: [{ name: 'blockscout', fetchedAt: '' }],
        data: {
          token: TOKEN,
          countedSupply: SUPPLY.toString(),
          holderCount: 2967,
          top: [{ address: HOLDER, share: 0.04, kind: 'contract', balance: '1' }],
          concentration: { top1: 0.04, top10: 0.2 },
          distinctTraders: null,
        },
      };
    },
  };
});

vi.mock('../../src/lib/holders/chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/holders/chain')>();
  return {
    ...real,
    recheckContracts: async (_rpc: unknown, data: unknown) => {
      if (state.fail.recheckContracts) throw boom();
      return data;
    },
    readPoolsShare: async () => {
      if (state.fail.readPoolsShare) throw boom();
      return { share: 0.2, tokens: 1 };
    },
  };
});

vi.mock('../../src/lib/holders/links', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/holders/links')>();
  return {
    ...real,
    linkCreatorToHolders: async () => {
      if (state.fail.linkCreatorToHolders) throw boom();
      return {
        sentTo: 1,
        burned: 0,
        holders: [{ address: HOLDER, share: 0.01, via: null }],
        distributors: [],
        recipients: [],
        sentShare: 0.01,
      };
    },
  };
});

vi.mock('../../src/lib/chain/roles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/chain/roles')>();
  return {
    ...real,
    readAddressRoles: async () => {
      if (state.fail.readAddressRoles) throw boom();
      return [];
    },
  };
});

vi.mock('../../src/lib/market', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/market')>();
  return {
    ...real,
    fetchPairs: async () => {
      if (state.fail.fetchPairs) throw boom();
      return state.pairs
        ? [
            {
              chainId: 'robinhood',
              dexId: 'uniswap',
              labels: ['v4'],
              pairAddress: V4_POOL,
              baseToken: { address: TOKEN, symbol: 'ASTEROID' },
              quoteToken: { address: '0x0000000000000000000000000000000000000000' },
              priceUsd: '0.0002',
              liquidity: { usd: 200_000 },
              volume: { h24: 10_000 },
              txns: { h24: { buys: 120, sells: 106 } },
            },
          ]
        : [];
    },
  };
});

vi.mock('../../src/lib/chain/pools', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/chain/pools')>();
  return {
    ...real,
    findMarketsById: async () => {
      if (state.fail.findMarketsById) throw boom();
      return {
        markets: [
          {
            id: V4_POOL,
            hook: DOPPLER_HOOK,
            currency0: '0x0000000000000000000000000000000000000000',
            currency1: TOKEN,
            fee: 0,
            tickSpacing: 60,
            blockNumber: LAUNCH_BLOCK,
            transactionHash: '0xabc',
          },
        ],
        unread: false,
      };
    },
  };
});

vi.mock('../../src/lib/chain/logs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/chain/logs')>();
  return {
    ...real,
    getLogsBatched: async () => {
      if (state.fail.getLogsBatched) throw boom();
      return { logs: feeLogs(), truncated: state.feesTruncated };
    },
  };
});

vi.mock('../../src/lib/indexer/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/indexer/client')>();
  const answer = (name: string, value: unknown) =>
    Promise.resolve(
      state.indexerFailed[name] ? { value: undefined, failed: true } : { value, failed: false },
    );
  return {
    ...real,
    indexer: () => ({
      creator: async () => undefined,
      creatorAnswer: () => answer('creator', undefined),
      coverage: async () => undefined,
      coverageAnswer: () => answer('coverage', undefined),
      token: async () => undefined,
      tokenAnswer: () => answer('token', undefined),
      funder: async () => undefined,
      markets: async () => undefined,
      marketsAnswer: () => answer('markets', { token: TOKEN, markets: [] }),
      network: async () => undefined,
    }),
  };
});

const { collect, creatorHistoryCache } = await import('../../src/lib/collect');
const { toFacts } = await import('../../src/lib/facts');

async function run() {
  creatorHistoryCache.clear();
  const report = await collect(TOKEN, {
    blockscoutApiKey: 'test',
    retryDelaysMs: [],
    now: () => new Date('2026-10-18T08:11:00.000Z'),
  });
  return { report, facts: toFacts(report) };
}

type Case = {
  name: string;
  scenario: 'pons' | 'deployer';
  /** The optional read this case covers, when it is one. */
  covers?: OptionalRead;
  setup: () => void;
  expected: ReadId;
};

const failing =
  (...names: (keyof Fail)[]) =>
  () => {
    for (const n of names) state.fail[n] = true;
  };

const CASES: Case[] = [
  // The creator and its history.
  {
    name: 'the launch lookup',
    scenario: 'pons',
    setup: failing('findLaunchOf'),
    expected: 'creator',
  },
  {
    name: 'the creator’s history',
    scenario: 'pons',
    setup: failing('fetchCreatorHistory'),
    expected: 'creator',
  },
  {
    name: 'the creator’s launches on other launchpads',
    scenario: 'pons',
    covers: 'other-launchpads',
    setup: failing('listCreatorLaunches'),
    expected: 'creator-launches',
  },
  {
    name: 'the creator wallet’s transaction count',
    scenario: 'pons',
    covers: 'creator-wallet',
    setup: failing('eth_getTransactionCount'),
    expected: 'creator-wallet',
  },
  {
    name: 'the indexer’s launches of the creator',
    scenario: 'pons',
    setup: () => {
      state.indexerFailed.creator = true;
    },
    expected: 'creator-launches',
  },
  {
    name: 'the first mint (a token traced from its mint)',
    scenario: 'deployer',
    setup: failing('findFirstMintLog'),
    expected: 'creator',
  },
  {
    name: 'the deployer’s history',
    scenario: 'deployer',
    setup: failing('fetchDeployerHistory'),
    expected: 'creator',
  },
  // The fees (ASTEROID).
  {
    name: 'the fees, the read failing',
    scenario: 'pons',
    covers: 'creator-fees',
    setup: failing('getLogsBatched'),
    expected: 'creator-fees',
  },
  {
    name: 'the fees, some windows not read',
    scenario: 'pons',
    covers: 'creator-fees',
    setup: () => {
      state.feesTruncated = true;
    },
    expected: 'creator-fees',
  },
  {
    name: 'the fees of a token traced from its mint, read early and cut short (ASTEROID)',
    scenario: 'deployer',
    covers: 'creator-fees',
    setup: () => {
      state.feesTruncated = true;
    },
    expected: 'creator-fees',
  },
  {
    name: 'the fees of a token traced from its mint, the early read failing',
    scenario: 'deployer',
    covers: 'creator-fees',
    setup: failing('getLogsBatched'),
    expected: 'creator-fees',
  },
  // The markets and their rules.
  {
    name: 'the indexer’s v4 markets (hook lookups)',
    scenario: 'pons',
    covers: 'indexer-markets',
    setup: () => {
      state.indexerFailed.markets = true;
    },
    expected: 'market-rules',
  },
  {
    name: 'the listed pools’ rules (Initialize by id)',
    scenario: 'pons',
    covers: 'pool-rules',
    setup: failing('findMarketsById'),
    expected: 'market-rules',
  },
  {
    name: 'the pools’ balances today',
    scenario: 'pons',
    covers: 'pools-share',
    setup: failing('readPoolsShare'),
    expected: 'liquidity',
  },
  {
    name: 'the listed pairs',
    scenario: 'pons',
    setup: failing('fetchPairs'),
    expected: 'market',
  },
  {
    name: 'the indexer’s trades of the launch pool, with no pair listed',
    scenario: 'pons',
    covers: 'indexer-token',
    setup: () => {
      state.pairs = false;
      state.indexerFailed.token = true;
    },
    expected: 'market',
  },
  {
    name: 'the graduation',
    scenario: 'pons',
    covers: 'graduation',
    setup: failing('fetchGraduationStatus'),
    expected: 'graduation',
  },
  // The holders.
  {
    name: 'the holders list',
    scenario: 'pons',
    setup: failing('fetchHolderDistribution'),
    expected: 'holders',
  },
  {
    name: 'the holders’ codes, re-read',
    scenario: 'pons',
    covers: 'holder-codes',
    setup: failing('recheckContracts'),
    expected: 'holders',
  },
  {
    name: 'the holders’ links to the creator',
    scenario: 'pons',
    covers: 'holder-links',
    setup: failing('linkCreatorToHolders'),
    expected: 'holders',
  },
  {
    name: 'what the largest holders and the launch’s recipients are',
    scenario: 'pons',
    covers: 'address-roles',
    setup: failing('readAddressRoles'),
    expected: 'holders',
  },
  // The launch replay.
  {
    name: 'the launch replay',
    scenario: 'pons',
    covers: 'launch-replay',
    setup: failing('readLaunchReplay'),
    expected: 'launch-replay',
  },
  {
    name: 'a part of the replay (its receipts: the creator’s transaction, the sales)',
    scenario: 'pons',
    setup: () => {
      state.replayPartFailed = true;
    },
    expected: 'launch-replay',
  },
];

beforeEach(() => {
  state.fail = {};
  state.indexerFailed = {};
  state.feesTruncated = false;
  state.replayPartFailed = false;
  state.pairs = true;
  vi.stubEnv('INDEXER_URL', 'https://indexer.test');
  vi.stubEnv('INDEXER_TOKEN', 'test');
});

describe('the failure harness', () => {
  for (const scenario of ['pons', 'deployer'] as const) {
    it(`reads everything with nothing failed (${scenario}): no failed read, the fees found`, async () => {
      state.scenario = scenario;
      const { report, facts } = await run();
      expect(report.failedReads).toBeUndefined();
      expect(facts.failed).toBeUndefined();
      // ASTEROID's fees, as the re-request read them: 6.907 % in 52 transfers from 0x4e34….
      expect(facts.creator.ownFees).toMatchObject({ transfers: 52, hooks: [DOPPLER_HOOK] });
      expect(facts.creator.ownFees?.share).toBeCloseTo(0.069066, 5);
    });
  }

  for (const c of CASES) {
    it(`a failure of ${c.name} is a failed read (${c.expected}), never a silent absence`, async () => {
      state.scenario = c.scenario;
      c.setup();
      const { report, facts } = await run();
      const reads = (facts.failed ?? []).map((f) => f.read);
      expect(reads).toContain(c.expected);
      // A failed read is a partial report: it is cached nowhere.
      expect(
        keepAnalysis(
          {
            token: TOKEN,
            explanation: '',
            completeness: report.completeness,
            sources: [],
            collectedAt: report.collectedAt,
            offline: false,
            facts,
          },
          true,
        ),
      ).toBe(false);
    });
  }

  it('covers every optional read of the collection', () => {
    const covered = new Set(CASES.map((c) => c.covers).filter(Boolean));
    for (const read of Object.keys(OPTIONAL_READS)) expect(covered).toContain(read);
  });

  it('the fees cut short leave no fee figure behind (ASTEROID)', async () => {
    state.scenario = 'deployer';
    state.feesTruncated = true;
    const { facts } = await run();
    expect(facts.creator.ownFees).toBeUndefined();
    expect(facts.failed?.find((f) => f.read === 'creator-fees')?.note).toMatch(
      /could not be read this time/,
    );
  });
});

/**
 * Reads that swallow their failure and answer a value ("nothing found") are
 * how this class of bug comes back. On the collection's path, a `.catch`
 * that answers a value without saying the read failed is not allowed, but
 * for these, each turned into an "unknown" that is itself reported.
 */
describe('no silent catch on the collection’s path', () => {
  const ALLOWED: Record<string, number> = {
    'src/lib/collect.ts': 0,
    'src/lib/holders/links.ts': 0,
    'src/lib/holders/chain.ts': 0,
    // separateLiquidity's own fallback, never used by the replay (it passes its natures).
    'src/lib/chain/launch.ts': 1,
    // Recent activity: an outcome left "cannot be told", never "abandoned".
    'src/lib/chain/index.ts': 1,
    // Removal senders (unread → unknown, and said for this token), the sales
    // windows (truncated → said), the launch times (null), the natures
    // (unread → the sale unknown, and said), the creator's own transactions,
    // their receipts and its v3 positions' ranges (unread → no proof, the
    // senders read as before).
    'src/lib/chain/deployer.ts': 8,
  };
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file}: ${allowed} at most`, () => {
      const source = readFileSync(file, 'utf8');
      const silent = source.match(/\.catch\(\(\)\s*=>\s*[^{\s]/g) ?? [];
      expect(silent.length).toBeLessThanOrEqual(allowed);
    });
  }
});
