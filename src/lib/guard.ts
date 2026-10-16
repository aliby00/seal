import { NextResponse } from 'next/server';
import { log } from './logger';
import { sharedRedis } from './store';

/**
 * Entry checks shared by the public POST routes. Each analysis spends upstream
 * requests and, with a key, model tokens: an anonymous caller must not be able
 * to spend them without limit, nor from another website.
 *
 * The count lives in Redis when it is configured, so every instance sees the
 * same buckets. Without Redis, or when it fails, each instance counts in its
 * own memory: weaker (requests spread over instances each get a burst), but
 * the site keeps answering.
 */

/** Largest body accepted: an address and a small agent spec fit well under it. */
export const MAX_BODY_BYTES = 4_096;

export type RateLimit = { capacity: number; perMinute: number };

/** /api/analyze: a short burst, then one analysis every ten seconds. */
export const ANALYZE_LIMIT: RateLimit = { capacity: 5, perMinute: 6 };
/** /api/agent may call the largest model tier: stricter. */
export const AGENT_LIMIT: RateLimit = { capacity: 3, perMinute: 3 };

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();
const MAX_TRACKED = 10_000;

export function resetRateLimits(): void {
  buckets.clear();
}

/** Spends one request for `key`; `false` when the caller is over the limit. */
export function allow(key: string, limit: RateLimit, now = Date.now()): boolean {
  let bucket = buckets.get(key);
  if (!bucket) {
    // Bounded memory: forget the oldest caller rather than grow forever.
    if (buckets.size >= MAX_TRACKED) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    bucket = { tokens: limit.capacity, updatedAt: now };
    buckets.set(key, bucket);
  }
  bucket.tokens = Math.min(
    limit.capacity,
    bucket.tokens + ((now - bucket.updatedAt) / 60_000) * limit.perMinute,
  );
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * The same token bucket as `allow`, kept in Redis and updated atomically by a
 * script, so simultaneous requests on different instances share one count.
 * Returns 1 when the request may proceed.
 */
const BUCKET_SCRIPT = `
local v = redis.call('HMGET', KEYS[1], 't', 'u')
local cap = tonumber(ARGV[1])
local now = tonumber(ARGV[3])
local t = tonumber(v[1])
local u = tonumber(v[2])
if t == nil or u == nil then t = cap; u = now end
t = math.min(cap, t + math.max(0, now - u) * tonumber(ARGV[2]))
local ok = 0
if t >= 1 then t = t - 1; ok = 1 end
redis.call('HSET', KEYS[1], 't', tostring(t), 'u', tostring(now))
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return ok
`;

/** Spends one request in the shared bucket; falls back to memory if Redis is absent or fails. */
export async function allowShared(
  key: string,
  limit: RateLimit,
  now = Date.now(),
): Promise<boolean> {
  const redis = sharedRedis();
  if (!redis) return allow(key, limit, now);
  // A bucket untouched for the time it takes to refill is full again: let it expire.
  const refillMs = Math.ceil((limit.capacity / limit.perMinute) * 60_000) + 1_000;
  try {
    const [result] = await redis.pipeline([
      [
        'EVAL',
        BUCKET_SCRIPT,
        1,
        `seal:rl:${key}`,
        limit.capacity,
        limit.perMinute / 60_000,
        now,
        refillMs,
      ],
    ]);
    return Number(result) === 1;
  } catch (error) {
    log.warn('limite partagée indisponible, repli mémoire', { error: String(error) });
    return allow(key, limit, now);
  }
}

/** The caller's address as Vercel reports it. Not a secret, only a bucket key. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'unknown';
}

/**
 * A browser on another site can send a "simple" POST without any preflight.
 * Browsers say where a request comes from; a request from another origin is
 * refused. Server-to-server calls (the smoke tests, curl) send neither header.
 */
export function crossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

function refuse(status: number, error: string, headers?: Record<string, string>) {
  return NextResponse.json({ error }, { status, ...(headers ? { headers } : {}) });
}

/**
 * Runs every check and reads the JSON body. Returns either the parsed body or
 * the response to send back as is.
 */
export async function guardedJson(
  request: Request,
  limit: RateLimit,
  scope: string,
): Promise<{ body: unknown } | { response: Response }> {
  if (crossSite(request)) return { response: refuse(403, 'Cross-site requests are not accepted') };

  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    return { response: refuse(415, 'Send the request as application/json') };
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return { response: refuse(413, 'Request body too large') };

  if (!(await allowShared(`${scope}:${clientKey(request)}`, limit))) {
    return {
      response: refuse(429, 'Too many analyses from this address. Try again in a minute.', {
        'retry-after': '60',
      }),
    };
  }

  // content-length can be absent or wrong: the body itself is measured too.
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { response: refuse(413, 'Request body too large') };
  }
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { response: refuse(400, 'Unreadable request body') };
  }
}
