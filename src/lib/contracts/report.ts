import type { Completeness } from './completeness';
import type { CreatorHistory } from './creator';
import type { HolderDistribution } from './holders';
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
  /** Complétude d'ensemble, dérivée des trois blocs. */
  completeness: Completeness;
};

export type { Completeness, CreatorHistory, HolderDistribution, MarketState };
