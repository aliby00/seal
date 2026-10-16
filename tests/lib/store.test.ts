import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRedisClient,
  redisConfig,
  setSharedRedis,
  storeKind,
  type RedisClient,
  type RedisCommand,
} from '../../src/lib/store';
import { allowShared, resetRateLimits, type RateLimit } from '../../src/lib/guard';
import { SharedCache } from '../../src/lib/shared-cache';
import { keepAnalysis, type CachedAnalysis } from '../../src/lib/analysis-cache';

/**
 * A stand-in for Upstash: GET, SET … PX, and the bucket script, run in JS
 * with the same arithmetic as the Lua one. Two "instances" sharing it see the
 * same counts — which is the whole point.
 */
function fakeRedis(): RedisClient & { data: Map<string, unknown>; calls: RedisCommand[] } {
  const data = new Map<string, unknown>();
  const calls: RedisCommand[] = [];
  return {
    data,
    calls,
    async pipeline(commands) {
      calls.push(...commands);
      return commands.map((command) => {
        const [name, ...args] = command;
        if (name === 'GET') return data.get(String(args[0])) ?? null;
        if (name === 'SET') {
          data.set(String(args[0]), args[1]);
          return 'OK';
        }
        if (name === 'EVAL') {
          const [, , key, cap, rate, now] = args as [
            string,
            number,
            string,
            number,
            number,
            number,
          ];
          const bucket = (data.get(key) as { t: number; u: number } | undefined) ?? {
            t: cap,
            u: now,
          };
          const t = Math.min(cap, bucket.t + Math.max(0, now - bucket.u) * rate);
          const ok = t >= 1;
          data.set(key, { t: ok ? t - 1 : t, u: now });
          return ok ? 1 : 0;
        }
        throw new Error(`unexpected ${String(name)}`);
      });
    },
  };
}

const failing: RedisClient = {
  pipeline: () => Promise.reject(new Error('down')),
};

const LIMIT: RateLimit = { capacity: 5, perMinute: 6 };

afterEach(() => {
  setSharedRedis(undefined);
  resetRateLimits();
});

describe('redisConfig', () => {
  it('reads the variables the Vercel integration sets, and nothing else', () => {
    expect(redisConfig({})).toBeNull();
    expect(
      redisConfig({ KV_REST_API_URL: 'https://r.upstash.io/', KV_REST_API_TOKEN: 't' }),
    ).toEqual({
      url: 'https://r.upstash.io',
      token: 't',
    });
    expect(storeKind({ KV_REST_API_URL: 'https://r.upstash.io' })).toBe('memory');
  });
});

describe('createRedisClient', () => {
  it('sends the commands as one pipeline and returns each result', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json([{ result: 'OK' }, { result: 'v' }]),
    ) as unknown as typeof fetch;
    const client = createRedisClient({ url: 'https://r.upstash.io', token: 'secret' }, fetchImpl);
    await expect(
      client.pipeline([
        ['SET', 'k', 'v'],
        ['GET', 'k'],
      ]),
    ).resolves.toEqual(['OK', 'v']);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://r.upstash.io/pipeline');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(JSON.parse(String(init.body))).toEqual([
      ['SET', 'k', 'v'],
      ['GET', 'k'],
    ]);
  });

  it('turns an HTTP or command error into a throw, for the caller to fall back', async () => {
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(
      createRedisClient({ url: 'u', token: 't' }, down).pipeline([['GET', 'k']]),
    ).rejects.toThrow();
    const bad = (async () => Response.json([{ error: 'ERR' }])) as unknown as typeof fetch;
    await expect(
      createRedisClient({ url: 'u', token: 't' }, bad).pipeline([['GET', 'k']]),
    ).rejects.toThrow();
  });
});

describe('allowShared', () => {
  it('counts in Redis, so the burst is shared by every instance', async () => {
    setSharedRedis(fakeRedis());
    const results = [];
    for (let i = 0; i < 8; i += 1) results.push(await allowShared('analyze:1.2.3.4', LIMIT, 0));
    expect(results.filter(Boolean)).toHaveLength(5);
    // Six per minute: one more after ten seconds.
    expect(await allowShared('analyze:1.2.3.4', LIMIT, 10_000)).toBe(true);
    expect(await allowShared('analyze:5.6.7.8', LIMIT, 10_000)).toBe(true);
  });

  it('falls back to memory when Redis fails, rather than refusing everyone', async () => {
    setSharedRedis(failing);
    expect(await allowShared('analyze:x', LIMIT, 0)).toBe(true);
  });
});

describe('SharedCache', () => {
  it('serves a value written by another instance', async () => {
    const redis = fakeRedis();
    setSharedRedis(redis);
    const writer = new SharedCache<{ n: number }>({ prefix: 'p', ttlMs: 60_000 });
    const reader = new SharedCache<{ n: number }>({ prefix: 'p', ttlMs: 60_000 });
    await writer.set('k', { n: 1 });
    expect(await reader.get('k')).toEqual({ n: 1 });
    expect(redis.calls.find((c) => c[0] === 'SET')).toEqual([
      'SET',
      'p:k',
      '{"n":1}',
      'PX',
      60_000,
    ]);
  });

  it('keeps nothing the keep rule refuses', async () => {
    setSharedRedis(fakeRedis());
    const cache = new SharedCache<{ n: number }>({ prefix: 'p', ttlMs: 1, keep: (v) => v.n > 0 });
    expect(await cache.set('k', { n: 0 })).toBe(false);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('still works from memory when Redis is down', async () => {
    setSharedRedis(failing);
    const cache = new SharedCache<{ n: number }>({ prefix: 'p', ttlMs: 60_000 });
    await cache.set('k', { n: 2 });
    expect(await cache.get('k')).toEqual({ n: 2 });
    expect(await new SharedCache({ prefix: 'p', ttlMs: 1 }).get('other')).toBeUndefined();
  });
});

describe('keepAnalysis', () => {
  const body: CachedAnalysis = {
    token: '0x1',
    explanation: 'ok',
    completeness: 'full',
    sources: [{ name: 'robinhood-rpc' }],
    costUsd: 0.01,
    collectedAt: '',
    offline: false,
  };

  it('keeps a complete answer', () => {
    expect(keepAnalysis(body, true)).toBe(true);
  });

  it('does not keep a read the node cut short', () => {
    expect(
      keepAnalysis(
        { ...body, sources: [{ name: 'robinhood-rpc', note: 'The chain node was busy' }] },
        true,
      ),
    ).toBe(false);
  });

  it.each([
    'upstream : HTTP status 401',
    'incomplete : response missing the `items` field',
    'timeout : no answer after 15000 ms',
  ])('does not keep a source that failed (%s)', (note) => {
    expect(keepAnalysis({ ...body, sources: [{ name: 'blockscout', note }] }, true)).toBe(false);
  });

  it('keeps a source that simply has nothing to show', () => {
    const note = 'no pair indexed by DexScreener for this token';
    expect(keepAnalysis({ ...body, sources: [{ name: 'dexscreener', note }] }, true)).toBe(true);
  });

  it('does not keep an offline text when a model is configured (a provider hiccup)', () => {
    expect(keepAnalysis({ ...body, offline: true }, true)).toBe(false);
    expect(keepAnalysis({ ...body, offline: true }, false)).toBe(true);
  });
});
