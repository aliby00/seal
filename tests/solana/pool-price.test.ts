import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { liveMarketOf, plausible, type LiveDex } from '../../src/lib/live';
import {
  PYTH_MAX_AGE_S,
  PYTH_SOL_USD_ACCOUNT,
  decodePythSolUsd,
  forgetPoolShapes,
  readPoolPrice,
  type PoolPrice,
} from '../../src/lib/solana/pool-price';
import type { RecordedCall } from '../../src/lib/solana/rpc';
import { SOLANA_FIXTURES, fakeRpcFor, loadRecordings } from './fixtures';
import type { LivePriceCase } from './live-price-tokens';

/**
 * The live price, read from pools recorded on mainnet on 26/11/2026
 * (tests/fixtures/solana/live-price/), compared with what DexScreener said in
 * the same second: the chain leads it by 10 to 60 s, so the two agree within
 * a few percent, never to the digit.
 */
const ZONE = 'live-price';
const CASES = JSON.parse(
  readFileSync(join(SOLANA_FIXTURES, ZONE, 'cases.json'), 'utf8'),
) as LivePriceCase[];
const at = (c: LivePriceCase) => () => new Date(c.now);
const byName = (slug: string) => CASES.find((c) => c.slug === slug)!;
/** The kinds read on chain; every other pool keeps DexScreener's figures. */
const READ = new Set(['pump-curve', 'pumpswap']);

beforeEach(() => forgetPoolShapes());

describe('live price from the pool on chain', () => {
  for (const c of CASES.filter((x) => READ.has(x.kind ?? ''))) {
    it(`${c.slug}: reads ${c.kind}, within a few percent of DexScreener`, async () => {
      const rpc = fakeRpcFor(ZONE, [`${c.slug}.json`]);
      const read = await readPoolPrice(rpc, c.mint, c.pool, { now: at(c) });
      expect(read).not.toBeNull();
      const r = read as PoolPrice;
      expect(r.kind).toBe(c.kind);
      expect(r.slot).toBeGreaterThan(470_000_000);
      expect(Math.abs(r.priceUsd / c.dexscreener.priceUsd - 1)).toBeLessThan(0.1);
      if (c.kind === 'pump-curve') {
        expect(r.liquidityUsd).toBeNull();
        expect(r.curveLiquidityUsd).toBeGreaterThan(0);
      } else {
        expect(
          Math.abs((r.liquidityUsd ?? 0) / (c.dexscreener.liquidityUsd ?? 1) - 1),
        ).toBeLessThan(0.15);
      }
    });
  }

  for (const c of CASES.filter((x) => !READ.has(x.kind ?? ''))) {
    it(`${c.slug}: not a kind read here, DexScreener's figures stay`, async () => {
      const rpc = fakeRpcFor(ZONE, [`${c.slug}.json`]);
      expect(await readPoolPrice(rpc, c.mint, c.pool, { now: at(c) })).toBeNull();
      // Told so with one call: the pool's account alone.
      expect(rpc.calls).toHaveLength(1);
    });
  }

  it('refuses a pool that is not one of the token', async () => {
    const c = byName('pumpswap-young');
    const other = byName('pumpswap-ansem');
    const rpc = fakeRpcFor(ZONE, ['pumpswap-young.json']);
    // The recorded call asks for the pool with its own mint: asked with another, it is refused.
    await expect(readPoolPrice(rpc, other.mint, c.pool, { now: at(c) })).rejects.toThrow();
    // A pool whose mints are not the token's, served as if they were.
    const swapped = loadRecordings(ZONE, ['pumpswap-young.json']).map((entry) => ({
      ...entry,
      params: [
        [...((entry.params?.[0] as string[]) ?? []).map((a) => (a === c.mint ? other.mint : a))],
        entry.params?.[1],
      ],
    })) as RecordedCall[];
    const { createFakeSolanaRpc } = await import('../../src/lib/solana/fake-rpc');
    expect(
      await readPoolPrice(createFakeSolanaRpc(swapped), other.mint, c.pool, { now: at(c) }),
    ).toBeNull();
  });

  it('costs one call per refresh once the pool is known', async () => {
    const c = byName('pumpswap-young');
    const rpc = fakeRpcFor(ZONE, ['pumpswap-young.json']);
    await readPoolPrice(rpc, c.mint, c.pool, { now: at(c) });
    expect(rpc.calls).toHaveLength(2);
    await readPoolPrice(rpc, c.mint, c.pool, { now: at(c) });
    expect(rpc.calls).toHaveLength(3);
    expect(rpc.calls.every((call) => call.method === 'getMultipleAccounts')).toBe(true);
  });

  it('puts SOL in dollars with Pyth, and with the hint once Pyth is too old', async () => {
    const c = byName('pump-curve');
    const recorded = loadRecordings(ZONE, ['pump-curve.json'])[0]!;
    const value = (recorded.result as { value: { owner: string; data: [string, string] }[] }).value;
    const pyth = value[2]!;
    const bytes = Uint8Array.from(Buffer.from(pyth.data[0], 'base64'));
    const nowS = Math.floor(Date.parse(c.now) / 1000);
    const fresh = decodePythSolUsd(pyth.owner, bytes, nowS);
    expect(fresh?.usd).toBeGreaterThan(50);
    expect(fresh?.usd).toBeLessThan(100);
    // DexScreener's own SOL price in the same second, within half a percent.
    const dexSol = c.dexscreener.priceUsd / c.dexscreener.priceNative;
    expect(Math.abs((fresh?.usd ?? 0) / dexSol - 1)).toBeLessThan(0.01);
    expect(decodePythSolUsd(pyth.owner, bytes, nowS + PYTH_MAX_AGE_S + 60)).toBeNull();
    expect(decodePythSolUsd('11111111111111111111111111111111', bytes, nowS)).toBeNull();
    const late = () => new Date(Date.parse(c.now) + (PYTH_MAX_AGE_S + 60) * 1000);
    const rpc = fakeRpcFor(ZONE, ['pump-curve.json']);
    expect(await readPoolPrice(rpc, c.mint, c.pool, { now: late })).toBeNull();
    const hinted = await readPoolPrice(rpc, c.mint, c.pool, { now: late, solUsdHint: 100 });
    expect(hinted?.quoteUsd).toBe(100);
    expect(PYTH_SOL_USD_ACCOUNT).toBe((recorded.params?.[0] as string[])[2]);
  });
});

