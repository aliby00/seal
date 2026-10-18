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
 *  - `vesting`: a vesting lock (TokenTable): its tokens unlock on a
 *    schedule, and cannot be sold before;
 *  - `burn`: the zero and dead addresses.
 */
export type SetAsideRole =
  | 'pool'
  | 'pool-manager'
  | 'curve'
  | 'launchpad'
  | 'locker'
  /** A market's trading rules (Uniswap v4 hook), or a contract plugged into them. */
  | 'hook'
  /** A vesting lock: what it holds unlocks on a schedule, and cannot be sold before. */
  | 'vesting'
  | 'burn';

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
  /**
   * What this holder received from the creator, as a share of the whole
   * supply: directly (`via` null), or through a contract the creator sent
   * tokens to. A transfer, not a proof of who controls the address.
   */
  fromCreator?: { share: number; via: string | null };
  /** What the address is, when the chain says more than wallet or contract (roles.ts). */
  name?: string;
};

/** What the creator's own transfers of the token say about today's holders. */
export type CreatorLinks = {
  /** Distinct addresses the creator sent the token to, outside its markets. */
  sentTo: number;
  /** Share of the supply the creator sent to a burn address. */
  burned: number;
  /** Listed holders that received from the creator, directly or through one contract. */
  holders: { address: string; share: number; via: string | null }[];
  /** Contracts the creator sent tokens to that passed them on to many addresses. */
  distributors: { address: string; share: number; recipients: number; complete: boolean }[];
  /**
   * Every address the creator sent the token to outside its markets, the
   * largest first (at most CREATOR_RECIPIENTS_LISTED), as shares of the
   * supply; `listed` when it is among the holders read today. Absent from
   * reports made before (WAFER: a 0.11 % send to a wallet went unsaid, and
   * the text called a burn "the only creator transfer outside markets").
   */
  recipients?: { address: string; share: number; listed: boolean }[];
  /** All the creator sent outside its markets, burn excluded, as a share of the supply. */
  sentShare?: number;
};

/** Recipients of the creator listed in the links. */
export const CREATOR_RECIPIENTS_LISTED = 10;

/** One address set aside, with its part of the whole supply (null when the supply is unknown). */
export type SetAsideHolding = {
  address: string;
  role: SetAsideRole;
  share: number | null;
  /** What the address is, when named (roles.ts): "Virtuals’ team lock (TokenTable)". */
  name?: string;
};

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
  /** Links from the creator to the holders, when its transfers were all read. */
  creatorLinks?: CreatorLinks;
};

export type HolderDistribution = Sourced<HolderDistributionData>;

/** Holders below which "most of them received it from the creator" says too little to be said. */
export const AIRDROP_MIN_HOLDERS = 50;

/**
 * Whether most of the holders received the token from its creator: only
 * when the creator's recipients outnumber half of a real holder list. KEL
 * (2 holders, the creator's "1 recipient" the router of its own sale) was
 * told that most of its holders had received it rather than bought it.
 */
export function mostHoldersFromCreator(
  recipients: number | null | undefined,
  holderCount: number | null | undefined,
): boolean {
  if (recipients === null || recipients === undefined) return false;
  if (holderCount === null || holderCount === undefined) return false;
  return holderCount >= AIRDROP_MIN_HOLDERS && recipients > holderCount / 2;
}
