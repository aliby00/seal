import type { Sourced } from './completeness';

/** Ce qu'est devenu un token après son lancement. */
export type TokenOutcome =
  /** Le seuil de graduation a été atteint. Ne dit rien de la qualité. */
  | 'graduated'
  /** Sous le seuil, lancé assez récemment pour qu'on ne puisse pas parler d'abandon. */
  | 'active'
  /** Sous le seuil, et inactif depuis assez longtemps pour le dire. */
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
  /** La liquidité a-t-elle été retirée après coup. `null` si indéterminable. */
  liquidityPulled: boolean | null;
  /** Le créateur a-t-il vendu son allocation. `null` si indéterminable. */
  creatorDumped: boolean | null;
};

export type CreatorHistoryData = {
  creator: string;
  tokens: LaunchedToken[];
  counts: {
    launched: number;
    graduated: number;
    abandoned: number;
    /** Tokens dont le sort n'a pas pu être établi sur la fenêtre observée. */
    undetermined: number;
    liquidityPulled: number;
  };
  /**
   * Fenêtre de blocs réellement scannée. Si elle ne remonte pas à la genèse,
   * `completeness` vaut `partial` et l'agent doit le mentionner.
   */
  scannedRange: { fromBlock: number; toBlock: number };
};

export type CreatorHistory = Sourced<CreatorHistoryData>;
