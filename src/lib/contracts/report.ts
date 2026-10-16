import type { Completeness } from './completeness';
import type { CreatorHistory } from './creator';
import type { HolderDistribution } from './holders';
import type { LaunchReplay } from './launch';
import type { MarketState } from './market';

/**
 * Ce que le pipeline de données remet à l'agent de raisonnement.
 *
 * Volontairement sans verdict, sans score et sans agrégat : trois blocs de
 * faits, chacun avec sa complétude. C'est l'agent qui les croise — c'est tout
 * le propos du produit.
 */
export type TokenReport = {
  token: string;
  collectedAt: string;
  creator: CreatorHistory;
  holders: HolderDistribution;
  market: MarketState;
  /**
   * The first minutes after the launch, when the launch block is known. Not
   * part of the overall completeness: a missing replay leaves the three blocks
   * as complete as they were.
   */
  launch?: LaunchReplay;
  /** Complétude d'ensemble, dérivée des trois blocs. */
  completeness: Completeness;
};

export type { Completeness, CreatorHistory, HolderDistribution, LaunchReplay, MarketState };
