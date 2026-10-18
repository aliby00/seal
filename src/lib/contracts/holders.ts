import type { Sourced } from './completeness';

/**
 * Why an address is set aside rather than counted as a holder: it holds
 * tokens for trading or for the launch mechanism, not for anyone.
 *  - `pool`: a V2 pair or V3 pool (the launch pool, a pair listed since);
 *  - `pool-manager`: the Uniswap v4 PoolManager, holding every v4 market;
 *  - `curve`: a launchpad's bonding curve;
 *  - `launchpad`: a launchpad, its router or factory, or the contract the
 *    launch transaction called;
 *  - `locker`: a launchpad's lock contract, holding locked liquidity;
 *  - `burn`: the zero and dead addresses.
 */
export type SetAsideRole = 'pool' | 'pool-manager' | 'curve' | 'launchpad' | 'locker' | 'burn';

export type Holder = {
  address: string;
  balance: string;
  /** Part de l'offre en circulation, de 0 à 1. */
  share: number;
  /**
   * Le pool et les adresses de burn ne sont pas des détenteurs comme les
   * autres. `pool` covers every address set aside for trading or for the
   * launch mechanism; `role` says which.
   */
  kind: 'wallet' | 'pool' | 'burn' | 'contract';
  /** Present on set-aside addresses. */
  role?: SetAsideRole;
};

/** One address set aside, with its part of the whole supply (null when the supply is unknown). */
export type SetAsideHolding = { address: string; role: SetAsideRole; share: number | null };

export type HolderDistributionData = {
  token: string;
  /**
   * Somme des soldes des détenteurs RÉELLEMENT récupérés, pool et burn exclus.
   *
   * Ce n'est PAS l'offre totale du token : on ne lit qu'une page de détenteurs.
   * Le nom `totalSupply` laissait croire le contraire et pouvait faire afficher
   * un chiffre faux.
   */
  countedSupply: string;
  /** Nombre total de détenteurs, `null` si la source ne le donne pas. */
  holderCount: number | null;
  /** Les plus gros détenteurs, pool et burn exclus du calcul des parts. */
  top: Holder[];
  concentration: {
    top1: number;
    top10: number;
  };
  /**
   * Part de l'offre TOTALE encore dans les pools et les adresses de burn, de 0
   * à 1 ; `null` quand l'offre totale n'est pas connue. Sans elle, « 70 % pour
   * le premier détenteur » se lisait comme 70 % du token alors que ce n'était
   * que 70 % du reliquat hors pool.
   */
  pooledShare?: number | null;
  /** The addresses set aside (pools, curves, launch contracts, burn), largest first. */
  setAside?: SetAsideHolding[];
  /** Nombre d'adresses distinctes ayant échangé sur la période observée. */
  distinctTraders: number | null;
};

export type HolderDistribution = Sourced<HolderDistributionData>;
