import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/lib/cache';
import { classifyHolder } from '../../src/lib/holders';
import { toMarketState } from '../../src/lib/market';

const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';
const OTHER = '0x1111111111111111111111111111111111111111';

describe('market: the token must be the base of the pair', () => {
  // When the token is the quote side, DexScreener's price is the other token's.
  it('ignores pairs where the token is the quote', () => {
    const state = toMarketState(TOKEN, [
      { baseToken: { address: OTHER }, priceUsd: '101', liquidity: { usd: 500_000 } },
    ]);
    expect(state.data.priceUsd).toBeNull();
    expect(state.completeness).toBe('unavailable');
  });

  it('keeps the base-side pair even when a quote-side one is more liquid', () => {
    const state = toMarketState(TOKEN, [
      { baseToken: { address: OTHER }, priceUsd: '101', liquidity: { usd: 500_000 } },
      { baseToken: { address: TOKEN }, priceUsd: '0.002', liquidity: { usd: 1_000, quote: 0.4 } },
    ]);
    expect(state.data.priceUsd).toBeCloseTo(0.002);
    // liquidity.quote is in the quote token, not necessarily ETH.
    expect(state.data.pairedEth).toBeNull();
  });
});

describe('holders: liquidity is not a position', () => {
  it('never counts the v4 PoolManager as a holder', () => {
    expect(classifyHolder('0x8366a39cc670b4001a1121b8f6a443a643e40951', true)).toBe('pool');
  });

  it('treats the DEX pair as liquidity', () => {
    expect(classifyHolder(OTHER, true, undefined, [OTHER])).toBe('pool');
  });
});

describe('TtlCache', () => {
  it('shares one computation between concurrent requests', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000 });
    let runs = 0;
    const slow = () => new Promise<number>((r) => setTimeout(() => r(++runs), 5));
    const [a, b] = await Promise.all([cache.resolve('k', slow), cache.resolve('k', slow)]);
    expect(runs).toBe(1);
    expect(a.value).toBe(b.value);
  });

  it('returns but does not keep a value it is told not to', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000, keep: (v) => v > 0 });
    await cache.resolve('k', async () => -1);
    expect(cache.size).toBe(0);
    await cache.resolve('k', async () => 1);
    expect(cache.size).toBe(1);
  });
});
