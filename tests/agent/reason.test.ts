import { describe, expect, it, vi } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { buildRequest, explain } from '../../src/lib/agent/reason';
import { renderReport, SYSTEM_PROMPT } from '../../src/lib/agent/prompt';
import { UpstreamError } from '../../src/lib/errors';

const report: TokenReport = {
  token: '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9',
  collectedAt: '2026-09-25T00:00:00.000Z',
  completeness: 'partial',
  creator: {
    completeness: 'partial',
    sources: [
      { name: 'robinhood-rpc', fetchedAt: '2026-09-25T00:00:00.000Z', note: 'fenêtre tronquée' },
    ],
    data: {
      creator: '0xE06289fde414EE521aBA50Db0Cf0a60816FAA523',
      tokens: [],
      counts: {
        launched: 3,
        graduated: 2,
        abandoned: 1,
        undetermined: 0,
        liquidityPulled: 0,
        creatorDumped: 0,
      },
      scannedRange: { fromBlock: 60_000_000, toBlock: 72_000_000 },
    },
  },
  holders: {
    completeness: 'unavailable',
    sources: [
      { name: 'blockscout', fetchedAt: '2026-09-25T00:00:00.000Z', note: 'aucune clé API' },
    ],
    data: {
      token: '0x494d',
      countedSupply: '0',
      holderCount: null,
      top: [],
      concentration: { top1: 0, top10: 0 },
      distinctTraders: null,
    },
  },
  market: {
    completeness: 'full',
    sources: [{ name: 'dexscreener', fetchedAt: '2026-09-25T00:00:00.000Z' }],
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
      pairCreatedAt: '2026-09-24T22:08:22.000Z',
    },
  },
};

describe('renderReport', () => {
  const rendered = renderReport(report);

  // L'agent ne peut signaler un trou que s'il le voit.
  it('expose la complétude de chaque bloc', () => {
    expect(rendered).toContain('Complétude : partial');
    expect(rendered).toContain('Complétude : unavailable');
    expect(rendered).toContain('Complétude : full');
  });

  it('remonte les limites de chaque source', () => {
    expect(rendered).toContain('fenêtre tronquée');
    expect(rendered).toContain('aucune clé API');
  });

  // Unmeasured holders are not sent as zeros: "0 %" would read as a fact.
  it('ne transmet aucune part quand les holders ne sont pas mesurés', () => {
    expect(rendered).toContain('Non mesuré');
    expect(rendered).not.toMatch(/Part du premier détenteur/);
  });

  it('précise que le pool est exclu des parts, et nomme le créateur parmi les holders', () => {
    const creator = report.creator.data.creator;
    const measured = renderReport({
      ...report,
      holders: {
        ...report.holders,
        completeness: 'full',
        data: {
          ...report.holders.data,
          concentration: { top1: 0.26, top10: 0.9 },
          top: [
            { address: creator.toLowerCase(), balance: '1', share: 0.26, kind: 'contract' },
            {
              address: '0x1111111111111111111111111111111111111111',
              balance: '1',
              share: 0.2,
              kind: 'wallet',
            },
          ],
        },
      },
    });
    expect(measured).toMatch(/pool de liquidité et les adresses de burn sont exclus/);
    expect(measured).toMatch(/26\.00 % — adresse du CRÉATEUR/);
  });

  it("donne le volume rapporté au nombre d'échanges", () => {
    expect(rendered).toContain('7 échanges');
  });
});

describe('buildRequest', () => {
  const request = buildRequest(report, 'claude-sonnet-5', 1500);

  it('sépare le préfixe stable des données du token', () => {
    expect(request.system).toBe(SYSTEM_PROMPT);
    expect(request.user).toContain(report.token);
  });

  // Régression invisible : une donnée de token dans le system prompt casserait
  // le prompt caching sans rien casser d'apparent.
  it('ne met aucune donnée de token dans le system prompt', () => {
    expect(request.system).not.toContain(report.token);
  });
});

