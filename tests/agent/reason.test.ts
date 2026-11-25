import { describe, expect, it, vi } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { buildRequest, explain } from '../../src/lib/agent/reason';
import { renderReport, SYSTEM_PROMPT } from '../../src/lib/agent/prompt';
import { UpstreamError } from '../../src/lib/errors';
import { solanaReport } from '../helpers/solana-report';

const AT = '2026-11-25T00:00:00.000Z';
const base = solanaReport();
const report: TokenReport = solanaReport({
  completeness: 'partial',
  creator: {
    ...base.creator,
    completeness: 'partial',
    sources: [{ name: 'solana-rpc', fetchedAt: AT, note: 'fenêtre tronquée' }],
  },
  holders: {
    ...base.holders,
    completeness: 'unavailable',
    sources: [{ name: 'solana-rpc', fetchedAt: AT, note: 'aucune liste lue' }],
  },
});

// TODO-SOLANA: the rendering is a stand-in until the agent is rewritten on
// the Solana report; these tests hold what any rendering must keep.
describe('renderReport', () => {
  const rendered = renderReport(report);

  // L'agent ne peut signaler un trou que s'il le voit.
  it('expose la complétude de chaque bloc', () => {
    expect(rendered).toContain('Completeness: partial');
    expect(rendered).toContain('Completeness: unavailable');
    expect(rendered).toContain('Completeness: full');
  });

  it('remonte les limites de chaque source', () => {
    expect(rendered).toContain('fenêtre tronquée');
    expect(rendered).toContain('aucune liste lue');
  });

  it('gives what the mint lets someone do, one sentence each', () => {
    expect(rendered).toContain('- Nobody can create more of this token.');
  });

  it('keeps addresses as the chain writes them', () => {
    expect(rendered).toContain(report.token);
    expect(rendered).toContain(String(report.creator.data.creator));
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

  it('serves the facts when the text was cut at the token limit', async () => {
    const provider = {
      name: 'anthropic' as const,
      complete: vi.fn(async () => ({
        text: 'What is reassuring\n\nThe creator has',
        usage: { input_tokens: 6000, output_tokens: 1500 },
        stopReason: 'max_tokens',
      })),
    };
    const result = await explain(report, { model: 'claude-sonnet-5-5', provider });
    expect(result.offline).toBe(true);
    expect(result.rejected).toBe(true);
    expect(result.cost.costUsd).toBeGreaterThan(0);
  });

  it('does not call the model past the daily ceiling', async () => {
    const provider = fakeProvider('Les signaux divergent.');
    const result = await explain(report, {
      model: 'claude-sonnet-5-5',
      provider,
      offline: true,
    });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(result.offline).toBe(true);
    expect(result.cost.costUsd).toBe(0);
  });

  it('hands the deadline to the provider', async () => {
    const provider = fakeProvider('Les signaux divergent.');
    const signal = AbortSignal.timeout(10_000);
    await explain(report, { model: 'claude-sonnet-5-5', provider, signal });
    expect(provider.complete).toHaveBeenCalledWith(expect.objectContaining({ signal }));
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

describe('renderReport : les dix questions', () => {
  const answers = [
    {
      specialist: 'holder-spread' as const,
      title: 'Holder Spread',
      question: 'How much of the supply sits in a few wallets?',
      signal: 'concern' as const,
      facts: ['The largest holder has 46% of counted supply.'],
      limits: [],
    },
    {
      specialist: 'sell-path' as const,
      title: 'Sell Path',
      question: 'Can holders sell, and can the trading rules (hook) stand in the way?',
      signal: 'unknown' as const,
      facts: [],
      limits: ['recent trades were not collected'],
    },
  ];

  it('transmet chaque question avec ses faits et ses limites', () => {
    const rendered = renderReport(report, answers);
    expect(rendered).toContain('Holder Spread');
    expect(rendered).toContain('fact: The largest holder has 46% of counted supply.');
    expect(rendered).toContain('limit: recent trades were not collected');
  });

  it('interdit de les additionner ou de les compter', () => {
    const rendered = renderReport(report, answers);
    expect(rendered).toMatch(/Do not add them up/);
    expect(rendered).not.toMatch(/\d+\s*\/\s*10|score/i);
  });

  it('ne change rien quand les réponses manquent', () => {
    expect(renderReport(report, [])).toBe(renderReport(report));
  });
});
