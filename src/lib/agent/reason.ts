import type { TokenReport } from '../contracts';
import { log } from '../logger';
import { computeCost, type CostBreakdown } from './cost';
import { resolveProvider, type Provider } from './providers';
import { findViolations } from './guardrails';
import { offlineExplanation } from './offline';
import { SYSTEM_PROMPT, renderReport } from './prompt';
import type { SpecialistAnswer } from '../specialists/brief';

export type ReasonOptions = {
  model?: string;
  maxTokens?: number;
  /** Injecté par les tests, ou pour forcer un fournisseur précis. */
  provider?: Provider;
  env?: Record<string, string | undefined>;
  /** The ten questions' answers, when they are ready before the text is written. */
  specialists?: SpecialistAnswer[];
  /** Skip the model and word the facts offline: the daily ceiling is reached. */
  offline?: boolean;
  /** Cuts the call when the route runs out of time; the facts are then served. */
  signal?: AbortSignal;
};

export type Explanation = {
  text: string;
  cost: CostBreakdown;
  /** Violations détectées dans la sortie. Non vide = la sortie a été refusée. */
  violations: ReturnType<typeof findViolations>;
  /** Vrai quand la restitution vient du mode hors-ligne, sans appel au modèle. */
  offline: boolean;
  /** Quel fournisseur a produit le texte. `undefined` en hors-ligne. */
  provider?: string;
  /** The model answered, but its wording was refused and the facts were served instead. */
  rejected?: boolean;
};

/** The offline account, checked like any other text before it is served. */
function served(text: string, cost: CostBreakdown): Explanation {
  return { text, cost, violations: findViolations(text), offline: true };
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function buildRequest(
  report: TokenReport,
  model: string,
  maxTokens: number,
  specialists?: SpecialistAnswer[],
) {
  return { system: SYSTEM_PROMPT, user: renderReport(report, specialists), model, maxTokens };
}

/**
 * Produit l'explication en langage clair.
 *
 * Le fournisseur est résolu depuis l'environnement : Groq s'il y a une clé
 * gratuite, sinon Anthropic, sinon rien — et dans ce dernier cas on restitue
 * les faits hors-ligne plutôt que d'échouer.
 *
 * La sortie passe par les garde-fous quel que soit le fournisseur. Un score ou
 * une formulation de conseil est une violation du produit, pas un défaut de
 * modèle : relâcher la vérification parce que le texte vient d'ailleurs n'aurait
 * aucun sens.
 */
export async function explain(
  report: TokenReport,
  options: ReasonOptions = {},
): Promise<Explanation> {
  const maxTokens = options.maxTokens ?? 1500;
  const resolved = options.provider
    ? { provider: options.provider, model: options.model ?? DEFAULT_MODEL }
    : resolveProvider(options.env);

  if (!resolved || options.offline) {
    log.info('restitution hors-ligne', {
      reason: resolved ? 'plafond de dépense' : 'aucun fournisseur configuré',
      costUsd: 0,
    });
    return served(offlineExplanation(report), computeCost('offline', {}));
  }

  const { provider } = resolved;
  const model = options.model ?? resolved.model;
  // A provider that fails (wrong model id, quota, timeout) must not turn an
  // analysis whose facts are ready into an error page: the facts are served.
  let result;
  try {
    result = await provider.complete({
      ...buildRequest(report, model, maxTokens, options.specialists),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    log.warn('fournisseur en échec, restitution hors-ligne', {
      provider: provider.name,
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return served(offlineExplanation(report), computeCost('offline', {}));
  }

  const text = result.text.trim();
  const cost = computeCost(model, result.usage);
  const violations = findViolations(text);

  // Le coût est loggué à chaque requête, pas agrégé après coup.
  log.info('requête agent', {
    provider: provider.name,
    model,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    cacheReadTokens: cost.cacheReadTokens,
    costUsd: cost.costUsd,
    priced: cost.priced,
    stopReason: result.stopReason,
    violations: violations.length,
  });

  // Empty or non-compliant wording is not published; the facts are, and the
  // call is still paid for, so its cost is kept.
  // A text cut at the token limit stops mid-sentence: not published either.
  const truncated = result.stopReason === 'max_tokens' || result.stopReason === 'length';
  if (text.length === 0 || violations.length > 0 || truncated) {
    log.warn('restitution refusée, restitution hors-ligne', {
      provider: provider.name,
      empty: text.length === 0,
      truncated,
      violations: violations.map((v) => v.kind),
    });
    return { ...served(offlineExplanation(report), cost), rejected: true };
  }

  return { text, cost, violations, offline: false, provider: provider.name };
}
