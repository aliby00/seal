import { describe, expect, it } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { explain } from '../../src/lib/agent/reason';
import { isCompliant } from '../../src/lib/agent/guardrails';

function report(overrides: Partial<TokenReport> = {}): TokenReport {
  return {
    token: '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9',
    collectedAt: '2026-09-25T00:00:00.000Z',
    completeness: 'partial',
    creator: {
      completeness: 'partial',
      sources: [{ name: 'robinhood-rpc', fetchedAt: 'x', note: 'fenêtre tronquée' }],
      data: {
        creator: '0xE062',
        tokens: [],
        counts: { launched: 3, graduated: 2, abandoned: 1, liquidityPulled: 0 },
        scannedRange: { fromBlock: 66_000_000, toBlock: 71_000_000 },
      },
    },
    holders: {
      completeness: 'unavailable',
      sources: [{ name: 'blockscout', fetchedAt: 'x', note: 'aucune clé API' }],
      data: {
        token: '0x494d',
        totalSupply: '0',
        holderCount: null,
        top: [],
        concentration: { top1: 0, top10: 0 },
        distinctTraders: null,
      },
    },
    market: {
      completeness: 'full',
      sources: [{ name: 'dexscreener', fetchedAt: 'x' }],
      data: {
        token: '0x494d',
        pair: '0x6689',
        priceUsd: 0.000003654,
        liquidityUsd: 3654.24,
        pairedEth: 0.002235,
        graduation: { thresholdEth: 4.2, progress: 0.000532, graduated: false },
        volumeUsd: { m5: 0, h1: 485.73, h6: 485.73, h24: 485.73 },
        txns: { h1: { buys: 4, sells: 3 }, h24: { buys: 4, sells: 3 } },
        fdvUsd: 3654,
        pairCreatedAt: null,
      },
    },
    ...overrides,
  };
}

describe('offlineExplanation', () => {
  const text = offlineExplanation(report());

  // Le point le plus important : elle ne doit jamais se faire passer pour l'agent.
  it("annonce d'emblée qu'elle ne croise pas les signaux", () => {
    expect(text).toMatch(/sans l'agent de raisonnement/);
    expect(text).toMatch(/sans les croiser/);
  });

  it("respecte les mêmes garde-fous que l'agent", () => {
    expect(isCompliant(text)).toBe(true);
  });

  it('restitue les faits du créateur avec la fenêtre observée', () => {
    expect(text).toContain('3 tokens lancés');
    expect(text).toMatch(/blocs 66000000 à 71000000/);
  });

  it("dit pourquoi une source manque au lieu de l'omettre", () => {
    expect(text).toMatch(/non mesurée \(aucune clé API\)/);
  });

  it("donne le volume rapporté au nombre d'échanges", () => {
    expect(text).toMatch(/7 échanges/);
    expect(text).toMatch(/69\.39 USD par échange/);
  });

  it('signale explicitement une vue partielle', () => {
    expect(text).toMatch(/vue partielle/);
  });

  it('reste lisible quand tout manque', () => {
    const empty = offlineExplanation(
      report({
        completeness: 'unavailable',
        creator: { ...report().creator, completeness: 'unavailable' },
        market: { ...report().market, completeness: 'unavailable' },
      }),
    );
    expect(isCompliant(empty)).toBe(true);
    expect(empty).toMatch(/n'a pas pu être lu/);
  });
});

describe('explain sans clé API', () => {
  it('bascule en hors-ligne au lieu de lever', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await explain(report());
      expect(result.offline).toBe(true);
      expect(result.cost.costUsd).toBe(0);
      expect(result.violations).toHaveLength(0);
      expect(result.text).toMatch(/sans l'agent de raisonnement/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
