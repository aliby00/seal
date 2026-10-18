import type { Completeness } from './completeness';
import type { CreatorHistory } from './creator';
import type { HolderDistribution } from './holders';
import type { LaunchReplay } from './launch';
import type { MarketState } from './market';

/**
 * A read that failed this time (a rate limit, a timeout, a node or indexer
 * that did not answer): what it would have found is unknown, never absent.
 *
 * - `creator`: who created the token, or their whole history;
 * - `creator-launches`: the creator's other launches (some places could not be read);
 * - `creator-sales`: whether the creator sold this token;
 * - `launch-replay`: the first minutes after the launch;
 * - `holders`: the holders list;
 * - `market`: the token's trading (listed pair, or the launch pool's swaps).
 */
export type ReadId =
  'creator' | 'creator-launches' | 'creator-sales' | 'launch-replay' | 'holders' | 'market';

export type FailedRead = { read: ReadId; note: string };

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
  /**
   * The reads that failed this time. Each absence they would have settled is
   * unknown: never said, never cached. Absent or empty when every read answered.
   */
  failedReads?: FailedRead[];
};

export type { Completeness, CreatorHistory, HolderDistribution, LaunchReplay, MarketState };