describe('the live market laid together', () => {
  const dex: LiveDex = {
    at: '2026-11-26T15:00:00.000Z',
    pair: 'pool',
    priceUsd: 0.0001,
    priceNative: 0.0000014,
    marketCapUsd: 100_000,
    fdvUsd: 100_000,
    liquidityUsd: 20_000,
    liquidityToMarketCap: 0.2,
    volume24hUsd: 1_000_000,
    buys24h: 100,
    sells24h: 50,
    perTradeUsd24h: 6_666,
  };
  const chain: PoolPrice = {
    pool: 'pool',
    kind: 'pumpswap',
    slot: 474_190_660,
    priceQuote: 0.0000015,
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteUsd: 70,
    priceUsd: 0.00011,
    liquidityUsd: 22_000,
    curveLiquidityUsd: null,
    supply: 975_000_000,
  };
  const AT = '2026-11-26T15:00:20.000Z';

  it('takes price, market cap and liquidity from the chain, volume from DexScreener', () => {
    const m = liveMarketOf('mint', dex, chain, AT);
    expect(m.priceUsd).toBe(0.00011);
    // DexScreener's supply (its market cap over its price), the chain's price.
    expect(m.marketCapUsd).toBeCloseTo(110_000, 6);
    expect(m.fdvUsd).toBeCloseTo(110_000, 6);
    expect(m.liquidityUsd).toBe(22_000);
    expect(m.liquidityToMarketCap).toBe(0.2);
    expect(m.volume24hUsd).toBe(1_000_000);
    expect(m.chain).toEqual({
      priceUsd: 0.00011,
      priceSol: 0.0000015,
      marketCapUsd: m.marketCapUsd,
      liquidityUsd: 22_000,
      slot: 474_190_660,
      readAt: AT,
      pool: 'pool',
      kind: 'pumpswap',
    });
    expect(m.dexAt).toBe(dex.at);
    expect(m.at).toBe(AT);
  });

  it('keeps DexScreener’s figures, said as such, when the pool was not read', () => {
    const m = liveMarketOf('mint', dex, null, AT);
    expect(m.priceUsd).toBe(0.0001);
    expect(m.chain).toBeNull();
    expect(m.at).toBe(dex.at);
  });

  it('gives a curve its quote as liquidity for the ratio, none as pool liquidity', () => {
    const curve = {
      ...chain,
      kind: 'pump-curve' as const,
      liquidityUsd: null,
      curveLiquidityUsd: 5_500,
    };
    const m = liveMarketOf('mint', { ...dex, liquidityUsd: null }, curve, AT);
    expect(m.liquidityUsd).toBeNull();
    expect(m.curveLiquidityUsd).toBe(5_500);
    expect(m.chain?.liquidityUsd).toBe(5_500);
    expect(m.liquidityToMarketCap).toBe(0.05);
  });

  it('uses the mint’s supply when DexScreener gives no market cap', () => {
    const m = liveMarketOf('mint', { ...dex, marketCapUsd: null, fdvUsd: null }, chain, AT);
    expect(m.marketCapUsd).toBeNull();
    expect(m.fdvUsd).toBeCloseTo(0.00011 * 975_000_000, 4);
  });

  it('sets aside a chain price five times off DexScreener’s', () => {
    expect(plausible(chain, dex)).toBe(true);
    expect(plausible({ ...chain, priceUsd: 0.0006 }, dex)).toBe(false);
    expect(plausible({ ...chain, priceUsd: 0.00001 }, dex)).toBe(false);
  });
});
