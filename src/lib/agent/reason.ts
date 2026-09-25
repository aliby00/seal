import Anthropic from '@anthropic-ai/sdk';
import type { TokenReport } from '../contracts';
import { UpstreamError } from '../errors';
import { log } from '../logger';
import { computeCost, type CostBreakdown, type Usage } from './cost';
import { findViolations } from './guardrails';
import { SYSTEM_PROMPT, renderReport } from './prompt';

export type ReasonOptions = {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  client?: Pick<Anthropic['messages'], 'create'>;
};

export type Explanation = {
  text: string;
  cost: CostBreakdown;
  /** Violations détectées dans la sortie. Non vide = la sortie a été refusée. */
  violations: ReturnType<typeof findViolations>;
};

export const DEFAULT_MODEL = 'claude-sonnet-5';

export function buildRequest(report: TokenReport, model: string, maxTokens: number) {
  return {
    model,
    max_tokens: maxTokens,
    // Préfixe stable placé en premier et marqué pour le cache : les données du
    // token changent à chaque requête, le system prompt non.
    system: [
      {
        type: 'text' as const,
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    messages: [{ role: 'user' as const, content: renderReport(report) }],
  };
}

/**
 * Produit l'explication en langage clair.
 *
 * La sortie est passée aux garde-fous avant d'être rendue : un score ou une
 * formulation de conseil qui passerait malgré le prompt est une violation du
 * produit, pas un détail de style. On préfère échouer bruyamment.
 */
export async function explain(
  report: TokenReport,
  options: ReasonOptions = {},
): Promise<Explanation> {
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 1500;

  const client =
    options.client ??
    new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY }).messages;

  const response = (await client.create(buildRequest(report, model, maxTokens))) as {
    content: { type: string; text?: string }[];
    usage?: Usage;
    stop_reason?: string;
  };

  if (response.stop_reason === 'refusal') {
    throw new UpstreamError('anthropic', 'la requête a été refusée par le modèle');
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  const cost = computeCost(model, response.usage ?? {});
  const violations = findViolations(text);

  // Le coût est loggué à chaque requête, pas agrégé après coup.
  log.info('requête agent', {
    model,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    cacheReadTokens: cost.cacheReadTokens,
    costUsd: cost.costUsd,
    priced: cost.priced,
    violations: violations.length,
  });

  if (text.length === 0) {
    throw new UpstreamError('anthropic', 'réponse vide du modèle');
  }

  return { text, cost, violations };
}
