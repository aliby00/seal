import type { ProviderName } from './providers';

/**
 * Quel modèle pour quel travail.
 *
 * Les dix spécialistes ne consomment aucun modèle : ce sont des lectures de
 * chaîne et de l'arithmétique, et c'est voulu — un fait n'a pas besoin d'être
 * deviné. Le modèle n'intervient qu'à la fin, pour restituer en langage clair,
 * et sa taille suit la difficulté réelle du rapport :
 *
 *   fast      rien de notable, il suffit de dire ce qui a été vérifié
 *   standard  au moins un signal notable
 *   deep      des signaux notables qui ne racontent pas la même histoire
 *   frontier  le palier deep a échoué sur un rapport très divergent
 *
 * `frontier` (Fable) n'est jamais choisi par le routage. On n'y monte que par
 * `escalate`, et seulement si un budget explicite l'autorise : sans
 * `SEAL_FRONTIER_BUDGET_USD`, il n'existe pas.
 */
export type Tier = 'fast' | 'standard' | 'deep' | 'frontier';

export const TIER_MODELS: Record<ProviderName, Record<Tier, string>> = {
  anthropic: {
    fast: 'claude-haiku-5-5',
    standard: 'claude-sonnet-5-5',
    deep: 'claude-opus-5-5',
    frontier: 'claude-fable-5-1',
  },
  // Groq n'a pas de palier frontier : on reste sur son plus gros modèle.
  groq: {
    fast: 'llama-3.1-8b-instant',
    standard: 'llama-3.3-70b-versatile',
    deep: 'openai/gpt-oss-120b',
    frontier: 'openai/gpt-oss-120b',
  },
};

export type Divergence = {
  /** Spécialistes ayant relevé quelque chose. */
  notable: number;
  /** Paires de signaux notables qui tirent en sens contraire. */
  conflicts: number;
};

/** Le palier découle du rapport, pas d'un réglage : deux rapports identiques coûtent pareil. */
export function routeTier(divergence: Divergence): Exclude<Tier, 'frontier'> {
  if (divergence.conflicts > 0) return 'deep';
  if (divergence.notable > 0) return 'standard';
  return 'fast';
}

export type FrontierGate = {
  /** Budget mensuel autorisé pour Fable, en dollars. 0 ou absent = jamais. */
  budgetUsd: number;
  /** Déjà dépensé sur Fable ce mois-ci. */
  spentUsd: number;
};

/** Coût majoré d'une restitution Fable : ~7 000 tokens en entrée, 1 500 en sortie. */
export const FRONTIER_COST_CEILING_USD = (7_000 * 10 + 1_500 * 50) / 1_000_000;

export type EscalationReason =
  | 'not-needed'
  | 'not-divergent-enough'
  | 'no-budget'
  | 'budget-exhausted'
  | 'spend-untracked'
  | 'escalate';

/**
 * Faut-il monter sur Fable ? Trois conditions, toutes nécessaires :
 *
 *  1. le palier deep a déjà été tenté et sa sortie a été rejetée (vide, ou
 *     refusée par les garde-fous) — Fable ne remplace jamais un premier essai ;
 *  2. le rapport est réellement difficile : au moins deux conflits entre
 *     signaux, pas un simple désaccord ;
 *  3. le budget restant couvre une restitution entière au tarif majoré.
 *
 * Sinon on publie la restitution hors-ligne, qui ne ment pas, plutôt que de
 * payer cinq fois plus cher pour un cas ordinaire.
 */
export function shouldEscalate(
  deepRejected: boolean,
  divergence: Divergence,
  gate: FrontierGate,
): EscalationReason {
  if (!deepRejected) return 'not-needed';
  if (divergence.conflicts < 2) return 'not-divergent-enough';
  if (!(gate.budgetUsd > 0)) return 'no-budget';
  if (gate.budgetUsd - gate.spentUsd < FRONTIER_COST_CEILING_USD) return 'budget-exhausted';
  return 'escalate';
}

export function frontierGateFromEnv(
  env: Record<string, string | undefined>,
  spentUsd = 0,
): FrontierGate {
  const budget = Number(env.SEAL_FRONTIER_BUDGET_USD ?? 0);
  return { budgetUsd: Number.isFinite(budget) ? budget : 0, spentUsd };
}
