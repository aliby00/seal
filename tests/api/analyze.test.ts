import { afterEach, describe, expect, it, vi } from 'vitest';

const collect = vi.hoisted(() => vi.fn());
const explain = vi.hoisted(() => vi.fn());

vi.mock('@/lib/collect', () => ({ collect }));
vi.mock('@/lib/agent/reason', () => ({ explain }));

const { POST } = await import('../../src/app/api/analyze/route');
const { RateLimitError, NotFoundError } = await import('../../src/lib/errors');

const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';

const report = {
  token: TOKEN,
  collectedAt: '2026-09-25T00:00:00.000Z',
  completeness: 'partial',
  creator: {
    completeness: 'partial',
    sources: [{ name: 'robinhood-rpc', note: 'tronqué' }],
    data: {},
  },
  holders: { completeness: 'unavailable', sources: [{ name: 'blockscout' }], data: {} },
  market: { completeness: 'full', sources: [{ name: 'dexscreener' }], data: {} },
};

function post(body: unknown): Request {
  return new Request('http://localhost/api/analyze', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => vi.clearAllMocks());

describe('POST /api/analyze', () => {
  it('refuse une adresse invalide sans rien collecter', async () => {
    const res = await POST(post({ token: 'bonjour' }));
    expect(res.status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });

  it('refuse un corps illisible', async () => {
    expect((await POST(post('{'))).status).toBe(400);
  });

  it("renvoie l'explication, la complétude et le coût", async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({
      text: 'Les signaux ne racontent pas la même histoire.',
      cost: { costUsd: 0.019 },
      violations: [],
    });
    const res = await POST(post({ token: TOKEN }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.explanation).toContain('signaux');
    expect(body.completeness).toBe('partial');
    expect(body.costUsd).toBe(0.019);
  });

  it('remonte les limites de chaque source', async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0 }, violations: [] });
    const body = (await (await POST(post({ token: TOKEN }))).json()) as {
      sources: { name: string; note?: string }[];
    };
    expect(body.sources.find((s) => s.name === 'robinhood-rpc')?.note).toBe('tronqué');
  });

  // Une sortie non conforme ne doit jamais atteindre l'utilisateur.
  it('refuse de servir une explication contenant un score', async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({
      text: 'Ce token obtient 9/10.',
      cost: { costUsd: 0.01 },
      violations: [{ kind: 'score', matched: '9/10' }],
    });
    const res = await POST(post({ token: TOKEN }));
    expect(res.status).toBe(502);
  });

  it('traduit un rate limit en 429', async () => {
    collect.mockRejectedValue(new RateLimitError('robinhood-rpc'));
    expect((await POST(post({ token: TOKEN }))).status).toBe(429);
  });

  it('traduit un not-found en 404', async () => {
    collect.mockRejectedValue(new NotFoundError('dexscreener', 'token'));
    expect((await POST(post({ token: TOKEN }))).status).toBe(404);
  });

  it('ne laisse pas fuiter une erreur inattendue', async () => {
    collect.mockRejectedValue(new Error('stack trace interne'));
    const res = await POST(post({ token: TOKEN }));
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(500);
    expect(body.error).not.toContain('stack trace');
  });
});
