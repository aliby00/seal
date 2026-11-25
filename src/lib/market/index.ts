import type { ListedPool, MarketStateData } from '../contracts';
import type { DexScreenerPair } from './dexscreener';

export { SOLANA_SLUG, solanaTokenPairsUrl } from './dexscreener';
export type { DexScreenerPair } from './dexscreener';

/**
 * What any listed market says, whatever its chain: the main pair, how quiet
 * it is, which pools count. The Solana reading itself is `solana.ts`.
 */

/**
 * Choisit la paire la plus pertinente quand un token en a plusieurs.
 * On retient la plus liquide : c'est celle où le prix affiché veut dire
 * quelque chose, et celle que les acheteurs verront.
 */
export function pickPrimaryPair(pairs: DexScreenerPair[]): DexScreenerPair | undefined {
  if (pairs.length === 0) return undefined;
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

const WINDOWS = ['m5', 'h1', 'h6', 'h24'] as const;

/**
 * No trade in the last N hours, from trade counts per window (one pair's, or
 * every listed pair's added up): the longest window with no trade at all.
 * `null` when no window is quiet.
 *
 * A window counts as quiet only when no window inside it shows a trade or a
 * volume: DexScreener's windows can disagree. USDC's main pair showed 0
 * trades in the last hour beside 133,953 over 24 h while its pool was swapped
 * in many times that hour (read on chain, 25/11/2026).
 */
export function quietFor(
  source: DexScreenerPair['txns'],
  volume?: DexScreenerPair['volume'],
): { hours: number } | null {
  const trades = (window: string) => {
    const t = source?.[window];
    return t ? (t.buys ?? 0) + (t.sells ?? 0) : null;
  };
  const busy = (window: (typeof WINDOWS)[number]) =>
    (trades(window) ?? 0) > 0 || (volume?.[window] ?? 0) > 0;
  for (const [window, hours] of [
    ['h24', 24],
    ['h6', 6],
    ['h1', 1],
  ] as const) {
    if (trades(window) !== 0) continue;
    if (WINDOWS.slice(0, WINDOWS.indexOf(window) + 1).some(busy)) continue;
    return { hours };
  }
  return null;
}

/**
 * Where the trade counts and volume come from, in a few words: "on its main
 * pair", "on 26 of its listed pairs". `undefined` (a report from before the
 * counts were added up): "on its main pair", which is what they were.
 */
const DEX_NAMES: Record<string, string> = {
  pumpfun: 'pump.fun',
  pumpswap: 'PumpSwap',
  pancakeswap: 'PancakeSwap',
  meteora: 'Meteora',
  meteoradbc: 'Meteora DBC',
  raydium: 'Raydium',
  orca: 'Orca',
};

/** "pump.fun", "PancakeSwap": DexScreener's venue id as a reader knows it; an unknown id as is. */
export function dexName(id: string): string {
  return DEX_NAMES[id] ?? id;
}

export function pairsWords(pairsCounted: number | undefined): string {
  return pairsCounted === undefined || pairsCounted <= 1
    ? 'on its main pair'
    : `on ${pairsCounted.toLocaleString('en-US')} of its listed pairs`;
}

/** Pools kept per report, the most liquid first. */
export const MAX_LISTED_POOLS = 12;
/**
 * A pool beside the main one counts when it holds at least this much, and
 * at least MEANINGFUL_POOL_SHARE of the main pool. Dust pools anyone can
 * open do not.
 */
export const MEANINGFUL_POOL_USD = 1_000;
export const MEANINGFUL_POOL_SHARE = 0.02;

/** The main pool: the listed pair the market state is read from. */
export function mainPool(
  market: Pick<MarketStateData, 'pair' | 'pools'> | undefined,
): ListedPool | null {
  if (!market?.pair) return null;
  // A Solana id keeps its case (base58 is case-sensitive).
  const pair = market.pair;
  return market.pools?.find((p) => p.id === pair) ?? null;
}

/** The pools beside the main one with liquidity enough to be traded in, where the token is the base. */
export function meaningfulPools(
  market: Pick<MarketStateData, 'pair' | 'pools'> | undefined,
): ListedPool[] {
  if (!market?.pools) return [];
  const main = mainPool(market);
  const floor = Math.max(MEANINGFUL_POOL_USD, (main?.liquidityUsd ?? 0) * MEANINGFUL_POOL_SHARE);
  return market.pools.filter((p) => p.base && p.id !== main?.id && (p.liquidityUsd ?? 0) >= floor);
}

/** "8xKZ…CLRx": a pool named short, as the report names pairs. */
export function poolLabel(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** "$186.4k", "$1.2M", "$2.3B": a pool's liquidity in a few characters. */
export function usdShort(x: number): string {
  if (x >= 999_950_000) return `$${(x / 1_000_000_000).toFixed(1)}B`;
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `$${(x / 1_000).toFixed(1)}k`;
  return `$${Math.round(x)}`;
}

/**
 * Rapport volume / nombre d'échanges sur 24 h.
 *
 * Le whitepaper veut distinguer un volume réel d'un aller-retour entre deux
 * wallets. 485 $ sur 7 échanges (69 $ par échange) ne raconte pas la même
 * histoire que 485 $ sur 200 échanges. On expose le ratio brut : c'est à
 * l'agent d'en tirer une lecture, pas à nous.
 */
export function volumePerTrade(state: {
  data: Pick<MarketStateData, 'volumeUsd' | 'txns'>;
}): number | null {
  const volume = state.data.volumeUsd?.h24;
  const counts = state.data.txns?.h24;
  if (volume === undefined || !counts) return null;
  const trades = counts.buys + counts.sells;
  return trades === 0 ? null : volume / trades;
}
