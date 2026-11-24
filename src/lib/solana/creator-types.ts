import type { Sourced } from '../contracts/completeness';
import type { CreatorSends } from '../contracts/creator';

/**
 * What SEAL reads of a Solana token's creator. The EVM blocks keep their
 * shapes (contracts/creator.ts); these are the Solana ones, built on the same
 * envelope: every result carries its sources and its completeness, and a
 * note says what was not read.
 *
 * Amounts are raw token units or lamports, as decimal strings; shares are
 * fractions of the supply, rounded to six places.
 */

/**
 * Where the creator was read, in the order it is looked for:
 * - `pump-curve`: the `creator` field of the token's pump.fun bonding curve;
 * - `creation-transaction`: the fee payer of the transaction that initialised
 *   the mint (a launch contract or a relayer can pay it: not proof of authorship);
 * - `metadata-update-authority`: who may edit the token's metadata (Metaplex
 *   account, or Token-2022 `tokenMetadata`): the creator's choice at launch,
 *   often a team or a service, never proof of authorship.
 */
export type SolanaCreatorSource =
  'pump-curve' | 'creation-transaction' | 'metadata-update-authority';

/** How a creation was recognised in a transaction. */
export type SolanaCreationInstruction =
  'pump-create' | 'pump-create-v2' | 'initialize-mint' | 'initialize-mint2';

/** The transaction that created a mint. */
export type SolanaCreation = {
  signature: string;
  slot: number;
  /** Unix seconds; `null` when the node did not give it. */
  blockTime: number | null;
  /** The first signer, who paid the fees. */
  feePayer: string;
  instruction: SolanaCreationInstruction;
  /** The launchpad whose instruction created it (`pump.fun`), `null` for a plain mint. */
  launchpad: string | null;
  /** Name and symbol the launch instruction set, when it sets them (pump.fun). */
  name?: string;
  symbol?: string;
};

export type SolanaCreatorData = {
  mint: string;
  /** `null` when nothing on the chain named one. */
  creator: string | null;
  from: SolanaCreatorSource | null;
  /** The account the creator was read from (curve, metadata, mint), or `null`. */
  account: string | null;
  /** `null` when the mint's first transaction was not reached or not recognised. */
  creation: SolanaCreation | null;
  /** The mint's pump.fun curve, when it has one: `complete` is its graduation. */
  pumpCurve: { address: string; complete: boolean } | null;
};

export type SolanaCreator = Sourced<SolanaCreatorData>;

/**
 * What became of one of the creator's tokens:
 * - `graduated`: its pump.fun curve is complete (says nothing of its quality);
 * - `dead`: launched more than a day ago, and no trade in the last 24 hours
 *   on any market DexScreener lists for it;
 * - `active`: traded in the last 24 hours;
 * - `unknown`: not listed by DexScreener, launch time not known, or younger
 *   than a day without a trade.
 */
export type SolanaTokenOutcome = 'graduated' | 'dead' | 'active' | 'unknown';

export type SolanaLaunchedToken = {
  mint: string;
  /** `pump.fun`, or `null` for a mint created outside a known launchpad. */
  launchpad: string | null;
  name?: string;
  symbol?: string;
  /** The creation, when it was among the transactions read. */
  signature: string | null;
  slot: number | null;
  /** ISO time of the launch: creation transaction, else the pump.fun market DexScreener lists. */
  launchedAt: string | null;
  /** The pump.fun curve, when there is one. */
  curve: string | null;
  outcome: SolanaTokenOutcome;
  /** Trades in the last 24 hours on DexScreener's markets; `null` when not listed or not read. */
  trades24h: number | null;
  /** How the token was found: the curves naming the creator, the creator's own transactions. */
  foundBy: ('pump-curves' | 'creator-transactions')[];
};

export type SolanaCreatorHistoryData = {
  creator: string;
  /** The analysed token is not among them. */
  tokens: SolanaLaunchedToken[];
  counts: {
    launched: number;
    graduated: number;
    dead: number;
    active: number;
    unknown: number;
  };
  /** What was read to list them. */
  scanned: {
    /** Every pump.fun curve whose `creator` field is this address was listed. */
    pumpCurvesListed: boolean;
    /** pump.fun curves naming the creator whose mint could not be told. */
    curvesWithoutMint: number;
    /** The creator's signatures listed, and whether that reaches its first. */
    signatures: number;
    signaturesComplete: boolean;
    /** Of its successful transactions listed, how many were read. */
    transactionsListed: number;
    transactionsRead: number;
    /** Unix seconds of the oldest transaction read; `null` when none. */
    readSince: number | null;
  };
};

