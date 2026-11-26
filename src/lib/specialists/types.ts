import type { TokenReport } from '../contracts';
import type { TokenPower, TokenPowerKind } from '../solana/token-types';

/**
 * What kind of address first funded a wallet: an exchange or a router
 * (`service`), a batch-sending tool, a wallet, or unread (`unknown`, never
 * treated as a wallet). On Solana SEAL reads who sent the first SOL, not who
 * is behind that address: the funding question names it `unknown`.
 */
export type FunderKind = 'service' | 'tool' | 'wallet' | 'unknown';

/**
 * Les dix spécialistes que SEAL fournit et que chacun peut assembler.
 *
 * Un spécialiste répond à UNE question, avec des faits lus sur la chaîne. Il ne
 * prend aucun texte libre en entrée : c'est ce qui ferme la porte à l'injection
 * de prompt. Le seul texte contrôlé par un tiers qu'on manipule — le nom du
 * token — est traité comme une donnée, cité entre guillemets et tronqué.
 *
 * L'ordre est celui de la restitution : ce que la mint permet d'abord, puis
 * les détenteurs, le créateur, le marché.
 */
export const SPECIALIST_IDS = [
  'token-powers',
  'transfer-rules',
  'holder-spread',
  'creator-history',
  'wallet-age',
  'funding-trace',
  'volume-reality',
  'sell-path',
  'liquidity-move',
  'name-clone',
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

/** One power of the mint, as the summary restates it. */
export type PowerMeasure = {
  power: TokenPowerKind;
  status: TokenPower['status'];
  /** The address holding it is the token's creator. */
  byCreator: boolean;
  /**
   * The power acts today, not only once someone uses it: a transfer hook
   * program set, a transfer fee charged, transfers paused, new accounts
   * frozen. Absent when it does not apply.
   */
  active?: boolean;
  /** The transfer fee in force ("5%"), when one is charged. */
  fee?: string;
};

/** Wallets that got tokens together at launch, as the summary restates them. */
export type GroupMeasure = {
  wallets: number;
  /** Share of the supply they got. */
  share: number;
  /** Share they hold today; `null` when not read. */
  heldNow: number | null;
  /** How many of them sold in the window read. */
  soldInWindow: number;
};

/**
 * The numbers a question read, served beside its facts so the report's
 * opening can restate them in its own words. Measures, never a score: each
 * key belongs to one question, and nothing adds them up.
 */
export type Measures = {
  /** Token Powers: mint, freeze, metadata and the other powers over the token itself. */
  powers?: PowerMeasure[];
  /** Transfer Rules: what acts on transfers (fee, hook, delegate, pause, default state). */
  rules?: PowerMeasure[];
  /** Holder Spread. */
  spread?: {
    /** Largest wallet and top 10, shares of what circulates. */
    top1: number;
    top10: number;
    /** Share of the whole supply in curves, pools, locks and burn; `null` when unknown. */
    setAside: number | null;
    /** Holders today, pools and curves left out; `exact` when every account was read. */
    holders: number;
    exact: boolean;
    /** What the creator holds, share of the whole supply; `null` when not read. */
    creator: number | null;
  };
  /** Creator History: the creator's other tokens. */
  history?: {
    launched: number;
    graduated: number;
    dead: number;
    active: number;
    unknown: number;
    /** The list is a floor: some of the creator's transactions were not read. */
    atLeast: boolean;
  };
  /** Creator History: what the creator did with this token. */
  creator?: {
    /** Shares of the supply; `sold` is `null` when "no sale" could not be told. */
    bought: number | null;
    sold: number | null;
    /** Whether a sale was read: `null` when a partial read saw none. */
    hasSold: boolean | null;
    holdsNow: number | null;
    /** Its sales are minor (saleSize): a fact, not a signal. Absent otherwise. */
    minorSale?: boolean;
  };
  /** Funding Trace: the wallets the creator sent SOL to around the launch. */
  linked?: {
    wallets: number;
    /** How many of them bought, and sold, this token; shares of the supply. */
    buyers: number;
    sellers: number;
    bought: number;
    sold: number;
    heldNow: number | null;
    /** Every funded wallet's trades were read. */
    complete: boolean;
  };
  /** Volume Reality: wallets that got tokens together at launch, and round trips. */
  launch?: {
    sameSlot: GroupMeasure | null;
    payerGroup: GroupMeasure | null;
    roundTrips: number | null;
  };
  /** Sell Path: a token still on its launch curve, and what the curve holds. */
  curve?: {
    launchpad: string;
    graduated: boolean | null;
    progress: number | null;
    /** SOL the curve holds today, and its value at the token's own SOL price; `null` when not read. */
    sol: number | null;
    usd: number | null;
  };
};

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
  /**
   * The question does not apply to this token (a pool question on a token
   * still on its bonding curve): said apart from what could not be measured.
   */
  notApplicable?: true;
  /** The numbers read, for the report's opening. */
  measures?: Measures;
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

/** What the funding question shows beside its facts. */
export type FundingDisplay = {
  /** The kind of the effective funder. */
  kind: FunderKind;
  /** Other token creators linked: 0 unless the funder is a known wallet. */
  linkedCreators: number;
  /** Tokens those creators launched, when read. */
  launches: number | null;
  depth: number;
  path: FundingPathStep[];
};

/**
 * What a question can read: the token and its collected report. Every
 * question answers from the report alone, so nothing has to be looked up
 * while the questions run; without a report, each says it could not answer.
 */
export type SpecialistContext = {
  token: string;
  report?: TokenReport;
  /** The creator, from the report. */
  creator?: string | null;
};

export type Specialist = {
  id: SpecialistId;
  title: string;
  /** La question, dite simplement — c'est ce que voit quelqu'un qui compose son agent. */
  question: string;
  run(context: SpecialistContext): Finding;
};
