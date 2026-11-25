import type { Completeness } from './completeness';
import type {
  SolanaCreator,
  SolanaCreatorHistory,
  SolanaCreatorOnToken,
  SolanaLinkedWallets,
} from '../solana/creator-types';
import type { SolanaHolders } from '../solana/holders';
import type { SolanaLaunchReplay } from '../solana/launch-types';
import type { TokenPower, TokenRead } from '../solana/token-types';
import type {
  SolanaGraduation,
  SolanaLaunch,
  SolanaLiquidity,
  SolanaMarketState,
} from '../market/solana-types';

/**
 * A read that failed this time (a rate limit, a timeout, a call or time cap,
 * a node that did not answer): what it would have found is unknown, never
 * absent.
 *
 * - `token`: the mint itself (supply, authorities, extensions, metadata);
 * - `creator`: who created the token;
 * - `creator-launches`: the creator's other tokens;
 * - `creator-sales`: what the creator bought, sold, sent and holds of this token;
 * - `linked-wallets`: who funded the creator, and the wallets it funded around the launch;
 * - `launch-replay`: the first transactions after the creation;
 * - `holders`: the holders list;
 * - `market`: the token's listed trading (DexScreener);
 * - `liquidity`: what the token's pools hold, and who can withdraw it;
 * - `graduation`: the launchpad that holds the token, and its progress on the curve.
 */
export type ReadId =
  | 'token'
  | 'creator'
  | 'creator-launches'
  | 'creator-sales'
  | 'linked-wallets'
  | 'launch-replay'
  | 'holders'
  | 'market'
  | 'liquidity'
  | 'graduation'
  /** Some of the ten questions did not finish in time, or could not be answered. */
  | 'questions';

export type FailedRead = { read: ReadId; note: string };

/**
 * What the data pipeline hands the reasoning agent, for one Solana token.
 *
 * No verdict, no score, no aggregate: blocks of facts, each with its own
 * sources and completeness (`Sourced<T>`). A block that could not be read is
 * `unavailable` with its reason in `sources[].note`, never left out and never
 * read as "nothing". Addresses keep their case (base58 is case-sensitive).
 * Amounts are raw units as decimal strings; shares are fractions from 0 to 1.
 */
export type TokenReport = {
  chain: 'solana';
  /** The mint address, as asked. */
  token: string;
  collectedAt: string;

  /**
   * The mint, decoded from its own bytes (solana/token.ts): token program,
   * supply, decimals, mint and freeze authorities, every Token-2022
   * extension, and the metadata (name, symbol, uri, who can change them).
   * `data` is `null` when the mint could not be read (`unavailable`).
   */
  mint: TokenRead;
  /**
   * What the mint lets someone do to the token or its holders, one plain
   * sentence each, with who holds the power (`tokenPowers`). Empty when the
   * mint was not read.
   */
  powers: TokenPower[];

  /**
   * Who created the token: the `creator` field of its pump.fun curve, else
   * the fee payer of the mint's creation transaction, else its metadata's
   * update authority (`data.from` says which). `data.creator` is `null` when
   * nothing on the chain names one.
   */
  creator: SolanaCreator;
  /** The creator's other tokens and what became of each; `null` when no creator is known. */
  creatorHistory: SolanaCreatorHistory | null;
  /** What the creator bought, sold, sent, locked and holds of this token; `null` without a creator. */
  creatorOnToken: SolanaCreatorOnToken | null;
  /**
   * Who first funded the creator with SOL, and the wallets it sent SOL to
   * around the launch, with what they did with the token; `null` without a
   * creator. Transfers only: who controls an address is never said.
   */
  linkedWallets: SolanaLinkedWallets | null;

  /**
   * The holders, read from the token accounts and grouped by owner, each
   * owner named for what the chain shows (wallet, curve, pool, lock, burn,
   * program account). Shares on what circulates (`top`, `concentration`)
   * and on the whole supply (`ofSupply`, `setAside`).
   */
  holders: SolanaHolders;

  /** The listed market, as DexScreener gives it (price, liquidity, volume, trades, pools). */
  market: SolanaMarketState;
  /** The launchpad whose curve or pool holds the token (pump.fun, Meteora DBC, Raydium LaunchLab), when one does. */
  launchpad: SolanaLaunch;
  /** The token's graduation from that launchpad's curve; `null` when no launchpad read here holds it. */
  graduation: SolanaGraduation | null;
  /** What became of the liquidity of the token's main pools: burned, locked, withdrawable, by pool type. */
  liquidity: SolanaLiquidity;

  /**
   * The first transactions after the creation, replayed from their balance
   * changes (`data.creation` is `null` when the creation was not found).
   * Not part of the overall completeness: a missing replay leaves the other
   * blocks as complete as they were.
   */
  launch: SolanaLaunchReplay;

  /** The weakest of the mint, the creator, the holders and the market. */
  completeness: Completeness;
  /**
   * The reads that failed this time. Each absence they would have settled is
   * unknown: never said, never cached. Absent or empty when every read answered.
   */
  failedReads?: FailedRead[];
};

export type { Completeness };