export type SolanaCreatorHistory = Sourced<SolanaCreatorHistoryData>;

/** One transaction in which a wallet's balance of the token changed. */
export type SolanaTokenMove = {
  signature: string;
  slot: number;
  blockTime: number | null;
  /**
   * - `buy` / `sell`: the transaction went through a known market or
   *   launchpad program (programs.ts) and the balance rose / fell;
   * - `sent` / `received`: no market, the token went to / came from others;
   * - `burned`: no market, the balance fell and nobody received it.
   */
  kind: 'buy' | 'sell' | 'sent' | 'received' | 'burned';
  /** Raw units, positive. */
  amount: string;
  share: number | null;
  /** The wallet's SOL change in lamports, fees excluded; signed. */
  sol: string;
  /** The other owners whose balance moved the other way (recipients of a send, senders of a receipt). */
  counterparties: { address: string; amount: string }[];
};

export type SolanaWalletOnToken = {
  wallet: string;
  mint: string;
  bought: string;
  sold: string;
  received: string;
  burned: string;
  /** SOL spent on buys and received from sales, lamports. */
  solSpent: string;
  solReceived: string;
  /** Held today across its token accounts of this mint; `null` when not read. */
  holdsNow: string | null;
  holdsNowShare: number | null;
  moves: SolanaTokenMove[];
  /** Token accounts whose signatures were read: today's, and the associated one. */
  accountsRead: string[];
  /** Transactions found on those accounts, and how many were read. */
  transactions: { listed: number; read: number };
};

export type SolanaCreatorOnTokenData = SolanaWalletOnToken & {
  supply: string | null;
  decimals: number | null;
  /** What it sent outside markets, in the EVM shape (contracts/creator.ts). */
  sends: CreatorSends;
};

export type SolanaCreatorOnToken = Sourced<SolanaCreatorOnTokenData>;

/**
 * SOL that went from one address to another in a transaction:
 * - `system-transfer`: a System Program transfer instruction says so;
 * - `balance-change`: the receiver's balance rose in a transaction it did not
 *   sign, without such an instruction (an account closed to it: exchanges
 *   pay out by closing a wrapped-SOL account to the receiver); `from` is then
 *   who sent the transaction, its fee payer.
 */
export type SolanaSolTransfer = {
  from: string;
  to: string;
  lamports: string;
  how: 'system-transfer' | 'balance-change';
  signature: string;
  slot: number;
  blockTime: number | null;
};

export type SolanaFundedWallet = {
  wallet: string;
  /** The creator's transfers to it in the window, the first one first. */
  transfers: SolanaSolTransfer[];
  lamports: string;
  /** Its trades of the token; `null` when not read (cap reached). */
  onToken: {
    bought: string;
    sold: string;
    holdsNow: string | null;
    /** Its sales, each with the transaction that shows it. */
    sales: { signature: string; amount: string; share: number | null; blockTime: number | null }[];
    complete: boolean;
  } | null;
};

export type SolanaLinkedWalletsData = {
  creator: string;
  mint: string;
  /** The first SOL the creator received, with the transaction; `null` when not found. */
  firstFunding: SolanaSolTransfer | null;
  /**
   * - `found`;
   * - `none-seen`: all its transactions were read and in none it did not
   *   sign did its balance rise;
   * - `not-reached`: its history is longer than what was read.
   */
  funding: 'found' | 'none-seen' | 'not-reached';
  /** Unix seconds around the launch in which the creator's transfers were read; `null` when the launch time is unknown. */
  window: { from: number; to: number } | null;
  /**
   * Wallets (System-owned accounts) the creator sent SOL to in the window,
   * by a top-level System Program transfer, in a transaction that ran no
   * market: transfers inside a trade are its fees and tips.
   */
  funded: SolanaFundedWallet[];
};

export type SolanaLinkedWallets = Sourced<SolanaLinkedWalletsData>;
