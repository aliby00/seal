/**
 * Coût par requête, lisible dès le MVP.
 *
 * Le brief l'impose noir sur blanc : « le coût par requête à l'agent de
 * raisonnement doit être visible/loggable dès le MVP, pas ajouté après coup ».
 * Sans ça, l'arbitrage Sonnet 5 contre Haiku 4.5 resterait théorique.
 *
 * Tarifs relevés le 25/09/2026 sur platform.claude.com, en dollars par million
 * de tokens. Ils sont versionnés ici plutôt que devinés à l'exécution.
 */
export type ModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
};

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25 },
};

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type CostBreakdown = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Faux si le modèle est inconnu de la table : le coût vaut alors 0 et ne doit pas être cru. */
  priced: boolean;
};

const PER_MILLION = 1_000_000;

export function computeCost(model: string, usage: Usage): CostBreakdown {
  const pricing = PRICING[model];
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

  if (!pricing) {
    return {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: 0,
      priced: false,
    };
  }

  const costUsd =
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheReadTokens * pricing.cacheRead +
      cacheWriteTokens * pricing.cacheWrite5m) /
    PER_MILLION;

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // Arrondi au millionième de dollar : en dessous, le chiffre n'a plus de sens.
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    priced: true,
  };
}

/** Compteur cumulé du processus, pour comparer la dépense réelle au budget mensuel. */
export class CostCounter {
  private totalUsd = 0;
  private requests = 0;

  add(breakdown: CostBreakdown): void {
    this.totalUsd += breakdown.costUsd;
    this.requests += 1;
  }

  snapshot(): { requests: number; totalUsd: number; averageUsd: number } {
    return {
      requests: this.requests,
      totalUsd: Math.round(this.totalUsd * 1e6) / 1e6,
      averageUsd: this.requests === 0 ? 0 : Math.round((this.totalUsd / this.requests) * 1e6) / 1e6,
    };
  }
}
