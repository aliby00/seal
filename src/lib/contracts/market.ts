import type { Sourced } from './completeness';

export type TxnCounts = { buys: number; sells: number };

/** Trades in one window, counted from a pool's own swaps. */
export type PoolActivityWindow = {
  buys: number;
  sells: number;
  /** Distinct addresses that signed the trades. */
  traders: number;
  /** Amount traded on the pair-token side, in its smallest unit (wei for WETH). */
  volume: string;
  lastTradeAt: string | null;
};

/**
 * Trading counted by the SEAL indexer from the launch pool's own swaps, for a
 * pons token that no listed pair covers. There is no price here: only counts,
 * and volume in the pair token.
 */
export type PoolActivity = {
  source: 'indexer';
  pool: string;
  pairToken: string;
  /** Swaps are read from this time on; nothing earlier is counted. */
  coveredFrom: string | null;
  /** Last block the indexer had read. */
  indexedTo: number;
  h1: PoolActivityWindow;
  h24: PoolActivityWindow;
  d7: PoolActivityWindow;
  sinceLaunch: PoolActivityWindow & { complete: boolean };
  creatorTraded: boolean;
  /**
   * The creator's own swaps in the pool, by direction. Absent from reports
   * made before: "traded" alone let the text say the creator traded "though
   * the data does not say in which direction" (GNRG).
   */
  creatorTrades?: { buys: number; sells: number };
};

/**
 * One of the token's listed pools, as DexScreener lists it, with the trading
 * rules (hook) of a Uniswap v4 pool read from its `Initialize`. The checks
 * of a market's rules read the main pool (the most liquid one where the
 * token is the base) and weigh every other pool: BOOMER's largest pool runs
 * a hook while a small pool beside it runs none, and reading the small one
 * said "no contract sits between a sell and the pool" (staging, 18/10/2026).
 */
export type ListedPool = {
  /** A v2/v3 pair address, or a v4 pool id (32 bytes). */
  id: string;
  version: 'v2' | 'v3' | 'v4' | null;
  /** The token is the pair's base: DexScreener's prices are of this token. */
  base: boolean;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** When DexScreener says the pool was created, in ms; `null` when not given. */
  createdAt?: number | null;
  /**
   * v4 only: the pool's `Initialize`, read from the PoolManager (its hook is
   * the zero address when it runs none). `null` when it could not be read;
   * absent for a v2/v3 pair.
   */
  v4?: {
    hook: string;
    currency0: string;
    currency1: string;
    fee: number;
    tickSpacing: number;
    blockNumber: number;
    transactionHash: string;
  } | null;
};

export type MarketStateData = {
  token: string;
  pair: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** The token's own side of the listed pair, in whole tokens; absent when not given. */
  liquidityBase?: number;
  /** ETH immobilisé dans le pool — c'est ce que compte la graduation. */
  pairedEth: number | null;
  graduation: {
    /** Seuil en ETH. 4,2 au moment de la vérification, lu on-chain et non codé en dur. */
    thresholdEth: number;
    progress: number;
    graduated: boolean;
  } | null;
  volumeUsd: { m5: number; h1: number; h6: number; h24: number } | null;
  txns: { h1: TxnCounts; h24: TxnCounts } | null;
  fdvUsd: number | null;
  pairCreatedAt: string | null;
  /** Present only when the indexer counted the launch pool's trades. */
  activity?: PoolActivity;
  /**
   * How long since the last trade, at least: no trade in the last `hours`,
   * from the pair's trade counts per window (or the indexer's last trade).
   * `null` when a trade came in the last five minutes; absent when unknown.
   */
  quiet?: { hours: number } | null;
  /**
   * The listed liquidity checked against the chain: the part of the supply
   * the token's pools hold today. Under 1 %, the figure DexScreener gives is
   * not current (MOON: 100 % of the liquidity removed 25 minutes after
   * launch, $61.9k still listed), and it is not shown as liquidity.
   */
  liquidityCheck?: { poolsShare: number; current: boolean };
  /**
   * The token's listed pools, the most liquid first, the main one (`pair`)
   * among them. Absent from reports made before, or when no pair is listed.
   */
  pools?: ListedPool[];
};

export type MarketState = Sourced<MarketStateData>;
