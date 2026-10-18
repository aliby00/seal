import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

const collect = vi.hoisted(() => vi.fn());
const explain = vi.hoisted(() => vi.fn());
const briefSpecialists = vi.hoisted(() => vi.fn());

vi.mock('@/lib/collect', () => ({ collect }));
vi.mock('@/lib/agent/reason', () => ({ explain }));
vi.mock('@/lib/specialists/brief', () => ({
  briefSpecialists,
  startSpecialists: () => undefined,
  SPECIALIST_TIMEOUT_MS: 12_000,
}));

const { POST } = await import('../../src/app/api/analyze/route');
briefSpecialists.mockResolvedValue({ answers: [], unanswered: [], name: null, symbol: null });
const { RateLimitError, NotFoundError } = await import('../../src/lib/errors');
const { resetRateLimits } = await import('../../src/lib/guard');
const { analysisCache } = await import('../../src/lib/analysis-cache');

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
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// The ten questions answered, unless a test says otherwise: a question
// left unanswered makes the report partial, and it is then not cached.
const answered = { answers: [], unanswered: [], name: null, symbol: null };

afterEach(() => {
  vi.clearAllMocks();
  briefSpecialists.mockReset();
  briefSpecialists.mockResolvedValue(answered);
  resetRateLimits();
  analysisCache.clear();
});

describe('POST /api/analyze', () => {
  it('refuse une adresse invalide sans rien collecter', async () => {
    const res = await POST(post({ token: 'bonjour' }));
    expect(res.status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });

  it('dit clairement qu’un token trop long à lire peut être relancé', async () => {
    vi.useFakeTimers();
    try {
      collect.mockReturnValue(new Promise(() => {}));
      const pending = POST(post({ token: TOKEN }));
      await vi.advanceTimersByTimeAsync(30_001);
      const res = await pending;
      expect(res.status).toBe(504);
      expect(((await res.json()) as { error: string }).error).toMatch(/took too long/);
      expect(explain).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

describe('configuration', () => {
  // The bug: RPC_URL was only read by /api/agent, so a paid node set on
  // Vercel would never have been used by the main analysis.
  it('passes RPC_URL to the pipeline, and ignores it when empty', async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0 }, violations: [] });
    vi.stubEnv('RPC_URL', 'https://rpc.example/key');
    await POST(post({ token: TOKEN }));
    expect(collect).toHaveBeenLastCalledWith(
      TOKEN,
      expect.objectContaining({ rpcUrl: 'https://rpc.example/key' }),
    );
    vi.stubEnv('RPC_URL', '');
    analysisCache.clear();
    await POST(post({ token: TOKEN }));
    expect(collect).toHaveBeenLastCalledWith(TOKEN, expect.objectContaining({ rpcUrl: undefined }));
    vi.unstubAllEnvs();
  });

  // The same token asked twice spends one model call: the second answer is
  // the first one, marked as cached and free.
  it('sert une analyse déjà faite depuis le cache, sans rien dépenser', async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({
      text: 'ok',
      cost: { costUsd: 0.012 },
      violations: [],
      offline: false,
    });
    await POST(post({ token: TOKEN }));
    // Same token, other casing (the checksummed form): same cache entry.
    const res = await POST(post({ token: getAddress(TOKEN) }));
    const body = (await res.json()) as { costUsd: number; cached?: boolean; explanation: string };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ costUsd: 0, cached: true, explanation: 'ok' });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('ne garde pas une lecture coupée par le nœud', async () => {
    collect.mockResolvedValue({
      ...report,
      creator: {
        ...report.creator,
        sources: [{ name: 'robinhood-rpc', note: 'their other launches could not be read' }],
      },
    });
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0.01 }, violations: [] });
    await POST(post({ token: TOKEN }));
    await POST(post({ token: TOKEN }));
    expect(collect).toHaveBeenCalledTimes(2);
  });
});

describe('a partial report (fourth audit)', () => {
  // AI, 18/10/2026: served and cached with "no other launch" while the indexer had not answered.
  it('is never cached when a read failed, even without a source note saying so', async () => {
    collect.mockResolvedValue({
      ...report,
      creator: { ...report.creator, sources: [{ name: 'robinhood-rpc' }] },
      failedReads: [{ read: 'creator-launches', note: 'the SEAL indexer did not answer' }],
    });
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0.01 }, violations: [] });
    await POST(post({ token: TOKEN }));
    await POST(post({ token: TOKEN }));
    expect(collect).toHaveBeenCalledTimes(2);
  });
});

describe('questions out of time (fifth audit)', () => {
  // AI, 18/10/2026: six of ten questions "did not finish in time", no
  // partial notice, and the report cached.
  it('makes the report partial and keeps it out of the cache', async () => {
    collect.mockResolvedValue(structuredClone(report));
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0.01 }, violations: [] });
    briefSpecialists.mockResolvedValue({
      name: null,
      symbol: null,
      answers: Array.from({ length: 10 }, () => ({
        specialist: 'code-reuse',
        title: 't',
        question: 'q',
        signal: 'unknown',
        facts: [],
        limits: ['the on-chain lookups for this question did not finish in time'],
      })),
      unanswered: [
        'code-reuse',
        'wallet-age',
        'funding-trace',
        'name-clone',
        'liquidity-move',
        'rule-change',
      ],
    });
    // The stub report has no facts to draw: the failed read is checked where the model gets it.
    await POST(post({ token: TOKEN }));
    expect(explain.mock.calls.at(-1)?.[0].failedReads).toEqual([
      expect.objectContaining({ read: 'questions' }),
    ]);
    await POST(post({ token: TOKEN }));
    expect(collect).toHaveBeenCalledTimes(2);
  });
});

describe('specialists and timeline', () => {
  it('serves the ten answers and the token name beside the explanation', async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0.01 }, violations: [] });
    briefSpecialists.mockResolvedValue({
      name: 'Alpha',
      symbol: 'ALP',
      answers: [
        {
          specialist: 'holder-spread',
          title: 'Holder Spread',
          question: 'How much of the supply sits in a few wallets?',
          signal: 'quiet',
          facts: ['x'],
          limits: [],
        },
      ],
    });
    const body = (await (await POST(post({ token: TOKEN }))).json()) as Record<string, unknown>;
    expect(body.name).toBe('Alpha');
    expect(body.symbol).toBe('ALP');
    expect(body.specialists).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/score|verdict|\d+\s*\/\s*10\b/i);
    // The answers reach the model, so the text and the tiles tell one story.
    expect(explain.mock.calls.at(-1)?.[1]).toMatchObject({
      specialists: [expect.objectContaining({ specialist: 'holder-spread' })],
    });
    // Their time is bounded so the request stays under maxDuration.
    const timeoutMs = briefSpecialists.mock.calls.at(-1)?.[2]?.timeoutMs as number;
    expect(timeoutMs).toBeGreaterThanOrEqual(1_000);
    expect(timeoutMs).toBeLessThanOrEqual(12_000);
  });

  it('still serves the analysis when the specialists fail', async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0.01 }, violations: [] });
    briefSpecialists.mockRejectedValue(new Error('node down'));
    const res = await POST(post({ token: TOKEN }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.specialists).toBeUndefined();
    expect(body.explanation).toBe('ok');
  });
});
