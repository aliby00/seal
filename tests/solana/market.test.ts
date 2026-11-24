import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, UpstreamError } from '../../src/lib/errors';
import { createBudget } from '../../src/lib/http';
import {
  mainPool,
  meaningfulPools,
  solanaTokenPairsUrl,
  volumePerTrade,
  type DexScreenerPair,
} from '../../src/lib/market';
import {
  SOLANA_MARKET_DEADLINE_MS,
  fetchSolanaMarketState,
  fetchSolanaPairs,
  pickSolanaPair,
  readSolanaMarket,
  solanaListedPools,
  toSolanaMarketState,
} from '../../src/lib/market/solana';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import type { SolanaRpc } from '../../src/lib/solana/rpc';
import { SOLANA_FIXTURES, fakeRpcFor, loadRecordings } from './fixtures';

/**
 * The market zone on Solana, on DexScreener answers and node answers
 * recorded on mainnet on 24-25/11/2026 (tests/fixtures/solana/market/).
 */

const MINTS = {
  'pump-curve-xmr': 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump',
  'pump-curve-sol': 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump',
  'pump-graduated': 'B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump',
  'pump-raydium-era': 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
  'dbc-curve': '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx',
  'dbc-migrated-sol': '8X6SyaSgYdPfmZTc1B7Kc7YytMwUYJVTWXgSxJWMBAGS',
  'dbc-migrated-usdc': 'Ax5dAamJPeuaLpFUzs9FdcpoUhHDcxyjPzxCJQidjups',
  'launchlab-amm': 'CDBdbNqmrLu1PcgjrFG52yxg71QnFhBZcUE6PSFdbonk',
  'launchlab-cpmm': 'B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk',
  'launchlab-curve': 'FnYLY1FQqbfNiMdDpedMPwpKWdM8RtAkwWBvWYNAwq4T',
  ray: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
} as const;
type Slug = keyof typeof MINTS;

function pairsOf(slug: Slug): DexScreenerPair[] {
  return JSON.parse(
    readFileSync(join(SOLANA_FIXTURES, 'market', 'dexscreener', `${slug}.json`), 'utf8'),
  ) as DexScreenerPair[];
}

