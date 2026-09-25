import type { Sourced } from './completeness';

/** Ce qu'est devenu un token après son lancement. */
export type TokenOutcome =
  /** Le seuil de 4,2 ETH a été atteint. Ne dit rien de la qualité. */
  | 'graduated'
  /** Encore sous le seuil, activité récente. */
  | 'active'
  /** Sous le seuil, plus d'activité depuis longtemps. */
  | 'abandoned';

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
    liquidityPulled: number;
  };
  /**
   * Fenêtre de blocs réellement scannée. Si elle ne remonte pas à la genèse,
   * `completeness` vaut `partial` et l'agent doit le mentionner.
   */
  scannedRange: { fromBlock: number; toBlock: number };
};

export type CreatorHistory = Sourced<CreatorHistoryData>;
