import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINT, solanaReport } from '../helpers/solana-report';

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
const { analysisCache, analysisTtlMs, justServed, ANALYSIS_TTL_MS, SETTLED_ANALYSIS_TTL_MS } =
  await import('../../src/lib/analysis-cache');
const { resetAnalysisLocks } = await import('../../src/lib/analysis-lock');
const { NotFungibleError } = await import('../../src/lib/errors');

const TOKEN = MINT;
const AT = '2026-11-25T00:00:00.000Z';

const base = solanaReport();
const report = solanaReport({
  completeness: 'partial',
  creator: {
    ...base.creator,
    completeness: 'partial',
    sources: [{ name: 'solana-rpc', fetchedAt: AT, note: 'tronqué' }],
  },
  holders: {
    ...base.holders,
    completeness: 'unavailable',
    sources: [{ name: 'solana-rpc', fetchedAt: AT }],
  },
});

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
  justServed.clear();
  resetAnalysisLocks();
});

describe('POST /api/analyze', () => {
  it('refuse une adresse invalide sans rien collecter', async () => {
    const res = await POST(post({ token: 'bonjour' }));
    expect(res.status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });

  // SEAL reads Solana only: an EVM address is not a mint, and is refused before any read.
  it('refuses an EVM 0x address and a string that is not base58 of 32 bytes', async () => {
    for (const token of [
      '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9',
      'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npum0',
      'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5N',
      '',
    ]) {
      expect((await POST(post({ token }))).status).toBe(400);
    }
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

  // COVENANT (staging, 18/10/2026): no answer in 320 s. Whatever hangs past
  // every read's own timeout, the route answers before maxDuration.
  it('answers 504 by its own deadline when a step hangs past every timeout', async () => {
    vi.useFakeTimers();
    try {
      collect.mockResolvedValue(report);
      // A provider that ignores its abort signal and never answers.
      explain.mockReturnValue(new Promise(() => {}));
      const pending = POST(post({ token: TOKEN }));
      await vi.advanceTimersByTimeAsync(56_000);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      const res = await pending;
      expect(res.status).toBe(504);
      expect(((await res.json()) as { error: string }).error).toMatch(/took too long/);
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
    // The cost is logged and counted, never served to the reader.
    expect(body).not.toHaveProperty('costUsd');
  });

  it('remonte les limites de chaque source', async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0 }, violations: [] });
    const body = (await (await POST(post({ token: TOKEN }))).json()) as {
      sources: { name: string; note?: string }[];
    };
    expect(body.sources.some((s) => s.name === 'solana-rpc' && s.note === 'tronqué')).toBe(true);
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
    collect.mockRejectedValue(new RateLimitError('solana-rpc'));
    expect((await POST(post({ token: TOKEN }))).status).toBe(429);
  });

  it('refuses an NFT mint with a 422 that says so', async () => {
    collect.mockRejectedValue(new NotFungibleError('solana-rpc', TOKEN));
    const res = await POST(post({ token: TOKEN }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      'This is an NFT; SEAL reads fungible tokens.',
    );
    expect(explain).not.toHaveBeenCalled();
  });

  it('traduit un not-found en 404', async () => {
    collect.mockRejectedValue(new NotFoundError('solana-rpc', 'token mint'));
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
  // The node comes from the environment (RPC_URL's Alchemy key, SOLANA_RPC_URL):
  // the route hands the address as given, and a signal that cuts the reads at 30 s.
  it('hands the address as given, with a signal that cuts the collection', async () => {
    collect.mockResolvedValue(report);
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0 }, violations: [] });
    await POST(post({ token: TOKEN }));
    expect(collect).toHaveBeenLastCalledWith(
      TOKEN,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
    // Solana addresses are case-sensitive: the key is the address as given.
    const res = await POST(post({ token: TOKEN }));
    const body = (await res.json()) as { cached?: boolean; explanation: string };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ cached: true, explanation: 'ok' });
    expect(body).not.toHaveProperty('costUsd');
    expect(collect).toHaveBeenCalledTimes(1);
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('ne garde pas une lecture coupée par le nœud', async () => {
    collect.mockResolvedValue({
      ...report,
      creator: {
        ...report.creator,
        sources: [
          { name: 'solana-rpc', fetchedAt: AT, note: 'creation not read: call cap of 30 reached' },
        ],
      },
    });
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0.01 }, violations: [] });
    await POST(post({ token: TOKEN }));
    await POST(post({ token: TOKEN }));
    expect(collect).toHaveBeenCalledTimes(2);
  });
});

