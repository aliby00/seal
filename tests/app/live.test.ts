import { describe, expect, it } from 'vitest';
import { liveSolanaView } from '../../src/app/components/live-merge';
import { toSolanaView } from '../../src/app/components/solana-view';
import {
  IDLE_AFTER_MS,
  MARKET_EVERY_MS,
  MAX_BACKOFF_MS,
  isIdle,
  mergeLive,
  nextDelay,
} from '../../src/app/components/useLive';
import { solanaReport } from '../helpers/solana-report';

const AT = '2026-11-26T12:00:00.000Z';

describe('live polling', () => {
  it('polls every 2 s, doubles the wait after each failed poll, 60 s at most', () => {
    expect(nextDelay(0)).toBe(MARKET_EVERY_MS);
    expect(nextDelay(1)).toBe(4_000);
    expect(nextDelay(2)).toBe(8_000);
    expect(nextDelay(5)).toBe(MAX_BACKOFF_MS);
    expect(nextDelay(500)).toBe(MAX_BACKOFF_MS);
  });

  it('stops a page left untouched for half an hour', () => {
    expect(isIdle(0, IDLE_AFTER_MS - 1)).toBe(false);
    expect(isIdle(0, IDLE_AFTER_MS)).toBe(true);
  });

  it('keeps the holders of the last refresh when a poll brings the market only', () => {
    const holders = {
      token: 'x',
      at: AT,
      holderCount: 10,
      top1OfSupply: 0.1,
      top10OfSupply: 0.5,
      devHolds: 0,
    };
    const before = { market: null, holders, paused: true };
    const market = {
      token: 'x',
      at: AT,
      priceUsd: 1,
      marketCapUsd: 1,
      fdvUsd: 1,
      liquidityUsd: 1,
      liquidityToMarketCap: 1,
      volume24hUsd: 1,
      buys24h: 1,
      sells24h: 1,
      perTradeUsd24h: 1,
    };
    expect(mergeLive(before, { market, holders: null })).toEqual({
      market,
      holders,
      paused: false,
    });
  });
});

describe('liveSolanaView', () => {
  const view = toSolanaView(solanaReport());

  it('is the report’s own view until a holders refresh lands', () => {
    expect(liveSolanaView(view, null)).toBe(view);
  });

  it('lays the refreshed holders and the creator’s balance over the report', () => {
    const merged = liveSolanaView(view, {
      token: 'x',
      at: AT,
      holderCount: 1234,
      top1OfSupply: 0.07,
      top10OfSupply: 0.33,
      devHolds: 0.011,
    });
    expect(merged.holders.data.holderCount).toBe(1234);
    expect(merged.holders.data.ofSupply.largestWallet).toBe(0.07);
    expect(merged.holders.data.ofSupply.top10Wallets).toBe(0.33);
    // The pools and the locks are not re-read: the report's stay.
    expect(merged.holders.data.ofSupply.pools).toBe(view.holders.data.ofSupply.pools);
    if (view.holders.data.creator) expect(merged.holders.data.creator?.ofSupply).toBe(0.011);
    if (view.onToken) expect(merged.onToken?.data.holdsNow).toBe(0.011);
    expect(merged.history).toBe(view.history);
  });

  it('keeps a figure the refresh could not read', () => {
    const merged = liveSolanaView(view, {
      token: 'x',
      at: AT,
      holderCount: null,
      top1OfSupply: null,
      top10OfSupply: null,
      devHolds: null,
    });
    expect(merged.holders.data).toEqual(view.holders.data);
    expect(merged.onToken).toEqual(view.onToken);
  });
});
