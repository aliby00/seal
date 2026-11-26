import { describe, expect, it } from 'vitest';
import {
  chainLiquidity,
  figureSource,
  holdersLine,
  holdersStamp,
  marketLines,
  marketStamp,
  type MarketRead,
} from '../../src/app/components/live-labels';

const NOW = Date.parse('2026-11-26T12:00:10.000Z');
const COLLECTED = '2026-11-26T11:59:00.000Z';
/** The clock in UTC, so the tests do not depend on the machine's time zone. */
const clock = (iso: string) => iso.slice(11, 19);

const dexOnly: MarketRead = {
  at: '2026-11-26T12:00:08.000Z',
  chain: null,
  dexAt: '2026-11-26T12:00:07.000Z',
  liquidityUsd: 12_000,
};
const chainRead = {
  priceUsd: 0.0001,
  priceSol: 0.0000006,
  marketCapUsd: 100_000,
  liquidityUsd: 40_000,
};
const pumpswap: MarketRead = {
  at: '2026-11-26T12:00:09.000Z',
  chain: {
    ...chainRead,
    slot: 412_345_678,
    readAt: '2026-11-26T12:00:08.000Z',
    pool: 'P',
    kind: 'pumpswap',
  },
  dexAt: '2026-11-26T12:00:05.000Z',
  liquidityUsd: 40_000,
};
const curve: MarketRead = {
  at: '2026-11-26T12:00:09.000Z',
  chain: {
    ...chainRead,
    liquidityUsd: 9_000,
    slot: 412_345_679,
    readAt: '2026-11-26T12:00:09.000Z',
    pool: 'C',
    kind: 'pump-curve',
  },
  dexAt: '2026-11-26T12:00:05.000Z',
  liquidityUsd: null,
  curveLiquidityUsd: 9_000,
};

describe('market freshness line', () => {
  it('says the price is live from the chain, with its slot and age, and the volume is DexScreener’s', () => {
    expect(marketLines(pumpswap, COLLECTED, NOW, clock)).toEqual([
      { text: 'Price live from the chain · slot 412,345,678 · 2 s ago', live: true },
      { text: 'Volume via DexScreener (up to ~1 min delay)', live: false },
    ]);
  });

  it('without a chain read says DexScreener and its delay, and when it was checked, never "updated"', () => {
    const lines = marketLines(dexOnly, COLLECTED, NOW, clock);
    expect(lines).toEqual([
      { text: 'Market via DexScreener (up to ~1 min delay) · checked 3 s ago', live: false },
    ]);
    expect(lines.map((l) => l.text).join(' ')).not.toMatch(/updated/i);
  });

  it('reads an older answer without `chain` nor `dexAt` as DexScreener’s, aged from its read', () => {
    expect(marketLines({ at: '2026-11-26T12:00:00.000Z' }, COLLECTED, NOW, clock)).toEqual([
      { text: 'Market via DexScreener (up to ~1 min delay) · checked 10 s ago', live: false },
    ]);
  });

  it('before any poll gives the report’s own time', () => {
    expect(marketLines(null, COLLECTED, NOW, clock)).toEqual([
      { text: 'Market as of 11:59:00 via DexScreener (up to ~1 min delay)', live: false },
    ]);
  });
});

describe('market card stamp', () => {
  it('names the slot when read on chain, DexScreener’s delay otherwise', () => {
    expect(marketStamp(pumpswap, COLLECTED, false, NOW, clock)).toEqual({
      text: 'Price live from the chain · slot 412,345,678 · 2 s ago',
      live: true,
    });
    expect(marketStamp(dexOnly, COLLECTED, false, NOW, clock)).toEqual({
      text: 'Via DexScreener (up to ~1 min delay) · checked 3 s ago',
      live: false,
    });
    expect(marketStamp(null, COLLECTED, false, NOW, clock).text).toBe(
      'As of 11:59:00 via DexScreener (up to ~1 min delay)',
    );
  });

  it('once polling stopped gives the last read’s time', () => {
    expect(marketStamp(pumpswap, COLLECTED, true, NOW, clock).text).toBe(
      'Price from the chain at 12:00:08 (slot 412,345,678) · live paused',
    );
    expect(marketStamp(dexOnly, COLLECTED, true, NOW, clock).text).toBe(
      'Via DexScreener (up to ~1 min delay) · checked 12:00:07 · live paused',
    );
  });
});

describe('holders source', () => {
  it('read on chain with the report, then refreshed every 20 s', () => {
    expect(holdersLine(null, COLLECTED, NOW, clock)).toBe(
      'Holders and dev read from the chain · read at 11:59:00',
    );
    expect(holdersLine('2026-11-26T12:00:00.000Z', COLLECTED, NOW, clock)).toBe(
      'Holders and dev read from the chain · refreshed 10 s ago',
    );
    expect(holdersStamp(null, COLLECTED, false, NOW, clock)).toEqual({
      text: 'Read from the chain at 11:59:00',
      live: false,
    });
    expect(holdersStamp('2026-11-26T12:00:00.000Z', COLLECTED, false, NOW, clock)).toEqual({
      text: 'Read from the chain · refreshed 10 s ago',
      live: true,
    });
    expect(holdersStamp('2026-11-26T12:00:00.000Z', COLLECTED, true, NOW, clock).text).toBe(
      'Read from the chain at 12:00:00 · live paused',
    );
  });
});

describe('figure source tags', () => {
  it('tags market cap and a PumpSwap liquidity "chain", the volume DexScreener', () => {
    expect(figureSource({ id: 'mcap' }, pumpswap)).toBe('chain');
    expect(figureSource({ id: 'liquidity', sub: '12% of mcap' }, pumpswap)).toBe('chain');
    expect(figureSource({ id: 'volume', sub: '1,204 trades' }, pumpswap)).toBe('dex');
    expect(figureSource({ id: 'holders' }, pumpswap)).toBeNull();
  });

  it('tags a curve’s liquidity "chain" only when the row shows the curve’s quote', () => {
    expect(figureSource({ id: 'liquidity', sub: 'on the curve · 30% of mcap' }, curve)).toBe(
      'chain',
    );
    expect(figureSource({ id: 'liquidity', sub: '30% of mcap' }, curve)).toBeNull();
    expect(chainLiquidity(curve, false)).toBe(false);
  });

  it('without a chain read tags nothing "chain", and the volume stays DexScreener’s', () => {
    for (const market of [dexOnly, null, { at: dexOnly.at }]) {
      expect(figureSource({ id: 'mcap' }, market)).toBeNull();
      expect(figureSource({ id: 'liquidity' }, market)).toBeNull();
      expect(figureSource({ id: 'volume' }, market)).toBe('dex');
    }
  });
});
