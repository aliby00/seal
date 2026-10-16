import { TtlCache } from './cache';
import { log } from './logger';
import { sharedRedis } from './store';

/**
 * A cache seen by every instance: Redis first, this instance's memory as the
 * fallback. A value is JSON in Redis, so only plain data belongs here.
 *
 * Reads check memory before Redis (a hit there costs no round trip); writes
 * go to both. A Redis failure is logged and ignored: the value is computed
 * again, which costs money but never an error page.
 */
export class SharedCache<T> {
  private readonly memory: TtlCache<T>;
  private readonly prefix: string;
  private readonly ttlMs: number;
  private readonly keep: (value: T) => boolean;

  constructor(options: {
    prefix: string;
    ttlMs: number;
    keep?: (value: T) => boolean;
    maxEntries?: number;
    now?: () => number;
  }) {
    this.prefix = options.prefix;
    this.ttlMs = options.ttlMs;
    this.keep = options.keep ?? (() => true);
    this.memory = new TtlCache<T>({
      ttlMs: options.ttlMs,
      maxEntries: options.maxEntries ?? 200,
      now: options.now,
    });
  }

  async get(key: string): Promise<T | undefined> {
    const local = this.memory.get(key);
    if (local !== undefined) return local;
    const redis = sharedRedis();
    if (!redis) return undefined;
    try {
      const [raw] = await redis.pipeline([['GET', `${this.prefix}:${key}`]]);
      if (typeof raw !== 'string') return undefined;
      const value = JSON.parse(raw) as T;
      this.memory.set(key, value);
      return value;
    } catch (error) {
      log.warn('cache partagé illisible', { prefix: this.prefix, error: String(error) });
      return undefined;
    }
  }

  /** Stores the value when `keep` accepts it; returns whether it was stored. */
  async set(key: string, value: T): Promise<boolean> {
    if (!this.keep(value)) return false;
    this.memory.set(key, value);
    const redis = sharedRedis();
    if (!redis) return true;
    try {
      await redis.pipeline([
        ['SET', `${this.prefix}:${key}`, JSON.stringify(value), 'PX', this.ttlMs],
      ]);
    } catch (error) {
      log.warn('cache partagé non écrit', { prefix: this.prefix, error: String(error) });
    }
    return true;
  }

  clear(): void {
    this.memory.clear();
  }
}
