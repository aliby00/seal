/**
 * The store shared by every server instance: Upstash Redis, over its REST API.
 *
 * On Vercel each warm instance has its own memory, so a counter or a cache
 * kept there is only seen by the requests that land on that instance — the
 * load test showed 28 simultaneous analyses from one address all getting
 * through. Redis is the one place they all see.
 *
 * Redis is a help, never a dependency: when it is not configured, is slow or
 * fails, callers fall back to their in-memory version. The site must not stop
 * because its counter is unreachable.
 */

export type StoreKind = 'redis' | 'memory';

/** One Redis command, as the REST API takes it: ["SET", "key", "value", "EX", "60"]. */
export type RedisCommand = (string | number)[];

export type RedisClient = {
  /** Runs the commands in order, in one round trip; one result per command. */
  pipeline(commands: RedisCommand[]): Promise<unknown[]>;
};

/** A shared-store call that takes longer than this is abandoned for the fallback. */
export const REDIS_TIMEOUT_MS = 800;

type Env = Record<string, string | undefined>;

/** The connection, from the variables the Vercel integration sets. Null when absent. */
export function redisConfig(env: Env = process.env): { url: string; token: string } | null {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

export function storeKind(env: Env = process.env): StoreKind {
  return redisConfig(env) ? 'redis' : 'memory';
}

export function createRedisClient(
  config: { url: string; token: string },
  fetchImpl: typeof fetch = fetch,
): RedisClient {
  return {
    async pipeline(commands) {
      const response = await fetchImpl(`${config.url}/pipeline`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`redis ${response.status}`);
      const results = (await response.json()) as { result?: unknown; error?: string }[];
      if (!Array.isArray(results) || results.length !== commands.length) {
        throw new Error('redis: unexpected pipeline response');
      }
      return results.map((entry) => {
        if (entry.error) throw new Error(`redis: ${entry.error}`);
        return entry.result;
      });
    },
  };
}

let client: RedisClient | null | undefined;

/** The process-wide client, or null when Redis is not configured. */
export function sharedRedis(): RedisClient | null {
  if (client === undefined) {
    const config = redisConfig();
    client = config ? createRedisClient(config) : null;
  }
  return client;
}

/** Tests replace the client (or remove it with null); undefined reads the env again. */
export function setSharedRedis(next: RedisClient | null | undefined): void {
  client = next;
}
