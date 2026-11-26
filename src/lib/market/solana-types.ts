import type { ListedPool, MarketStateData, Sourced } from '../contracts';

/**
 * Facts the market zone reads on Solana: the listed market (DexScreener), the
 * launchpad a token came from, its graduation, and what became of the
 * liquidity of its pools. The EVM shapes are kept where they fit; what only
 * Solana has is here.
 */

// ── Market (DexScreener) ────────────────────────────────────────────────────

/** A token named by its address as DexScreener lists it, its symbol when given. */
export type ListedToken = { address: string; symbol: string | null };

/**
 * One of the token's listed pools. `id` is the pool account, case kept as
 * the chain writes it (Solana addresses are case-sensitive). `version` is
 * always `null`: v2/v3/v4 are Uniswap versions.
 */
export type SolanaListedPool = ListedPool & {
  /** DexScreener's venue id: `pumpfun`, `pumpswap`, `raydium`, `meteora`, `orca`, `meteoradbc`… */
  dex: string;
  /** DexScreener's labels for the venue (`CPMM`, `CLMM`, `DLMM`, `DYN2`, `wp`…). */
  labels: string[];
  /** The other side of the pool. */
  pairedWith: ListedToken | null;
};

/**
 * The market state of a Solana token. Same facts as on Robinhood Chain, minus
 * the ETH graduation threshold: a Solana launchpad's graduation is read on
 * chain (`solana/graduation.ts`) and reported in its own block.
 */
export type SolanaMarketStateData = Omit<MarketStateData, 'pools'> & {
  chain: 'solana';
  /** DexScreener's venue of the main pair. */
  dex: string | null;
  /** What the main pair trades against. */
  pairedWith: ListedToken | null;
  /** Price in the paired token, as DexScreener gives it. */
  priceNative: number | null;
  marketCapUsd: number | null;
  /**
   * How many listed pairs `volumeUsd` and `txns` add up: the main pair and
   * every pair where the token is traded against SOL, USDC or USDT. `quiet`
   * is read on every listed pair the token is in. Absent from older reports,
   * whose figures were the main pair's only.
   */
  pairsCounted?: number;
  /**
   * The 24 h volume per trade, USD, over the counted pairs that give both a
   * volume and a trade count: never one pair's volume over every pair's
   * trades. `null` when none gives both. Absent from older reports.
   */
  perTradeUsd24h?: number | null;
  /**
   * Liquidity as a share of the market cap (FDV when DexScreener gives no
   * market cap), 0 to 1 and more: the main pair's liquidity, or the curve's
   * when the token is still on it (`curveLiquidityUsd`). `null` when either
   * is missing. Absent from older reports.
   */
  liquidityToMarketCap?: number | null;
  /**
   * What the token's bonding curve holds, in USD, when the main pair is that
   * curve: its SOL (graduation `raised`) at the SOL price the pair implies
   * (priceUsd / priceNative). DexScreener gives no liquidity for a curve.
   * Absent otherwise.
   */
  curveLiquidityUsd?: number;
  /** The token's listed pools, the most liquid first, the main one among them. */
  pools: SolanaListedPool[];
};

export type SolanaMarketState = Sourced<SolanaMarketStateData>;

// ── Launchpads ──────────────────────────────────────────────────────────────

export type SolanaLaunchpadId = 'pump.fun' | 'meteora-dbc' | 'raydium-launchlab';

export type SolanaLaunchpadRef = { id: SolanaLaunchpadId; name: string; program: string };

export type SolanaLaunchData = {
  mint: string;
  /** `null` when none of the launchpads SEAL reads holds a curve for this mint. */
  launchpad: SolanaLaunchpadRef | null;
  /** The launchpad's account for the token: pump.fun bonding curve, DBC or LaunchLab pool. */
  account: string | null;
  /**
   * How it was found: the launchpad's account read on chain, or the
   * instruction that created the token in its first transaction.
   */
  foundBy: 'curve-account' | 'creation-transaction' | null;
};

export type SolanaLaunch = Sourced<SolanaLaunchData>;

