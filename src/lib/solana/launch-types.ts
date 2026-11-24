import type { Sourced } from '../contracts/completeness';
import type { LaunchMove, LaunchSummary } from '../contracts/launch';

/**
 * The first transactions of a Solana token, replayed. The shape follows the
 * EVM launch replay (`contracts/launch.ts`): the same moves, the same
 * summary, plus what only Solana shows — slots, fee payers, the asset a trade
 * was paid in — and a short story told in order.
 *
 * Nothing is labelled sniper, insider or bundle: a wallet that bought in the
 * creation slot is shown as having bought in the creation slot.
 */

/** What a trade cost or brought the wallet, in the asset the market traded. */
export type SolanaQuote = {
  /** `SOL` (lamports and wrapped SOL together), or the mint of the quote token. */
  asset: string;
  /** Raw units, as a decimal string, always positive. */
  amount: string;
  decimals: number;
};

export type SolanaLaunchMove = LaunchMove & {
  /** Raw units moved, as a decimal string. */
  amount: string;
  /** The transaction's slot (`block` is the slot counted from the creation slot). */
  slot: number;
  /** Who paid the transaction's fee: its first signer. */
  payer: string;
  /**
   * What the actor paid for a buy, or received for a sale, in that
   * transaction. In SOL, fees, tips and account rent are included; `null`
   * when the actor's balance did not move that way.
   */
  quote: SolanaQuote | null;
};

/** Wallets that got tokens together: in the creation slot, or from one fee payer. */
export type SolanaLaunchGroup = {
  wallets: number;
  /** What they got, share of the supply. */
  share: number;
  transactions: number;
  /** What they hold today in the token accounts they used, capped at what they got; `null` when not read. */
  heldNow: number | null;
  /** How many of them were not read today. */
  unread: number;
  /** How many of them sold in the window read. */
  soldInWindow: number;
  /** SOL their own accounts spent in those transactions, fees included. */
  solSpent: number;
  /** The first twenty, by what they got. */
  addresses: string[];
};

export type SolanaRoundTrip = {
  address: string;
  /** Seconds and slots from the creation to the first buy, and to the first sale after it. */
  boughtAt: number;
  soldAt: number;
  boughtSlot: number;
  soldSlot: number;
  /** What it bought in the window read, and what it sold after its first buy there, share of the supply. */
  bought: number;
  sold: number;
};

export type SolanaLaunchStoryLine = {
  seconds: number;
  /** Slots since the creation slot. */
  slot: number;
  text: string;
  transaction?: string;
};

export type SolanaLaunchCreation = {
  signature: string;
  slot: number;
  launchedAt: string | null;
  /** The fee payer of the creation transaction. */
  payer: string;
  /** Every signer of it (the mint's own key usually among them). */
  signers: string[];
  /**
   * How it was found: given by the caller, as the oldest transaction of the
   * creator's token account, as the oldest of the mint's whole history, or
   * as the oldest before a block found from the creation time given.
   */
  foundBy: 'given' | 'creator-account' | 'history' | 'creation-time';
};

export type SolanaLaunchReplayData = {
  chain: 'solana';
  token: string;
  /** The program owning the mint; `null` when the mint could not be read. */
  tokenProgram: string | null;
  decimals: number | null;
  /**
   * Supply the shares are measured against, raw units: today's, or what the
   * transactions read created when that is more (tokens burned since).
   */
  supply: string | null;
  creation: SolanaLaunchCreation | null;
  /** The creation slot, as the EVM replay's launch block. */
  launchBlock: number | null;
  launchedAt: string | null;
  /** Seconds and slots from the creation to the last transaction read. */
  windowSeconds: number;
  windowSlots: number;
  /** The moves listed: every move of the creator, the largest, then the earliest. */
  moves: SolanaLaunchMove[];
  /** Moves in the window, all counted in the summary. */
  movesInWindow: number;
  summary: LaunchSummary | null;
  /** Wallets other than the creator that got tokens in the creation slot. */
  sameSlot: SolanaLaunchGroup | null;
  /**
   * Wallets other than the creator that got tokens in transactions paid by
   * the creation's fee payer or by the creator.
   */
  payerGroup: (SolanaLaunchGroup & { payers: string[] }) | null;
  /** Wallets that bought and then sold in the window, with slots and sizes. */
  roundTrips: SolanaRoundTrip[];
  transactions: {
    /** Transactions of the window wanted (the creation included). */
    wanted: number;
    read: number;
    /** Failed transactions in the window: they moved nothing and were not read. */
    failed: number;
    /** Read, but changed no balance of this token (account set-up, bots' no-ops). */
    withoutChange: number;
    /** Signatures of the token known after the creation, beyond those wanted. */
    beyond: number;
    /** Whether every transaction after the creation was seen (a young or quiet token). */
    wholeHistory: boolean;
  };
  /** RPC calls this replay spent. */
  calls: number;
  story: SolanaLaunchStoryLine[];
};

export type SolanaLaunchReplay = Sourced<SolanaLaunchReplayData>;
