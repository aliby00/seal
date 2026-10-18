import type { TokenReport } from '../contracts';
import type { HookCode } from '../chain/facts';
import type { FunderKind } from '../chain/funder-kind';
import type { HookCapability, HookPermissions } from '../chain/hooks';
import type { IndexedMarket, MarketIndex } from '../chain/pools';

/**
 * Les dix spécialistes que SEAL fournit et que chacun peut assembler.
 *
 * Un spécialiste répond à UNE question, avec des faits lus sur la chaîne. Il ne
 * prend aucun texte libre en entrée : c'est ce qui ferme la porte à l'injection
 * de prompt. Le seul texte contrôlé par un tiers qu'on manipule — le nom du
 * token — est traité comme une donnée, cité entre guillemets et tronqué.
 */
export const SPECIALIST_IDS = [
  'code-reuse',
  'wallet-age',
  'funding-trace',
  'name-clone',
  'holder-spread',
  'creator-history',
  'sell-path',
  'volume-reality',
  'liquidity-move',
  'rule-change',
] as const;

export type SpecialistId = (typeof SPECIALIST_IDS)[number];

/**
 * Ce qu'un spécialiste a relevé. Ce n'est pas un score : c'est la rubrique
 * sous laquelle le fait sera restitué (« ce qui rassure », « ce qui mérite
 * l'attention »), et la façon dont le routage mesure la divergence.
 */
export type Signal =
  /** Un fait qui mérite l'attention. */
  | 'concern'
  /** Un fait rassurant, au sens où il exclut un mécanisme connu. */
  | 'reassurance'
  /** Un fait notable qui ne penche d'aucun côté à lui seul. */
  | 'observation'
  /** Rien de notable, mais la question a bien été posée et répondue. */
  | 'quiet'
  /** La question n'a pas pu être posée : donnée manquante. */
  | 'unknown';

export type Finding = {
  specialist: SpecialistId;
  signal: Signal;
  /** Faits, en anglais, sans adjectif évaluatif. Ils partent tels quels au modèle. */
  facts: string[];
  /** Ce que le spécialiste n'a pas pu voir, et ce que ça l'empêche de dire. */
  limits: string[];
  /** Spécialistes que ce constat rend pertinents, pour l'enquête. */
  followUps?: SpecialistId[];
  /** The funding question only: the classification and path, for the report and the summary. */
  funding?: FundingDisplay;
};

/** One address on the way up from the creator to whoever funded it. */
export type FundingPathStep = {
  address: string;
  kind: FunderKind;
  name: string | null;
  txCount: number | null;
  /** The batch-sending tool the funding went through, when it did. */
  via?: { address: string; name: string | null };
};

/** The creators linked to this one through the wallets that funded it (indexer only). */
export type FundingNetwork = {
  /** Linked creators, this one left out. */
  creators: number;
  /** Distinct tokens they launched. */
  launches: number;
  launchpads: Record<string, number>;
  /** Wallet levels walked above the creator. */
  depth: number;
  incomplete: boolean;
  /** What is missing, when incomplete. */
  reason?: string;
  /** More creators were linked than collected. */
  capped: boolean;
  firstLaunchAt?: string | null;
  lastLaunchAt?: string | null;
  path: FundingPathStep[];
};

/** What the funding question shows beside its facts. */
export type FundingDisplay = {
  /** The kind of the effective funder: the sender, for a batch-sending tool. */
  kind: FunderKind;
  /** Other token creators linked: 0 unless the effective funder is a wallet. */
  linkedCreators: number;
  /** Tokens those creators launched, when read. */
  launches: number | null;
  depth: number;
  path: FundingPathStep[];
};

/** What is known of who first funded the creator. */
export type FundingFacts = {
  funder: string;
  /** What the funder is (funder-kind.ts). `unknown` is never read as a wallet. */
  funderKind: FunderKind;
  funderName?: string | null;
  funderTxCount?: number | null;
  /** The funding transaction: its sender is the funder when it went through a tool. */
  txHash?: string;
  /** The sender behind a batch-sending tool, and what it is. */
  origin?: string | null;
  originKind?: FunderKind | null;
  originTxCount?: number | null;
  /** Other token creators funded by the same wallet. 0 for anything but a wallet. */
  otherCreatorsFunded: number;
  /** `false` when other creators were not looked up (no index to look in). */
  otherCreatorsChecked?: boolean;
  network?: FundingNetwork;
};

/** A listed pool and its trading rules, as the market questions weigh it. */
export type PoolRules = {
  id: string;
  version: 'v2' | 'v3' | 'v4' | null;
  liquidityUsd: number | null;
  /**
   * A v4 pool's hook (the zero address when it runs none); `undefined` when
   * its `Initialize` could not be read; `null` for a v2/v3 pair, which has
   * no hook.
   */
  hook: string | null | undefined;
};

/** How many markets run on one hook, from the indexer's whole history. */
export type HookUse = { markets: number; pairs: number; indexedTo: number };

export type SpecialistContext = {
  token: string;
  report?: TokenReport;
  /** Le marché v4 du token, s'il en a un. */
  market?: IndexedMarket | null;
  hook?: (HookPermissions & { capabilities: HookCapability[] }) | null;
  /** The main pool (the most liquid one listed), when the token has listed pools. */
  mainPool?: PoolRules | null;
  /** The other pools with liquidity enough to trade in, where the token is the base. */
  otherPools?: PoolRules[];
  /** True when the main pool is v4 and its trading rules could not be read this time. */
  mainRulesUnread?: boolean;
  /** Markets on the main pool's hook, all history (indexer); absent when not read. */
  hookUse?: HookUse | null;
  hookCode?: HookCode | null;
  /** Adresse du créateur : rapport pons, sinon expéditeur de la création du marché. */
  creator?: string | null;
  creatorNonce?: number | null;
  /** Beacon EIP-1967 du token. Sert à reconnaître une famille de tokens émis ensemble. */
  tokenBeacon?: string | null;
  /** `undefined` = pas collecté ; `null` = collecté, rien trouvé. */
  funding?: FundingFacts | null;
  index?: MarketIndex;
};

export type Specialist = {
  id: SpecialistId;
  title: string;
  /** La question, dite simplement — c'est ce que voit quelqu'un qui compose son agent. */
  question: string;
  run(context: SpecialistContext): Finding;
};
