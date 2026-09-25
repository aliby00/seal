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
      counts: { launched: 3, graduated: 2, abandoned: 1, liquidityPulled: 0 },
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
      totalSupply: '0',
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

  it('précise que le pool est exclu des parts', () => {
    expect(rendered).toMatch(/pool de liquidité et les adresses de burn sont exclus/);
  });

  it("donne le volume rapporté au nombre d'échanges", () => {
    expect(rendered).toContain('7 échanges');
  });
});

describe('buildRequest', () => {
  const request = buildRequest(report, 'claude-sonnet-5', 1500);

  it('place le system prompt en préfixe stable et marqué pour le cache', () => {
    expect(request.system[0]!.text).toBe(SYSTEM_PROMPT);
    expect(request.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('ne met aucune donnée de token dans le system prompt', () => {
    expect(request.system[0]!.text).not.toContain(report.token);
  });
});

describe('le system prompt interdit explicitement', () => {
  it('les scores', () => {
    expect(SYSTEM_PROMPT).toMatch(/JAMAIS de score/);
  });

  it("les conseils d'achat", () => {
    expect(SYSTEM_PROMPT).toMatch(/bon ou un mauvais investissement/);
  });
});

function fakeClient(text: string, usage = { input_tokens: 6000, output_tokens: 700 }) {
  return {
    create: vi.fn(async () => ({
      content: [{ type: 'text', text }],
      usage,
      stop_reason: 'end_turn',
    })),
  };
}

describe('explain', () => {
  it('renvoie le texte et son coût', async () => {
    const result = await explain(report, {
      model: 'claude-sonnet-5',
      client: fakeClient('Les signaux ne racontent pas la même histoire.') as never,
    });
    expect(result.text).toContain('signaux');
    expect(result.cost.costUsd).toBeCloseTo(0.019, 4);
    expect(result.violations).toHaveLength(0);
  });

  // Un score qui passerait malgré le prompt est une violation du produit,
  // pas un détail de style : il doit remonter jusqu'à l'appelant.
  it('signale une sortie qui contient un score', async () => {
    const result = await explain(report, {
      model: 'claude-sonnet-5',
      client: fakeClient('Ce token obtient 8/10.') as never,
    });
    expect(result.violations.map((v) => v.kind)).toContain('score');
  });

  it('signale une sortie qui ressemble à un conseil', async () => {
    const result = await explain(report, {
      model: 'claude-sonnet-5',
      client: fakeClient('This is safe to buy.') as never,
    });
    expect(result.violations.map((v) => v.kind)).toContain('advice');
  });

  it('lève sur une réponse vide', async () => {
    await expect(
      explain(report, { model: 'claude-sonnet-5', client: fakeClient('   ') as never }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it('lève si le modèle refuse la requête', async () => {
    const client = {
      create: vi.fn(async () => ({ content: [], usage: {}, stop_reason: 'refusal' })),
    };
    await expect(
      explain(report, { model: 'claude-sonnet-5', client: client as never }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