/** fetch answering DexScreener from a recording, and nothing else. */
function stubDexScreener(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (url: string) => {
    if (!String(url).startsWith('https://api.dexscreener.com/')) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const at = () => new Date('2026-11-25T00:00:00.000Z');

afterEach(() => vi.unstubAllGlobals());

describe('solanaTokenPairsUrl', () => {
  it('asks the token-pairs endpoint on chain "solana", the mint in its own case', () => {
    expect(solanaTokenPairsUrl(MINTS.ray)).toBe(
      'https://api.dexscreener.com/token-pairs/v1/solana/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    );
  });
});

describe('toSolanaMarketState on recorded answers', () => {
  it('reads a graduated token: price, liquidity, volume, buys and sells, FDV, venue', () => {
    const state = toSolanaMarketState(MINTS['launchlab-cpmm'], pairsOf('launchlab-cpmm'), { now: at });
    expect(state.completeness).toBe('full');
    expect(state.sources).toEqual([{ name: 'dexscreener-solana', fetchedAt: '2026-11-25T00:00:00.000Z' }]);
    expect(state.data).toMatchObject({
      chain: 'solana',
      token: MINTS['launchlab-cpmm'],
      pair: 'CuAr9cYgcSr4HVvByctB1qHzKC8UuGRt8rQRC4nByaoa',
      dex: 'raydium',
      pairedWith: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
      priceUsd: 0.00001077,
      liquidityUsd: 9505.21,
      fdvUsd: 10770,
      marketCapUsd: 10770,
    });
    expect(state.data.txns?.h24).toEqual({ buys: 10, sells: 5 });
    expect(state.data.volumeUsd?.h24).toBeCloseTo(18.38);
    // No ETH threshold on Solana: graduation is read on chain.
    expect(state.data).not.toHaveProperty('graduation');
    expect(state.data).not.toHaveProperty('pairedEth');
  });

  it('lists each pool with its venue and labels, the most liquid first, addresses unchanged', () => {
    const pools = solanaListedPools(MINTS['launchlab-cpmm'], pairsOf('launchlab-cpmm'));
    expect(pools.map((p) => [p.id, p.dex, p.labels])).toEqual([
      ['CuAr9cYgcSr4HVvByctB1qHzKC8UuGRt8rQRC4nByaoa', 'raydium', ['CPMM']],
      ['96yihy6gSVeSRXKT4Chysgg9v6U8RGptwn51MQ51JsAQ', 'raydium', ['CLMM']],
    ]);
    expect(pools[1]?.pairedWith?.symbol).toBe('USD1');
    expect(pools.every((p) => p.version === null && p.base)).toBe(true);
  });

  it('a token still on its pump.fun curve: the curve is the pair, no liquidity figure, said so', () => {
    const state = toSolanaMarketState(MINTS['pump-curve-xmr'], pairsOf('pump-curve-xmr'), { now: at });
    expect(state.completeness).toBe('partial');
    expect(state.data.pair).toBe('8j8apXSGYWc9m9XySAADCYmUzhetFzs2ZMoj36opQ8YA');
    expect(state.data.dex).toBe('pumpfun');
    expect(state.data.pairedWith?.symbol).toBe('XMR');
    expect(state.data.liquidityUsd).toBeNull();
    expect(state.data.priceUsd).toBeGreaterThan(0);
    expect(state.sources[0]?.note).toMatch(/launchpad curve is listed without one/);
  });

  it('a Meteora DBC curve reads the same way', () => {
    const state = toSolanaMarketState(MINTS['dbc-curve'], pairsOf('dbc-curve'), { now: at });
    expect(state.data.dex).toBe('meteoradbc');
    expect(state.data.pair).toBe('DbdgjtiiRBWY2C3F3cLssjgfaFQXkRWuoHjduEvexJ9f');
    expect(state.completeness).toBe('partial');
  });

  it('picks the most liquid pair where the token is the base', () => {
    const state = toSolanaMarketState(MINTS['pump-graduated'], pairsOf('pump-graduated'), { now: at });
    expect(state.data.pair).toBe('AnZQ2WkdREg5v1cLT96mnt63wYysRXPtfnkU8JVFDN2f');
    expect(state.data.dex).toBe('meteora');
    expect(state.data.liquidityUsd).toBeCloseTo(4475088.75);
    // Pairs where FIONA is the quote side are listed, flagged as such.
    expect(state.data.pools.some((p) => !p.base)).toBe(true);
    expect(state.data.pools.length).toBeLessThanOrEqual(12);
  });

  it('no pair indexed: unavailable, not an error', () => {
    const state = toSolanaMarketState(MINTS['launchlab-curve'], pairsOf('launchlab-curve'), { now: at });
    expect(pairsOf('launchlab-curve')).toEqual([]);
    expect(state.completeness).toBe('unavailable');
    expect(state.sources[0]?.note).toBe('no pair indexed by DexScreener for this token');
    expect(state.data.pools).toEqual([]);
  });

  it('a token listed only as the quote side has no price of its own', () => {
    const quoteOnly = pairsOf('pump-graduated').filter((p) => p.baseToken?.address !== MINTS['pump-graduated']);
    expect(quoteOnly.length).toBeGreaterThan(0);
    const state = toSolanaMarketState(MINTS['pump-graduated'], quoteOnly, { now: at });
    expect(state.completeness).toBe('unavailable');
    expect(state.data.priceUsd).toBeNull();
    expect(state.sources[0]?.note).toMatch(/quote side/);
  });

  it('matches addresses exactly: the same mint in lowercase is another address', () => {
    const lower = MINTS['launchlab-cpmm'].toLowerCase();
    const state = toSolanaMarketState(lower, pairsOf('launchlab-cpmm'), { now: at });
    expect(state.data.pair).toBeNull();
    expect(pickSolanaPair(lower, pairsOf('launchlab-cpmm'))).toBeUndefined();
  });
});

describe('helpers shared with Robinhood Chain', () => {
  it('mainPool finds a Solana pool by its exact id', () => {
    const state = toSolanaMarketState(MINTS['dbc-migrated-usdc'], pairsOf('dbc-migrated-usdc'), { now: at });
    expect(mainPool(state.data)?.id).toBe('CP222Ubb6wY2J3EnMbMmEGGQdgGWDcUADa358LDN7HxX');
    expect(meaningfulPools(state.data).every((p) => p.id !== state.data.pair)).toBe(true);
  });

  it('volumePerTrade reads a Solana state', () => {
    const state = toSolanaMarketState(MINTS['launchlab-cpmm'], pairsOf('launchlab-cpmm'), { now: at });
    expect(volumePerTrade(state)).toBeCloseTo(18.38 / 15);
  });
});

describe('fetchSolanaPairs', () => {
  it('cites dexscreener-solana and spends the budget', async () => {
    const fetchMock = stubDexScreener(pairsOf('ray'));
    const budget = createBudget(2);
    const pairs = await fetchSolanaPairs(MINTS.ray, { budget });
    expect(pairs.length).toBe(pairsOf('ray').length);
    expect(budget.spent).toBe(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(solanaTokenPairsUrl(MINTS.ray));
  });

  it('refuses what is not a Solana address, without a request', async () => {
    const fetchMock = stubDexScreener([]);
    await expect(fetchSolanaPairs('0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9')).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a null body is "not found", anything but an array is an upstream error', async () => {
    stubDexScreener(null);
    await expect(fetchSolanaPairs(MINTS.ray)).rejects.toBeInstanceOf(NotFoundError);
    stubDexScreener({ pairs: [] });
    await expect(fetchSolanaPairs(MINTS.ray)).rejects.toThrow(/expected an array/);
  });

  it('drops pairs of another chain', async () => {
    const [first] = pairsOf('ray');
    stubDexScreener([first, { ...first, chainId: 'bsc', pairAddress: 'x' }]);
    expect(await fetchSolanaPairs(MINTS.ray)).toHaveLength(1);
  });

  it('fetchSolanaMarketState chains the two', async () => {
    stubDexScreener(pairsOf('launchlab-amm'));
    const state = await fetchSolanaMarketState(MINTS['launchlab-amm'], { now: at });
    expect(state.data.pair).toBe('Hv1i8WrxEhL8djBuxhFGJxXTt4qEupywWKFSgGB5A7w6');
  });
});

describe('readSolanaMarket, the whole zone, on recorded answers', () => {
  const read = async (slug: Slug) => {
    stubDexScreener(pairsOf(slug));
    // The recordings come from the public node, which does not serve getTokenLargestAccounts.
    const rpc = fakeRpcFor('market', [`${slug}.json`]);
    const result = await readSolanaMarket(MINTS[slug], { rpc, now: at });
    return { result, calls: rpc.calls.length };
  };

  it('pump.fun, graduated to PumpSwap: launch, graduation and burned LP of the pool it moved to', async () => {
    const { result, calls } = await read('pump-graduated');
    expect(result.launch.data.launchpad?.id).toBe('pump.fun');
    expect(result.graduation?.data.graduated).toBe(true);
    expect(result.graduation?.data.destination?.pool).toBe('DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB');
    const [first] = result.liquidity.data.pools;
    expect(first).toMatchObject({ pool: 'DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB', kind: 'pumpswap', burnedShare: 1 });
    // DLMM pools beside it are not read: partial, and said why.
    expect(result.liquidity.completeness).toBe('partial');
    expect(result.liquidity.sources[0]?.note).toMatch(/Meteora DLMM/);
    expect(calls).toBeLessThanOrEqual(8);
  });

  it('a token on its curve: no pool to read, the curve is not taken for one', async () => {
    const { result } = await read('pump-curve-sol');
    expect(result.graduation?.data.graduated).toBe(false);
    expect(result.liquidity.completeness).toBe('unavailable');
    expect(result.liquidity.data.pools).toEqual([]);
  });

  it('Meteora DBC migrated to DAMM v2: liquidity locked for good', async () => {
    const { result } = await read('dbc-migrated-sol');
    expect(result.launch.data.launchpad?.id).toBe('meteora-dbc');
    expect(result.graduation?.data.destination?.pool).toBe('BjoLhkUZKtPMBxEN7Lofn6n4k6vKtm88xSj8V2n1E69u');
    expect(result.liquidity.data.pools[0]).toMatchObject({ kind: 'meteora-damm-v2', lockedShare: 1, withdrawableShare: 0 });
    expect(result.liquidity.completeness).toBe('full');
  });

  it('RAY, no launchpad: none found, said so, its pools still read', async () => {
    const { result } = await read('ray');
    expect(result.launch.data.launchpad).toBeNull();
    expect(result.launch.sources[0]?.note).toMatch(/no pump.fun curve/);
    expect(result.graduation).toBeNull();
    expect(result.liquidity.data.pools.map((p) => p.kind)).toEqual(['raydium-amm-v4', 'raydium-amm-v4', 'raydium-clmm']);
  });

  it('every recorded token reads within the call cap', async () => {
    for (const slug of Object.keys(MINTS) as Slug[]) {
      const { result, calls } = await read(slug);
      expect(calls, slug).toBeLessThanOrEqual(8);
      expect(result.market.sources[0]?.name).toBe('dexscreener-solana');
      expect(result.launch.sources[0]?.name).toBe('solana-rpc');
    }
  });

  it('a part that fails is reported unavailable with its reason; the others stand', async () => {
    stubDexScreener(pairsOf('launchlab-cpmm'));
    // Only the launch lookup was recorded: the graduation and liquidity reads find no answer.
    const recordings = loadRecordings('market', ['launchlab-cpmm.json']).slice(0, 1);
    const result = await readSolanaMarket(MINTS['launchlab-cpmm'], { rpc: createFakeSolanaRpc(recordings), now: at });
    expect(result.market.completeness).toBe('full');
    expect(result.launch.data.launchpad?.id).toBe('raydium-launchlab');
    expect(result.graduation?.completeness).toBe('unavailable');
    expect(result.liquidity.completeness).toBe('unavailable');
    expect(result.graduation?.sources[0]?.note).toBe('unexpected error');
  });

  it('DexScreener down: the market is unavailable, the chain reads go on', async () => {
    stubDexScreener({ error: 'x' }, 404);
    const rpc = fakeRpcFor('market', ['pump-curve-sol.json']);
    const result = await readSolanaMarket(MINTS['pump-curve-sol'], { rpc, now: at });
    expect(result.market.completeness).toBe('unavailable');
    expect(result.market.sources[0]?.name).toBe('dexscreener-solana');
    expect(result.launch.data.launchpad?.id).toBe('pump.fun');
  });

  it('stops waiting at the deadline', async () => {
    stubDexScreener(pairsOf('pump-curve-sol'));
    const never: SolanaRpc = {
      ...fakeRpcFor('market', ['pump-curve-sol.json']),
      getMultipleAccounts: () => new Promise(() => {}),
    };
    const result = await readSolanaMarket(MINTS['pump-curve-sol'], { rpc: never, now: at, deadlineMs: 50 });
    expect(result.launch.completeness).toBe('unavailable');
    expect(result.launch.sources[0]?.note).toMatch(/timed out/);
    expect(SOLANA_MARKET_DEADLINE_MS).toBeLessThanOrEqual(15_000);
  });
});
