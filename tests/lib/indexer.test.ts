import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketState } from '../../src/lib/contracts';
import { toFacts } from '../../src/lib/facts';
import {
  createIndexerClient,
  indexer,
  indexerConfigured,
  type IndexerCreator,
  type IndexerToken,
} from '../../src/lib/indexer/client';
import {
  fundingFacts,
  indexedListing,
  withIndexedLaunches,
  withPoolActivity,
} from '../../src/lib/indexer/merge';
import { CATALOG } from '../../src/lib/specialists/catalog';
import { makeReport } from '../specialists/helpers';

const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';
const CREATOR = '0xe06289fde414ee521aba50db0cf0a60816faa523';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const at = '2026-10-17T10:00:00.000Z';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const win = (buys: number, sells: number, traders: number, volume: string) => ({
  buys,
  sells,
  uniqueTraders: traders,
  volume,
  lastTradeAt: '2026-10-17T09:58:00.000Z',
});

function tokenAnswer(over: Partial<IndexerToken> = {}): IndexerToken {
  return {
    token: TOKEN,
    indexedTo: 90_830_000,
    launch: {
      token: TOKEN,
      creator: CREATOR,
      pool: '0x00000000000000000000000000000000000000c1',
      pairToken: WETH,
      block: 90_000_000,
      timestamp: '2026-10-16T10:00:00.000Z',
    },
    coveredFrom: 89_000_000,
    coveredFromAt: '2026-10-15T00:00:00.000Z',
    sinceLaunchComplete: true,
    stats: {
      h1: win(3, 1, 4, '100000000000000000'),
      h24: win(30, 12, 25, '2500000000000000000'),
      d7: win(30, 12, 25, '2500000000000000000'),
      sinceLaunch: win(30, 12, 25, '2500000000000000000'),
    },
    topTraders7d: [],
    creatorTraded: { traded: false, buys: 0, sells: 0 },
    ...over,
  };
}

function creatorAnswer(over: Partial<IndexerCreator> = {}): IndexerCreator {
  return {
    creator: CREATOR,
    indexedTo: 90_830_000,
    launchCount: 3,
    truncated: false,
    launches: [
      {
        token: TOKEN,
        pool: '0xp1',
        factory: '0xf',
        pairToken: WETH,
        block: 86_000_000,
        timestamp: null,
      },
      {
        token: '0x01',
        pool: '0xp2',
        factory: '0xf',
        pairToken: WETH,
        block: 20_000_000,
        timestamp: '2026-08-01T00:00:00.000Z',
      },
      {
        token: '0x02',
        pool: '0xp3',
        factory: '0xf',
        pairToken: WETH,
        block: 10_000_000,
        timestamp: null,
      },
    ],
    fundingState: 'pending',
    ...over,
  };
}

