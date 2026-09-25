import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetExhaustedError,
  backoffDelay,
  createBudget,
  parseRetryAfter,
  request,
} from '../../src/lib/http';
import { RateLimitError, TimeoutError, UpstreamError } from '../../src/lib/errors';

/** Aucun test ne dort pour de vrai : le sleep est injecté et enregistre ses appels. */
function recordingSleep() {
  const calls: number[] = [];
  return { calls, sleep: async (ms: number) => void calls.push(ms) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(responses: (Response | Error)[]) {
  let i = 0;
  const spy = vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('parseRetryAfter', () => {
  it('lit un nombre de secondes', () => {
    expect(parseRetryAfter('30')).toBe(30);
  });

  it('lit une date HTTP et la convertit en secondes', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:45 GMT', now)).toBe(45);
  });

  it('ne renvoie jamais de valeur négative pour une date passée', () => {
    const now = Date.parse('2026-01-01T00:01:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('ignore une valeur illisible', () => {
    expect(parseRetryAfter('bientôt')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('backoffDelay', () => {
  it('croît de façon exponentielle', () => {
    expect(backoffDelay(0, 1)).toBeLessThan(backoffDelay(1, 1));
    expect(backoffDelay(1, 1)).toBeLessThan(backoffDelay(2, 1));
  });

  it('reste borné par le jitter, sans jamais tomber à zéro', () => {
    expect(backoffDelay(0, 0)).toBeGreaterThan(0);
  });
});

describe('request', () => {
  it('renvoie la réponse quand tout va bien', async () => {
    stubFetch([new Response('{}', { status: 200 })]);
    const res = await request('https://exemple.test', { source: 'dexscreener' });
    expect(res.status).toBe(200);
  });

  it('traduit un 429 en RateLimitError', async () => {
    stubFetch([new Response('', { status: 429 })]);
    await expect(
      request('https://exemple.test', { source: 'blockscout', retries: 0 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  // Le RPC public de Robinhood Chain répond 403 après une rafale, pas 429.
  it('traite un 403 comme un rate limit, pas comme une erreur définitive', async () => {
    stubFetch([new Response('', { status: 403 })]);
    await expect(
      request('https://exemple.test', { source: 'robinhood-rpc', retries: 0 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('respecte Retry-After plutôt que son propre backoff', async () => {
    const { calls, sleep } = recordingSleep();
    stubFetch([
      new Response('', { status: 429, headers: { 'retry-after': '7' } }),
      new Response('{}', { status: 200 }),
    ]);
    await request('https://exemple.test', { source: 'blockscout', sleep });
    expect(calls).toEqual([7000]);
  });

  it('réessaie sur 5xx puis réussit', async () => {
    const { sleep } = recordingSleep();
    const spy = stubFetch([new Response('', { status: 503 }), new Response('{}', { status: 200 })]);
    const res = await request('https://exemple.test', { source: 'dexscreener', sleep });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('ne réessaie pas un 404 : rien ne changera', async () => {
    const spy = stubFetch([new Response('', { status: 404 })]);
    const res = await request('https://exemple.test', { source: 'dexscreener' });
    expect(res.status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('traduit un abort en TimeoutError', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    stubFetch([abort]);
    await expect(
      request('https://exemple.test', { source: 'robinhood-rpc', retries: 0 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('abandonne après le nombre de tentatives prévu', async () => {
    const { sleep } = recordingSleep();
    const spy = stubFetch([new Response('', { status: 503 })]);
    await expect(
      request('https://exemple.test', { source: 'dexscreener', retries: 2, sleep }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("refuse de dépasser le budget de requêtes de l'analyse", async () => {
    stubFetch([new Response('{}', { status: 200 })]);
    const budget = createBudget(2);
    const options = { source: 'blockscout' as const, budget };
    await request('https://exemple.test', options);
    await request('https://exemple.test', options);
    await expect(request('https://exemple.test', options)).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(budget.spent).toBe(2);
  });

  // Un retry consomme du budget : sinon une source instable viderait le quota
  // journalier sans que le compteur ne s'en aperçoive.
  it('compte chaque tentative dans le budget, retries inclus', async () => {
    const { sleep } = recordingSleep();
    stubFetch([new Response('', { status: 503 })]);
    const budget = createBudget(10);
    await expect(
      request('https://exemple.test', { source: 'dexscreener', retries: 2, budget, sleep }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(budget.spent).toBe(3);
  });
});
