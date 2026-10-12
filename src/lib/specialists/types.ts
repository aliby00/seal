import type { TokenReport } from '../contracts';
import type { HookCode } from '../chain/facts';
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
};

/** Ce qui se sait d'un créateur côté financement. Collecté seulement avec un indexeur. */
export type FundingFacts = {
  funder: string;
  /** Autres créateurs de token financés par la même adresse. */
  otherCreatorsFunded: number;
};

export type SpecialistContext = {
  token: string;
  report?: TokenReport;
  /** Le marché v4 du token, s'il en a un. */
  market?: IndexedMarket | null;
  hook?: (HookPermissions & { capabilities: HookCapability[] }) | null;
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
