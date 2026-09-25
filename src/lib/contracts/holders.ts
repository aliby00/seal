import type { Sourced } from './completeness';

export type Holder = {
  address: string;
  balance: string;
  /** Part de l'offre en circulation, de 0 à 1. */
  share: number;
  /** Le pool et les adresses de burn ne sont pas des détenteurs comme les autres. */
  kind: 'wallet' | 'pool' | 'burn' | 'contract';
};

export type HolderDistributionData = {
  token: string;
  totalSupply: string;
  /** Nombre total de détenteurs, `null` si la source ne le donne pas. */
  holderCount: number | null;
  /** Les plus gros détenteurs, pool et burn exclus du calcul des parts. */
  top: Holder[];
  concentration: {
    top1: number;
    top10: number;
  };
  /** Nombre d'adresses distinctes ayant échangé sur la période observée. */
  distinctTraders: number | null;
};

export type HolderDistribution = Sourced<HolderDistributionData>;
