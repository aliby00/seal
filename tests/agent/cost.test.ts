import { describe, expect, it } from 'vitest';
import { CostCounter, PRICING, computeCost } from '../../src/lib/agent/cost';

describe('computeCost', () => {
  it('applique les tarifs de Sonnet 5', () => {
    // 6000 entrée à 2 $/MTok + 700 sortie à 10 $/MTok
    const cost = computeCost('claude-sonnet-5', { input_tokens: 6000, output_tokens: 700 });
    expect(cost.costUsd).toBeCloseTo(0.019, 4);
    expect(cost.priced).toBe(true);
  });

  it('compte les lectures de cache à leur tarif réduit', () => {
    const cost = computeCost('claude-sonnet-5', {
      input_tokens: 1000,
      cache_read_input_tokens: 5000,
      output_tokens: 0,
    });
    // 1000 × 2 + 5000 × 0,2, le tout par million
    expect(cost.costUsd).toBeCloseTo(0.003, 5);
  });

  // Un modèle absent de la table ne doit pas produire un coût de 0 qu'on croirait vrai.
  it('signale un modèle non tarifé au lieu de mentir sur le coût', () => {
    const cost = computeCost('claude-inconnu-9', { input_tokens: 10_000 });
    expect(cost.priced).toBe(false);
    expect(cost.costUsd).toBe(0);
  });

  it('tolère un usage vide', () => {
    expect(computeCost('claude-sonnet-5', {}).costUsd).toBe(0);
  });

  it("vérifie l'écart de tarif entre les trois modèles retenus", () => {
    expect(PRICING['claude-opus-5']!.input).toBe(5);
    expect(PRICING['claude-sonnet-5']!.input).toBe(2);
    expect(PRICING['claude-haiku-4-5']!.input).toBe(1);
  });
});

describe('CostCounter', () => {
  it('cumule et moyenne la dépense', () => {
    const counter = new CostCounter();
    counter.add(computeCost('claude-sonnet-5', { input_tokens: 6000, output_tokens: 700 }));
    counter.add(computeCost('claude-sonnet-5', { input_tokens: 6000, output_tokens: 700 }));
    const snapshot = counter.snapshot();
    expect(snapshot.requests).toBe(2);
    expect(snapshot.totalUsd).toBeCloseTo(0.038, 4);
    expect(snapshot.averageUsd).toBeCloseTo(0.019, 4);
  });

  it('ne divise pas par zéro sans requête', () => {
    expect(new CostCounter().snapshot()).toEqual({ requests: 0, totalUsd: 0, averageUsd: 0 });
  });
});
