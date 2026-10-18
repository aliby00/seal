import type { MarketState, MarketStateData, TxnCounts } from '../contracts';
import { NotFoundError, UpstreamError } from '../errors';
import { requestJson, type RequestBudget } from '../http';
import { tokenPairsUrl, type DexScreenerPair } from './dexscreener';

export { ROBINHOOD_SLUG, tokenPairsUrl } from './dexscreener';
export type { DexScreenerPair } from './dexscreener';

/** État de graduation, lu on-chain par `lib/chain` et injecté ici par l'orchestrateur. */
export type GraduationInput = {
  thresholdEth: number;
  pairedEth: number;
  graduated: boolean;
};

export type FetchMarketOptions = {
  budget?: RequestBudget;
  baseUrl?: string;
  graduation?: GraduationInput;
  now?: () => Date;
};

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function txns(source: DexScreenerPair['txns'], window: string): TxnCounts {
  const entry = source?.[window];
  return { buys: entry?.buys ?? 0, sells: entry?.sells ?? 0 };
}

/**
 * Choisit la paire la plus pertinente quand un token en a plusieurs.
 * On retient la plus liquide : c'est celle où le prix affiché veut dire
 * quelque chose, et celle que les acheteurs verront.
 */
export function pickPrimaryPair(pairs: DexScreenerPair[]): DexScreenerPair | undefined {
  if (pairs.length === 0) return undefined;
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

export function toMarketState(
  token: string,
  pairs: DexScreenerPair[],
  options: FetchMarketOptions = {},
): MarketState {
  const now = (options.now ?? (() => new Date()))();
  const fetchedAt = now.toISOString();
  // Only pairs where this token is the base: when it is the quote side, the
  // price DexScreener gives is the other token's.
  const pair = pickPrimaryPair(
    pairs.filter((p) => p.baseToken?.address?.toLowerCase() === token.toLowerCase()),
  );
  const grad = options.graduation;

  const graduation: MarketStateData['graduation'] = grad
    ? {
        thresholdEth: grad.thresholdEth,
        // Borné à 1 : un pool au-delà du seuil resterait à 100 %, pas 137 %.
        progress: grad.thresholdEth > 0 ? Math.min(1, grad.pairedEth / grad.thresholdEth) : 0,
        graduated: grad.graduated,
      }
    : null;

  // Aucune paire indexée n'est un état normal pour un token de quelques minutes,
  // pas une erreur. On le signale comme tel plutôt que d'échouer.
  if (!pair) {
    return {
      completeness: 'unavailable',
      sources: [
        {
          name: 'dexscreener',
          fetchedAt,
          note: 'no pair indexed by DexScreener for this token',
        },
      ],
      data: {
        token,
        pair: null,
        priceUsd: null,
        liquidityUsd: null,
        pairedEth: grad?.pairedEth ?? null,
        graduation,
        volumeUsd: null,
        txns: null,
        fdvUsd: null,
        pairCreatedAt: null,
      },
    };
  }

  const data: MarketStateData = {
    token,
    pair: pair.pairAddress ?? null,
    priceUsd: num(pair.priceUsd),
    liquidityUsd: num(pair.liquidity?.usd),
    ...(num(pair.liquidity?.base) !== null ? { liquidityBase: num(pair.liquidity?.base)! } : {}),
    // `liquidity.quote` is in the pair's quote token, which need not be ETH.
    pairedEth: grad?.pairedEth ?? null,
    graduation,
    volumeUsd: pair.volume
      ? {
          m5: pair.volume.m5 ?? 0,
          h1: pair.volume.h1 ?? 0,
          h6: pair.volume.h6 ?? 0,
          h24: pair.volume.h24 ?? 0,
        }
      : null,
    txns: pair.txns ? { h1: txns(pair.txns, 'h1'), h24: txns(pair.txns, 'h24') } : null,
    fdvUsd: num(pair.fdv ?? pair.marketCap),
    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
    ...(pair.txns ? { quiet: quietFor(pair.txns) } : {}),
  };

  // Le prix et la liquidité sont le minimum vital ; sans eux la vue est partielle.
  const complete = data.priceUsd !== null && data.liquidityUsd !== null;

  return {
    completeness: complete ? 'full' : 'partial',
    sources: [
      {
        name: 'dexscreener',
        fetchedAt,
        ...(complete ? {} : { note: 'price or liquidity missing from the response' }),
      },
    ],
    data,
  };
}

/** The token's pairs as DexScreener lists them. Throws only when the source is plainly broken. */
export async function fetchPairs(
  token: string,
  options: Pick<FetchMarketOptions, 'budget' | 'baseUrl'> = {},
): Promise<DexScreenerPair[]> {
  const url = tokenPairsUrl(token, options.baseUrl);
  const body = await requestJson<unknown>(url, {
    source: 'dexscreener',
    budget: options.budget,
  });

  if (body === null) throw new NotFoundError('dexscreener', `token ${token}`);
  if (!Array.isArray(body)) {
    throw new UpstreamError('dexscreener', 'unexpected response: expected an array');
  }
  return body as DexScreenerPair[];
}

/**
 * No trade in the last N hours, from the pair's counts per window: the
 * longest window with no trade at all. `null` when the last five minutes
 * had one, or no window is quiet.
 */
export function quietFor(source: DexScreenerPair['txns']): { hours: number } | null {
  const trades = (window: string) => {
    const t = source?.[window];
    return t ? (t.buys ?? 0) + (t.sells ?? 0) : null;
  };
  for (const [window, hours] of [
    ['h24', 24],
    ['h6', 6],
    ['h1', 1],
  ] as const) {
    if (trades(window) === 0) return { hours };
  }
  return null;
}

/** Under this part of the supply in its pools, a token's listed liquidity may not be current. */
export const STALE_POOLS_SHARE = 0.01;
/**
 * …and it is not when the pools hold under this part of the tokens the
 * listed pair says it has. A token whose market cap dwarfs its liquidity can
 * have under 1 % of its supply in a pool and still be traded there: only a
 * pool emptier than its listing says is a listing out of date.
 */
export const STALE_BASE_RATIO = 0.1;

/**
 * The listed liquidity checked against what the token's pools hold today. A
 * removal is on chain at once; DexScreener's figure can lag it by hours.
 */
export function checkLiquidity(
  market: MarketState,
  pools: { share: number; tokens: number } | null,
): MarketState {
  if (pools === null || market.data.liquidityUsd === null) return market;
  const base = market.data.liquidityBase ?? null;
  const current = !(
    pools.share < STALE_POOLS_SHARE &&
    (base === null || pools.tokens < base * STALE_BASE_RATIO)
  );
  const pct = (x: number) => `${(x * 100).toFixed(x < 0.001 ? 4 : 2)}%`;
  return {
    ...market,
    completeness: current ? market.completeness : 'partial',
    sources: current
      ? market.sources
      : [
          ...market.sources,
          {
            name: 'robinhood-rpc',
            fetchedAt: market.sources[0]?.fetchedAt ?? new Date().toISOString(),
            note: `the token’s pools hold ${pct(pools.share)} of its supply on chain today${base !== null ? `, where the listed pair counts ${Math.round(base).toLocaleString('en-US')} tokens` : ''}: the liquidity DexScreener lists is not current`,
          },
        ],
    data: { ...market.data, liquidityCheck: { poolsShare: pools.share, current } },
  };
}

/** Récupère l'état du marché. Ne lève que si la source est franchement cassée. */
export async function fetchMarketState(
  token: string,
  options: FetchMarketOptions = {},
): Promise<MarketState> {
  return toMarketState(token, await fetchPairs(token, options), options);
}

/**
 * Where a token trades, from its listed pairs: V2/V3 pair contracts, and v4
 * market ids (a 32-byte id rather than an address). A pair where the token is
 * on either side is a place its tokens sit.
 */
export function venuesOf(
  token: string,
  pairs: readonly DexScreenerPair[],
): { pools: string[]; v4Markets: string[] } {
  const own = token.toLowerCase();
  const pools = new Set<string>();
  const v4Markets = new Set<string>();
  for (const pair of pairs) {
    const sides = [pair.baseToken?.address, pair.quoteToken?.address].map((a) => a?.toLowerCase());
    if (!sides.includes(own)) continue;
    const address = pair.pairAddress?.toLowerCase() ?? '';
    if (/^0x[0-9a-f]{64}$/.test(address)) v4Markets.add(address);
    else if (/^0x[0-9a-f]{40}$/.test(address)) pools.add(address);
  }
  return { pools: [...pools], v4Markets: [...v4Markets] };
}

/**
 * Rapport volume / nombre d'échanges sur 24 h.
 *
 * Le whitepaper veut distinguer un volume réel d'un aller-retour entre deux
 * wallets. 485 $ sur 7 échanges (69 $ par échange) ne raconte pas la même
 * histoire que 485 $ sur 200 échanges. On expose le ratio brut : c'est à
 * l'agent d'en tirer une lecture, pas à nous.
 */
export function volumePerTrade(state: MarketState): number | null {
  const volume = state.data.volumeUsd?.h24;
  const counts = state.data.txns?.h24;
  if (volume === undefined || !counts) return null;
  const trades = counts.buys + counts.sells;
  return trades === 0 ? null : volume / trades;
}