describe('a partial report (fourth audit)', () => {
  // AI, 18/10/2026: served and cached with "no other launch" while a read had not answered.
  it('is never cached when a read failed, even without a source note saying so', async () => {
    collect.mockResolvedValue({
      ...report,
      creator: { ...report.creator, sources: [{ name: 'solana-rpc', fetchedAt: AT }] },
      failedReads: [{ read: 'creator-launches', note: 'creator’s transactions not listed' }],
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

describe('a question answered from less than it asked (sixth audit)', () => {
  // AML, 18/10/2026: a chain-wide count did not answer,
  // and "14 other markets" of a 50-minute window was served as clean.
  it('makes the report partial and keeps it out of the cache', async () => {
    collect.mockResolvedValue(structuredClone(report));
    explain.mockResolvedValue({ text: 'ok', cost: { costUsd: 0.01 }, violations: [] });
    const note =
      'the chain-wide count of markets on this token’s trading rules (hook) could not be read this time; only the markets of about the last 50 minutes were compared';
    briefSpecialists.mockResolvedValue({
      ...answered,
      partial: [{ read: 'questions', note }],
    });
    await POST(post({ token: TOKEN }));
    expect(explain.mock.calls.at(-1)?.[0].failedReads).toEqual([{ read: 'questions', note }]);
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

describe('launch traffic (prod audit, 26/11/2026)', () => {
  const ok = { text: 'ok', cost: { costUsd: 0.01 }, violations: [], offline: false };
  const from = (ip: string) =>
    new Request('http://localhost/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify({ token: TOKEN }),
    });

  // Behind a mobile carrier many readers share one address: an answer served
  // from the cache spent nothing, and does not count against it.
  it('does not count answers served from the cache against the address', async () => {
    // A fresh report: the route marks a partial one in place.
    collect.mockImplementation(async () => solanaReport());
    explain.mockResolvedValue(ok);
    for (let i = 0; i < 12; i += 1) {
      expect((await POST(from('198.51.100.4'))).status).toBe(200);
    }
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('still limits the readings an address pays for', async () => {
    // A report with a failed read is never cached: every request is a reading.
    collect.mockResolvedValue({
      ...report,
      failedReads: [{ read: 'creator-launches', note: 'cut' }],
    });
    explain.mockResolvedValue(ok);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await POST(from('198.51.100.5'))).status);
    expect(statuses.filter((s) => s === 200).length).toBe(5);
    const last = await POST(from('198.51.100.5'));
    expect(last.status).toBe(429);
    expect(((await last.json()) as { error: string }).error).toMatch(/from your network/);
  });

  // A mint posted in a group: everyone asks in the same seconds. One reading,
  // the others wait for its answer.
  it('reads a token once when several ask at the same time', async () => {
    let finish: (value: unknown) => void = () => undefined;
    collect.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    explain.mockResolvedValue(ok);
    const first = POST(from('198.51.100.6'));
    const second = POST(from('198.51.100.7'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    finish(solanaReport());
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await b.json()) as { cached?: boolean }).cached).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('hands a partial answer to the requests that waited on it, not to the next one', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const partial = { ...report, failedReads: [{ read: 'creator-launches', note: 'cut' }] };
    collect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    explain.mockResolvedValue(ok);
    const first = POST(from('198.51.100.8'));
    const second = POST(from('198.51.100.9'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    finish(partial);
    await Promise.all([first, second]);
    expect(collect).toHaveBeenCalledTimes(1);
    // Asked again afterwards, it is read again.
    collect.mockResolvedValue(partial);
    await POST(from('198.51.100.10'));
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('keeps a token past its first day longer than a young one', () => {
    const now = Date.parse('2026-11-26T12:00:00.000Z');
    expect(analysisTtlMs('2026-11-20T00:00:00.000Z', now)).toBe(SETTLED_ANALYSIS_TTL_MS);
    expect(analysisTtlMs('2026-11-26T11:00:00.000Z', now)).toBe(ANALYSIS_TTL_MS);
    expect(analysisTtlMs(null, now)).toBe(ANALYSIS_TTL_MS);
    expect(SETTLED_ANALYSIS_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
