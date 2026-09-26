import type { TokenReport } from '../contracts';
import { UpstreamError } from '../errors';
import { log } from '../logger';
import { computeCost, type CostBreakdown } from './cost';
import { resolveProvider, type Provider } from './providers';
import { findViolations } from './guardrails';
import { offlineExplanation } from './offline';
import { SYSTEM_PROMPT, renderReport } from './prompt';

export type ReasonOptions = {
  model?: string;
  maxTokens?: number;
  /** Injecté par les tests, ou pour forcer un fournisseur précis. */
  provider?: Provider;
  env?: Record<string, string | undefined>;
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
};

export const DEFAULT_MODEL = 'claude-sonnet-5';

export function buildRequest(report: TokenReport, model: string, maxTokens: number) {
  return { system: SYSTEM_PROMPT, user: renderReport(report), model, maxTokens };
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

  if (!resolved) {
    const text = offlineExplanation(report);
    log.info('restitution hors-ligne', { reason: 'aucun fournisseur configuré', costUsd: 0 });
    return {
      text,
      cost: computeCost('offline', {}),
      violations: findViolations(text),
      offline: true,
    };
  }

  const { provider } = resolved;
  const model = options.model ?? resolved.model;
  const result = await provider.complete(buildRequest(report, model, maxTokens));

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

  if (text.length === 0) {
    throw new UpstreamError('anthropic', `${provider.name} : réponse vide du modèle`);
  }

  return { text, cost, violations, offline: false, provider: provider.name };
}
