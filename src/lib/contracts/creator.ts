import type { Sourced } from './completeness';

/** Ce qu'est devenu un token après son lancement. */
export type TokenOutcome =
  /** Le seuil de graduation a été atteint. Ne dit rien de la qualité. */
  | 'graduated'
  /** Sous le seuil, et lancé récemment ou encore échangé ces derniers jours. */
  | 'active'
  /** Sous le seuil, lancé il y a plus de 30 jours, et aucun transfert depuis ~11 jours. */
  | 'abandoned'
  /**
   * La fenêtre observée est trop courte pour trancher entre `active` et
   * `abandoned`. Dire « actif » par défaut serait une affirmation qu'on ne
   * peut pas soutenir.
   */
  | 'undetermined';

export type LaunchedToken = {
  address: string;
  pool: string;
  launchedAtBlock: number;
  launchedAt: string | null;
  outcome: TokenOutcome;
  /** Part du seuil de graduation atteinte, de 0 à 1. */
  graduationProgress: number;
  /** The launchpad that recorded this launch, when a known one did (its name). */
  launchpad?: string;
  /** La liquidité a-t-elle été retirée après coup. `null` si indéterminable. */
  liquidityPulled: boolean | null;
  /** Le créateur a-t-il vendu son allocation. `null` si indéterminable. */
  creatorDumped: boolean | null;
};

/**
 * How the creator was found. A pons launch names its creator in its launch
 * record; any other token is traced back to the transaction that minted it.
 */
export type CreatorOrigin = {
  source: 'pons' | 'deployer';
  /**
   * - `deployer`: the address sent the transaction that created the contract;
   * - `launcher`: it called a launch contract, which created the token;
   * - `first-minter`: it sent the token's first mint, after the contract
   *   already existed (a bridge or a relayer can do that — it is not proof
   *   of authorship).
   */
  role: 'deployer' | 'launcher' | 'first-minter';
  /** The contract the launch transaction called, when a contract made the token. */
  launchContract?: string;
  /** The known launchpad whose launch event names the token (launchpads.ts). */
  launchpad?: { id: string; name: string; address: string };
  /**
   * Where the creator was read: the launch event, or the sender of the
   * transaction (no event naming them, or a contract relaying the launch).
   */
  creatorFrom?: 'launch-record' | 'transaction';
  /** Whether the address's other launches could be listed from the chain. */
  launchesListed: boolean;
  /** Where the address's launches were looked for (launchpad names). */
  launchpadsRead?: string[];
  /**
   * Where they could not be: launchpads whose event does not index the
   * creator (unless the indexer listed them), and contracts deployed directly.
   */
  launchpadsNotRead?: string[];
  /** Transactions sent by the address, when it is a wallet (null for a contract). */
  transactionCount: number | null;
};

export type CreatorHistoryData = {
  creator: string;
  /** Absent on histories built before deployer tracing, and on pons launches read the old way. */
  origin?: CreatorOrigin;
  tokens: LaunchedToken[];
  counts: {
    launched: number;
    graduated: number;
    abandoned: number;
    /** Tokens dont le sort n'a pas pu être établi sur la fenêtre observée. */
    undetermined: number;
    liquidityPulled: number;
    /** Tokens pour lesquels une vente du créateur vers le pool a été observée. */
    creatorDumped: number;
  };
  /**
   * Fenêtre de blocs réellement scannée. Si elle ne remonte pas à la genèse,
   * `completeness` vaut `partial` et l'agent doit le mentionner.
   */
  scannedRange: { fromBlock: number; toBlock: number };
};

export type CreatorHistory = Sourced<CreatorHistoryData>;