// ── Graduation ──────────────────────────────────────────────────────────────

/** A token amount in raw units (decimal string), with its mint. */
export type RawAmount = {
  /** The mint; `null` for native SOL (lamports, 9 decimals). */
  mint: string | null;
  raw: string;
};

export type SolanaGraduationData = {
  mint: string;
  launchpad: SolanaLaunchpadId;
  /** The curve or pool account read. */
  account: string;
  /** Whether the token left its curve for an open market; `null` when not read. */
  graduated: boolean | null;
  /** From 0 to 1, how far along the curve the token is; `null` when it cannot be measured. */
  progress: number | null;
  /** What progress measures, in plain words, when it is known. */
  progressBasis: 'tokens-sold' | 'quote-raised' | null;
  /** Quote raised on the curve so far, and the target when the launchpad has one. */
  raised: RawAmount | null;
  target: RawAmount | null;
  /**
   * The pool the liquidity moved to, read on chain: `null` while on the curve,
   * or when it could not be found (see the source note).
   */
  destination: { pool: string; program: string; name: string } | null;
  /** pump.fun: the curve says who receives the creator fees. DBC / LaunchLab: the pool's creator. */
  creator: string | null;
};

export type SolanaGraduation = Sourced<SolanaGraduationData>;

// ── Liquidity ───────────────────────────────────────────────────────────────

export type SolanaPoolKind =
  | 'pumpswap'
  | 'raydium-amm-v4'
  | 'raydium-cpmm'
  | 'meteora-damm-v2'
  | 'raydium-clmm'
  | 'orca-whirlpool'
  | 'meteora-dlmm'
  | 'meteora-damm-v1'
  | 'other';

/** Who holds part of a pool's LP tokens. */
export type LpHolder = {
  /** The token account. */
  account: string;
  /** Its owner, as the token account says. */
  owner: string;
  /** Part of the LP the pool counts, from 0 to 1. */
  share: number;
  /**
   * `lock`: Raydium's Burn & Earn lock authority; `burn`: the incinerator;
   * `wallet`: anything else (an address SEAL does not name).
   */
  kind: 'lock' | 'burn' | 'wallet';
};

export type SolanaPoolLiquidity = {
  pool: string;
  /** The program that owns the pool account, read on chain. */
  program: string | null;
  kind: SolanaPoolKind;
  /** The program's name, when SEAL knows it. */
  programName: string | null;
  /** Whether the pool was read and decoded. `false`: the shares below are `null`. */
  known: boolean;
  /**
   * LP pools (PumpSwap, Raydium AMM v4 / CPMM): LP tokens the pool issued
   * that no longer exist (burned outside a withdrawal), from 0 to 1.
   */
  burnedShare: number | null;
  /**
   * Part locked for good: LP held by a lock (Raydium Burn & Earn, the
   * incinerator), or DAMM v2 liquidity locked permanently.
   */
  lockedShare: number | null;
  /** Part that its holders can still withdraw. */
  withdrawableShare: number | null;
  /** The largest LP holders with a balance, when the node lists them (getTokenLargestAccounts). */
  holders: LpHolder[];
  /** DAMM v2: how many positions the pool has; `null` for LP pools (only the largest are listed). */
  holdersCount: number | null;
  /** Why the pool is not known, or what was left out. */
  note: string | null;
};

export type SolanaLiquidityData = { mint: string; pools: SolanaPoolLiquidity[] };

export type SolanaLiquidity = Sourced<SolanaLiquidityData>;

// ── The zone as a whole ─────────────────────────────────────────────────────

/** Everything the market zone reads for a Solana token, each part with its own completeness. */
export type SolanaMarketRead = {
  market: SolanaMarketState;
  launch: SolanaLaunch;
  /**
   * `null` when no launchpad read here holds the token, and also when the
   * launch lookup itself failed: `launch.completeness` tells the two apart
   * (`full` with no launchpad, or `unavailable` with its reason).
   */
  graduation: SolanaGraduation | null;
  liquidity: SolanaLiquidity;
};
