import type { Figure } from '@/lib/figures';
import type { LiveMarket } from '@/lib/live';
import { agoWords } from './useLive';

/**
 * What the page says about where each live figure comes from and how old it
 * is. The price, market cap and liquidity are read on chain when the main
 * pool is a pump.fun curve or a PumpSwap pool, slot by slot; the volume and
 * the trades are always DexScreener's, which gives no time for its own
 * figures (a pair has no "updated at") and runs 10 to 60 s behind the chain:
 * its delay is said as a bound, never as "updated 0 s ago".
 */
export const DEX_DELAY = 'up to ~1 min delay';

/** The parts of a live market read the labels need; older answers carry no `chain` nor `dexAt`. */
export type MarketRead = Pick<LiveMarket, 'at'> &
  Partial<Pick<LiveMarket, 'chain' | 'dexAt' | 'liquidityUsd' | 'curveLiquidityUsd'>>;

/** One freshness line, and whether it is a live chain read (drawn with the live dot). */
export type Stamp = { text: string; live: boolean };

/** "14:02:11", in the reader's own time. */
export function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const slotWords = (slot: number) => `slot ${slot.toLocaleString('en-US')}`;
const since = (iso: string, now: number) => agoWords(now - Date.parse(iso));

/**
 * The market's line under the figures row: "Price live from the chain ·
 * slot N · 2 s ago" and "Volume via DexScreener (up to ~1 min delay)" when
 * the pool was read on chain; "Market via DexScreener (up to ~1 min delay) ·
 * checked 2 s ago" when it was not; the report's own time before any poll.
 */
export function marketLines(
  market: MarketRead | null,
  collectedAt: string,
  now: number,
  clock: (iso: string) => string = clockOf,
): Stamp[] {
  if (!market) {
    return [
      { text: `Market as of ${clock(collectedAt)} via DexScreener (${DEX_DELAY})`, live: false },
    ];
  }
  if (market.chain) {
    return [
      {
        text: `Price live from the chain · ${slotWords(market.chain.slot)} · ${since(market.chain.readAt, now)}`,
        live: true,
      },
      { text: `Volume via DexScreener (${DEX_DELAY})`, live: false },
    ];
  }
  return [
    {
      text: `Market via DexScreener (${DEX_DELAY}) · checked ${since(market.dexAt ?? market.at, now)}`,
      live: false,
    },
  ];
}

/** The market card's stamp: the same sources, and the last read's time once polling stopped. */
export function marketStamp(
  market: MarketRead | null,
  collectedAt: string,
  paused: boolean,
  now: number,
  clock: (iso: string) => string = clockOf,
): Stamp {
  if (!market)
    return { text: `As of ${clock(collectedAt)} via DexScreener (${DEX_DELAY})`, live: false };
  const chain = market.chain;
  if (paused) {
    return chain
      ? {
          text: `Price from the chain at ${clock(chain.readAt)} (${slotWords(chain.slot)}) · live paused`,
          live: false,
        }
      : {
          text: `Via DexScreener (${DEX_DELAY}) · checked ${clock(market.dexAt ?? market.at)} · live paused`,
          live: false,
        };
  }
  return chain
    ? {
        text: `Price live from the chain · ${slotWords(chain.slot)} · ${since(chain.readAt, now)}`,
        live: true,
      }
    : {
        text: `Via DexScreener (${DEX_DELAY}) · checked ${since(market.dexAt ?? market.at, now)}`,
        live: false,
      };
}

/**
 * Where the holders come from: the token accounts read on chain when the
 * report was made, then again every 20 s while the page is open.
 */
export function holdersStamp(
  holdersAt: string | null,
  collectedAt: string,
  paused: boolean,
  now: number,
  clock: (iso: string) => string = clockOf,
): Stamp {
  if (!holdersAt) return { text: `Read from the chain at ${clock(collectedAt)}`, live: false };
  if (paused)
    return { text: `Read from the chain at ${clock(holdersAt)} · live paused`, live: false };
  return { text: `Read from the chain · refreshed ${since(holdersAt, now)}`, live: true };
}

/** The holders' line under the figures row. */
export function holdersLine(
  holdersAt: string | null,
  collectedAt: string,
  now: number,
  clock: (iso: string) => string = clockOf,
): string {
  return holdersAt
    ? `Holders and dev read from the chain · refreshed ${since(holdersAt, now)}`
    : `Holders and dev read from the chain · read at ${clock(collectedAt)}`;
}

export type Source = 'chain' | 'dex';

/** The tag drawn beside a figure: "chain" or "via DexScreener". */
export const SOURCE_WORDS: Record<Source, string> = { chain: 'chain', dex: 'via DexScreener' };

/**
 * Whether the liquidity shown is the chain's: a PumpSwap pool's two vaults,
 * or a curve's quote when the row shows the curve (DexScreener lists none).
 */
export function chainLiquidity(market: MarketRead | null, curveShown: boolean): boolean {
  const chain = market?.chain;
  if (!chain) return false;
  if (chain.kind === 'pumpswap') return true;
  return curveShown && market.liquidityUsd == null && market.curveLiquidityUsd != null;
}

/**
 * The source tag of a figure of the row: market cap and liquidity read on
 * chain say "chain"; the volume and its trades are always DexScreener's.
 * The rest (holders, dev, launch) is said by its own line.
 */
export function figureSource(
  figure: Pick<Figure, 'id' | 'sub'>,
  market: MarketRead | null,
): Source | null {
  if (figure.id === 'volume') return 'dex';
  if (figure.id === 'mcap') return market?.chain ? 'chain' : null;
  if (figure.id === 'liquidity') {
    return chainLiquidity(market, Boolean(figure.sub?.includes('on the curve'))) ? 'chain' : null;
  }
  return null;
}
