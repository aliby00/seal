export type TxnCounts = { buys: number; sells: number };

/** One of the token's listed pools, as DexScreener lists it. */
export type ListedPool = {
  /** The pool account, case kept (Solana addresses are case-sensitive). */
  id: string;
  /** Uniswap versions on EVM chains; always `null` on Solana. */
  version: 'v2' | 'v3' | 'v4' | null;
  /** The token is the pair's base: DexScreener's prices are of this token. */
  base: boolean;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** When DexScreener says the pool was created, in ms; `null` when not given. */
  createdAt?: number | null;
};

/** The listed market of a token: the main pair's figures, as DexScreener gives them. */
export type MarketStateData = {
  token: string;
  pair: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** The token's own side of the listed pair, in whole tokens; absent when not given. */
  liquidityBase?: number;
  volumeUsd: { m5: number; h1: number; h6: number; h24: number } | null;
  txns: { h1: TxnCounts; h24: TxnCounts } | null;
  fdvUsd: number | null;
  pairCreatedAt: string | null;
  /**
   * How long since the last trade, at least: no trade in the last `hours`,
   * from the pair's trade counts per window. `null` when a trade came in the
   * last five minutes; absent when unknown.
   */
  quiet?: { hours: number } | null;
  /** The token's listed pools, the most liquid first, the main one (`pair`) among them. */
  pools?: ListedPool[];
};