describe('le system prompt interdit explicitement', () => {
  it('requires English even when source notes use another language', () => {
    expect(SYSTEM_PROMPT).toContain('Always write in English');
  });
  it('les scores', () => {
    expect(SYSTEM_PROMPT).toMatch(/NEVER assign a score/);
  });

  it("les conseils d'achat", () => {
    expect(SYSTEM_PROMPT).toMatch(/good or bad investment/);
  });
});

/** Fournisseur simulé : on contrôle le texte rendu et les tokens consommés. */
function fakeProvider(text: string, usage = { input_tokens: 6000, output_tokens: 700 }) {
  return {
    name: 'anthropic' as const,
    complete: vi.fn(async () => ({ text, usage, stopReason: 'end_turn' })),
  };
}

describe('explain', () => {
  it('renvoie le texte et son coût', async () => {
    const result = await explain(report, {
      model: 'claude-sonnet-5-5',
      provider: fakeProvider('Les signaux ne racontent pas la même histoire.'),
    });
    expect(result.text).toContain('signaux');
    expect(result.cost.costUsd).toBeCloseTo(0.019, 4);
    expect(result.violations).toHaveLength(0);
  });

  // Un score qui passerait malgré le prompt est une violation du produit,
  // pas un détail de style : il doit remonter jusqu'à l'appelant.
  // A score or advice is never published: the facts are served instead, and
  // the model call is still counted, since it was paid for.
  it.each([
    ['a score', 'Ce token obtient 8/10.'],
    ['advice', 'This is safe to buy.'],
    ['a verdict', 'Probably a rug pull.'],
  ])('serves the facts instead of a model output containing %s', async (_, output) => {
    const result = await explain(report, {
      model: 'claude-sonnet-5-5',
      provider: fakeProvider(output),
    });
    expect(result.text).not.toContain(output);
    expect(result.offline).toBe(true);
    expect(result.rejected).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('serves the facts when the model answers nothing', async () => {
    const result = await explain(report, {
      model: 'claude-sonnet-5-5',
      provider: fakeProvider('   ') as never,
    });
    expect(result.offline).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });

  // The audit case: an invalid model id made every analysis a 500.
  it('serves the facts when the provider fails', async () => {
    const failing = {
      name: 'anthropic' as const,
      complete: vi.fn(async (): Promise<never> => {
        throw new UpstreamError('anthropic', 'model not found');
      }),
    };
    const result = await explain(report, { model: 'claude-sonnet-5-5', provider: failing });
    expect(result.offline).toBe(true);
    expect(result.cost.costUsd).toBe(0);
  });

  it('indique quel fournisseur a produit le texte', async () => {
    const result = await explain(report, {
      model: 'claude-sonnet-5-5',
      provider: fakeProvider('Les signaux divergent.'),
    });
    expect(result.provider).toBe('anthropic');
    expect(result.offline).toBe(false);
  });
});

describe('renderReport : ventes et retraits du créateur', () => {
  // The bug: the card showed "sold into the pool 10/10" while the model wrote
  // that nothing showed the creator selling — it was never told.
  it('transmet les ventes et retraits observés sur les lancements vérifiés', () => {
    const t = (dumped: boolean | null, pulled: boolean | null, i: number) => ({
      address: `0x${String(i).padStart(40, '0')}`,
      pool: '0xpool',
      launchedAtBlock: i,
      launchedAt: null,
      outcome: 'abandoned' as const,
      graduationProgress: 0,
      creatorDumped: dumped,
      liquidityPulled: pulled,
    });
    const rendered = renderReport({
      ...report,
      creator: {
        ...report.creator,
        data: {
          ...report.creator.data,
          tokens: [t(null, null, 1), t(true, false, 2), t(true, true, 3)],
        },
      },
    });
    expect(rendered).toContain('Ventes du créateur dans le marché : sur 2 lancements vérifiés, 2');
    expect(rendered).toContain('Retraits de liquidité : sur 2 lancements vérifiés, 1');
    expect(rendered).toMatch(/vente du créateur : oui, retrait de liquidité : oui/);
    expect(rendered).toMatch(/vente du créateur : non vérifié/);
  });
});
