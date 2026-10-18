import type { Sourced } from './completeness';

/**
 * Where the supply went in the first minutes of a token's life, move by move.
 *
 * Every move is a fact read from the token's own `Transfer` events. Nothing is
 * labelled sniper, insider or bundle: a wallet that bought in the launch block
 * is shown as having bought in the launch block, and the reader judges.
 */
export type LaunchMoveKind =
  /** Supply created and handed to its first holder. */
  | 'mint'
  /** Supply passed from one holder to another, outside any pool. */
  | 'allocation'
  /** Tokens taken out of a pool: a purchase. */
  | 'buy'
  /** Tokens put back into a pool: a sale. */
  | 'sell'
  /** Tokens put into a pool as liquidity, in a transaction where nothing was traded. */
  | 'provide'
  /** Tokens taken out of a pool's liquidity, in a transaction where nothing was traded. */
  | 'withdraw';

export type LaunchMove = {
  kind: LaunchMoveKind;
  /** Seconds since the launch block. */
  seconds: number;
  /** Blocks since the launch block (0 = the launch block itself). */
  block: number;
  /** The address the move is about: who received, bought or sold. */
  actor: string;
  /** The other side: the sender, or the pool. */
  counterparty: string;
  actorKind: 'wallet' | 'contract' | 'pool' | 'burn';
  /** Part of the supply moved, from 0 to 1. */
  share: number;
  actorIsCreator: boolean;
  counterpartyIsCreator: boolean;
  /** Part of the supply the actor holds today, `null` when it could not be read. */
  heldNow: number | null;
  transaction: string;
};

/** Buys in this many seconds count as "the first buyers". */
export const EARLY_SECONDS = 60;
/** Addresses served by one transaction before it reads as "bought together". */
export const BUNDLE_MIN_WALLETS = 3;

/**
 * The launch's totals, counted over EVERY transfer read in the window — not
 * over the moves kept for the drawing. Counting the forty moves shown made one
 * transaction serving 100 wallets and 87.5 % of the supply read as 35 wallets
 * and 32 %.
 */
export type LaunchSummary = {
  /** Moves counted, the same as `movesInWindow`. */
  moves: number;
  /** Seconds that make "the first buyers". */
  earlySeconds: number;
  /** What the creator received or bought in the launch block itself, share of supply. */
  creatorAtLaunch: number;
  /** What the creator bought in the window, share of supply. */
  creatorBought: number;
  /** Creator sales in the window, share of supply. */
  creatorSold: number;
  /** Seconds of the creator's first buy and last sale in the window, when there are some. */
  creatorFirstBuyAt: number | null;
  creatorLastSaleAt: number | null;
  /** A creator sale in the window whose receipt shows a trade. Absent from older replays. */
  creatorSaleConfirmed?: boolean;
  /**
   * What the launch block's transactions sent by the creator delivered to
   * other addresses than the creator's (MUT8: 71.4 % to three contracts in
   * the creator's own launch transaction). Linked to the creator by that
   * transaction; who controls those addresses is not shown. Absent from
   * older replays; `null` when there was none.
   */
  creatorTx?: {
    transaction: string;
    addresses: number;
    share: number;
    /** What they hold today, capped at what they received; `null` when unread. */
    heldNow: number | null;
    /** How many of them are contracts; `null` when not read. */
    contracts: number | null;
    /**
     * The size of each contract's code, in bytes (MUT8: three of 45, minimal
     * proxies). Absent from older replays, or when not read.
     */
    codeSizes?: number[];
  } | null;
  early: {
    /** Distinct addresses (not the creator) whose first buy came within `earlySeconds`. */
    wallets: number;
    /** What they bought within `earlySeconds`, share of supply. */
    share: number;
    /** When the last of those buys came. */
    within: number;
    /** What they hold today, capped at what they bought; `null` when none could be read. */
    heldNow: number | null;
    /** How many of them were not read (beyond the cap, or a refused read). */
    unread: number;
    /** How many of them are contracts rather than wallets; `null` when not read. */
    contracts: number | null;
  };
  /**
   * The transaction that delivered the largest purchase to several addresses
   * at once (at least three), counted over all its transfers.
   */
  bundle: {
    transaction: string;
    wallets: number;
    share: number;
    seconds: number;
    heldNow: number | null;
    unread: number;
    contracts: number | null;
  } | null;
  /** Receipts read to tell trades from liquidity changes, of those wanted. */
  receiptsRead: number;
  receiptsWanted: number;
  /** Balances read today, of those wanted. */
  balancesRead: number;
  balancesWanted: number;
};

export type LaunchReplayData = {
  token: string;
  launchBlock: number;
  launchedAt: string | null;
  /** Length of the window read, in seconds. */
  windowSeconds: number;
  /** Supply the shares are measured against. */
  supply: string;
  moves: LaunchMove[];
  /** Moves in the window, including any beyond those listed. */
  movesInWindow: number;
  /** Totals over every move read. Absent from replays cached before it existed. */
  summary?: LaunchSummary;
};

export type LaunchReplay = Sourced<LaunchReplayData>;