describe('indexer client', () => {
  it('is absent, and answers nothing, without INDEXER_URL and INDEXER_TOKEN', async () => {
    vi.stubEnv('INDEXER_URL', '');
    vi.stubEnv('INDEXER_TOKEN', '');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(indexerConfigured()).toBe(false);
    expect(indexer()).toBeUndefined();
    await expect(createIndexerClient().token(TOKEN)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the bearer token and returns the typed answer', async () => {
    const fetch = vi.fn(async () => Response.json(tokenAnswer()));
    const client = createIndexerClient({
      url: 'http://ix:8795/',
      token: 'a-token-long-enough-for-this',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const answer = await client.token(TOKEN.toUpperCase().replace('0X', '0x'));
    expect(answer?.stats.h24.buys).toBe(30);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://ix:8795/v1/token/${TOKEN}`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer a-token-long-enough-for-this',
    );
  });

  it('never throws: 404, errors, garbage and timeouts all read as "no answer"', async () => {
    for (const reply of [
      async () => new Response('{}', { status: 404 }),
      async () => new Response('nope', { status: 500 }),
      async () => new Response('not json'),
      async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    ]) {
      const client = createIndexerClient({
        url: 'http://ix',
        token: 't'.repeat(30),
        fetch: reply as unknown as typeof fetch,
      });
      await expect(client.creator(CREATOR)).resolves.toBeUndefined();
    }
  });

  it('gives up after its timeout instead of holding the analysis', async () => {
    const client = createIndexerClient({
      url: 'http://ix',
      token: 't'.repeat(30),
      timeoutMs: 20,
      fetch: ((_: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as unknown as typeof fetch,
    });
    const started = Date.now();
    await expect(client.token(TOKEN)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('asks for one creator once within a short window', async () => {
    const fetch = vi.fn(async () => Response.json(creatorAnswer()));
    const client = createIndexerClient({
      url: 'http://ix',
      token: 't'.repeat(30),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await client.creator(CREATOR);
    await client.creator(CREATOR);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('funding from the indexer', () => {
  it('maps each funding state to what the funding question reads', () => {
    expect(fundingFacts(undefined)).toBeUndefined();
    expect(fundingFacts(creatorAnswer({ fundingState: 'disabled' }))).toBeUndefined();
    expect(fundingFacts(creatorAnswer({ fundingState: 'pending' }))).toBeUndefined();
    expect(fundingFacts(creatorAnswer({ fundingState: 'none', funding: null }))).toBeNull();
    expect(
      fundingFacts(
        creatorAnswer({
          fundingState: 'found',
          funding: {
            funder: '0xf0',
            txHash: '0x1',
            block: 3,
            kind: 'tx',
            otherCreatorsFunded: ['0xa', '0xb'],
          },
        }),
      ),
    ).toEqual({ funder: '0xf0', funderKind: 'unknown', txHash: '0x1', otherCreatorsFunded: 0 });
    // A profiled wallet groups the creators it funded.
    expect(
      fundingFacts(
        creatorAnswer({
          fundingState: 'found',
          funding: {
            funder: '0xf0',
            txHash: '0x1',
            block: 3,
            kind: 'tx',
            funderKind: 'wallet',
            funderName: null,
            funderTxCount: 33,
            effective: '0xf0',
            effectiveKind: 'wallet',
            otherCreatorsFunded: ['0xa', '0xb'],
          },
        }),
      ),
    ).toEqual({
      funder: '0xf0',
      funderKind: 'wallet',
      funderName: null,
      funderTxCount: 33,
      txHash: '0x1',
      otherCreatorsFunded: 2,
    });
  });

  it('funding-trace reports the funder, and says it plainly when nothing was looked up', () => {
    const found = CATALOG['funding-trace'].run({
      token: TOKEN,
      funding: { funder: '0xf0', funderKind: 'wallet', otherCreatorsFunded: 2 },
    });
    expect(found.signal).toBe('concern');
    expect(found.facts.join(' ')).toMatch(/funded 2 other token creator/);

    const none = CATALOG['funding-trace'].run({ token: TOKEN });
    expect(none.signal).toBe('unknown');
    expect(none.limits[0]).toBe(
      'Who first sent money to the creator’s wallet was not looked up for this token.',
    );
    expect(none.limits[0]).not.toMatch(/indexer|blockscout|key/i);
  });
});

function noPair(): MarketState {
  return makeReport(TOKEN, (r) => {
    r.market = {
      completeness: 'unavailable',
      sources: [
        {
          name: 'dexscreener',
          fetchedAt: at,
          note: 'no pair indexed by DexScreener for this token',
        },
      ],
      data: {
        ...r.market.data,
        pair: null,
        priceUsd: null,
        liquidityUsd: null,
        volumeUsd: null,
        txns: null,
      },
    };
  }).market;
}

describe('pool activity from the indexer', () => {
  it('fills the market of a token with no listed pair, marked partial and sourced', () => {
    const market = withPoolActivity(noPair(), tokenAnswer(), at);
    expect(market.completeness).toBe('partial');
    expect(market.data.txns?.h24).toEqual({ buys: 30, sells: 12 });
    expect(market.data.activity?.h24.traders).toBe(25);
    expect(market.sources.map((s) => s.name)).toEqual(['dexscreener', 'indexer']);
    expect(market.sources[1]?.note).toMatch(/every swap since the launch is counted/);
  });

  it('says from when swaps are counted when the launch is older than the coverage', () => {
    const market = withPoolActivity(noPair(), tokenAnswer({ sinceLaunchComplete: false }), at);
    expect(market.sources[1]?.note).toMatch(/swaps are counted from 2026-10-15 00:00 UTC on/);
    expect(market.data.activity?.coveredFrom).toBe('2026-10-15T00:00:00.000Z');
  });

  it('leaves a market DexScreener describes as it is', () => {
    const listed = makeReport(TOKEN, (r) => {
      r.market.data.pair = '0xpair';
    }).market;
    expect(withPoolActivity(listed, tokenAnswer(), at)).toBe(listed);
    expect(withPoolActivity(noPair(), undefined, at).data.activity).toBeUndefined();
  });

  it('feeds volume-reality, with an honest window', () => {
    const report = makeReport(TOKEN, (r) => {
      r.market = withPoolActivity(noPair(), tokenAnswer(), at);
      r.holders.data.distinctTraders = null;
    });
    const f = CATALOG['volume-reality'].run({ token: TOKEN, report });
    expect(f.signal).toBe('quiet');
    expect(f.facts[0]).toMatch(/^42 trades in 24 hours in the token’s launch pool/);
    expect(f.facts[1]).toBe('They came from 25 distinct address(es).');

    const recent = makeReport(TOKEN, (r) => {
      r.collectedAt = at;
      r.market = withPoolActivity(
        noPair(),
        tokenAnswer({ sinceLaunchComplete: false, coveredFromAt: '2026-10-17T06:00:00.000Z' }),
        at,
      );
    });
    expect(CATALOG['volume-reality'].run({ token: TOKEN, report: recent }).limits[0]).toMatch(
      /counted only from 2026-10-17T06:00:00.000Z, less than 24 hours/,
    );
  });

  it('shows in the report facts, volume in ETH', () => {
    const report = makeReport(TOKEN, (r) => {
      r.market = withPoolActivity(noPair(), tokenAnswer(), at);
    });
    expect(toFacts(report).market.poolActivity).toEqual({
      buys24h: 30,
      sells24h: 12,
      traders24h: 25,
      volume24hEth: 2.5,
      lastTradeAt: '2026-10-17T09:58:00.000Z',
      coveredFrom: '2026-10-16T10:00:00.000Z',
    });
  });
});

describe('creator launches from the indexer', () => {
  const history = () =>
    makeReport(TOKEN, (r) => {
      r.creator.data.scannedRange = { fromBlock: 60_000_000, toBlock: 90_000_000 };
      r.creator.data.tokens = [
        {
          address: TOKEN,
          pool: '0xp1',
          launchedAtBlock: 86_000_000,
          launchedAt: null,
          outcome: 'active',
          graduationProgress: 0.1,
          liquidityPulled: false,
          creatorDumped: false,
        },
      ];
    }).creator;

  it('adds the launches older than the RPC window, as undetermined, and says so', () => {
    const merged = withIndexedLaunches(history(), creatorAnswer(), at);
    expect(merged.completeness).toBe('partial');
    expect(merged.data.counts.launched).toBe(3);
    expect(merged.data.counts.undetermined).toBe(2);
    expect(merged.data.tokens.map((t) => t.address)).toEqual([TOKEN, '0x01', '0x02']);
    expect(merged.data.tokens[1]).toMatchObject({ outcome: 'undetermined', creatorDumped: null });
    expect(merged.data.scannedRange.fromBlock).toBe(10_000_000);
    expect(merged.sources.at(-1)).toMatchObject({ name: 'indexer' });
    expect(merged.sources.at(-1)?.note).toMatch(/2 older launches .* was not checked/);
    // The creator question quotes that limit.
    const report = makeReport(TOKEN, (r) => {
      r.creator = merged;
    });
    expect(CATALOG['creator-history'].run({ token: TOKEN, report }).limits[0]).toMatch(
      /older launches/,
    );
  });

  it('changes nothing when the RPC read already has every launch', () => {
    const h = history();
    expect(
      withIndexedLaunches(
        h,
        creatorAnswer({ launchCount: 1, launches: [creatorAnswer().launches[0]!] }),
        at,
      ),
    ).toBe(h);
    expect(withIndexedLaunches(h, undefined, at)).toBe(h);
    expect(withIndexedLaunches(h, creatorAnswer({ creator: '0xsomeoneelse' }), at)).toBe(h);
  });
});

describe('indexedListing', () => {
  const FLAP_TOKEN = '0x00000000000000000000000000000000000f7777';
  const flapLaunch = {
    token: FLAP_TOKEN,
    pool: '',
    factory: '0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09',
    pairToken: '',
    block: 90_000_000,
    timestamp: null,
    launchpad: 'flap',
    txHash: '0xf1',
  };

  it('covers only the launchpads the indexer has read up to the head', () => {
    const listing = indexedListing(
      creatorAnswer({ launches: [flapLaunch], launchpads: { flap: 90_999_000, pons: 80_000_000 } }),
      { head: 91_000_000, launchpads: { flap: 90_999_000, pons: 80_000_000 } },
      91_000_000,
    );
    expect([...(listing?.covered ?? [])]).toEqual(['flap']);
    expect(listing?.launches).toEqual([
      {
        token: FLAP_TOKEN,
        blockNumber: 90_000_000,
        transactionHash: '0xf1',
        launchpad: expect.objectContaining({ id: 'flap', name: 'flap.sh' }),
      },
    ]);
  });

  it('covers a launchpad with no launch by this creator when the indexer has nothing on them', () => {
    const listing = indexedListing(
      undefined,
      { head: 91_000_000, launchpads: { flap: 91_000_000 } },
      91_000_000,
    );
    expect([...(listing?.covered ?? [])]).toEqual(['flap']);
    expect(listing?.launches).toEqual([]);
  });

  it('covers nothing from a capped list or an indexer that reads pons only', () => {
    expect(
      indexedListing(creatorAnswer({ truncated: true }), { head: 1, launchpads: { flap: 1 } }, 1),
    ).toBeUndefined();
    expect(indexedListing(creatorAnswer(), undefined, 1)).toBeUndefined();
  });
});
