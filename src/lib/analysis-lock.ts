import { log } from './logger';
import { sharedRedis } from './store';

/**
 * One reading of a token at a time. A mint posted in a Telegram group brings
 * many visitors in the same seconds; without this, each one started its own
 * collection (up to 300 Solana calls) and its own model call before the first
 * answer was cached, about fifteen seconds later.
 *
 * The first request takes the lock (Redis `SET NX PX`, so every instance sees
 * it); the others wait for its answer in the cache. The lock expires by
 * itself: a reading that dies with its function holds nobody for long.
 *
 * Redis is a help here as everywhere: without it, or when it fails, the lock
 * is this instance's own, and a request that cannot tell reads on its own.
 */

/** A little longer than a reading may last before the route answers 504. */
export const ANALYSIS_LOCK_MS = 45_000;

const memory = new Map<string, { owner: string; until: number }>();

export function resetAnalysisLocks(): void {
  memory.clear();
}

const keyOf = (token: string) => `seal:lock:analysis:${token}`;

/** Deletes the lock only if it is still ours: one that expired may be another request's. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

export type AnalysisLock = { release(): Promise<void> };

/**
 * Takes the lock for `token`, or `null` when another request holds it. A
 * store that does not answer counts as a lock taken: reading twice costs
 * money, never an error.
 */
export async function claimAnalysis(token: string, now = Date.now()): Promise<AnalysisLock | null> {
  const owner = crypto.randomUUID();
  const redis = sharedRedis();
  const local = (): AnalysisLock | null => {
    const held = memory.get(token);
    if (held && held.until > now) return null;
    memory.set(token, { owner, until: now + ANALYSIS_LOCK_MS });
    return {
      async release() {
        if (memory.get(token)?.owner === owner) memory.delete(token);
      },
    };
  };
  if (!redis) return local();
  try {
    const [result] = await redis.pipeline([
      ['SET', keyOf(token), owner, 'NX', 'PX', ANALYSIS_LOCK_MS],
    ]);
    if (result !== 'OK') return null;
    return {
      async release() {
        try {
          await redis.pipeline([['EVAL', RELEASE_SCRIPT, 1, keyOf(token), owner]]);
        } catch (error) {
          // It expires by itself within ANALYSIS_LOCK_MS.
          log.warn('verrou de lecture non rendu', { error: String(error) });
        }
      },
    };
  } catch (error) {
    log.warn('verrou de lecture indisponible, lecture seule', { error: String(error) });
    return { async release() {} };
  }
}

/** Whether a request is still reading `token`. A store that fails says no. */
export async function analysisHeld(token: string, now = Date.now()): Promise<boolean> {
  const redis = sharedRedis();
  if (!redis) return (memory.get(token)?.until ?? 0) > now;
  try {
    const [result] = await redis.pipeline([['EXISTS', keyOf(token)]]);
    return Number(result) === 1;
  } catch {
    return false;
  }
}
