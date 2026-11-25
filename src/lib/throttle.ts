/**
 * Pacing of a node: a token bucket per URL, shared by every client of the
 * same URL in this process, so that concurrent analyses on one server
 * instance pace each other too.
 *
 * Moved here from the Robinhood Chain client (chain/rpc.ts) when the EVM
 * reads were retired: the Solana client paces its nodes with it.
 */

/** Burst allowed when the caller does not give one. */
export const DEFAULT_BURST = 20;

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();

/** Waits until `cost` calls fit in the allowance of `url`, then spends them. */
export async function throttle(
  url: string,
  cost: number,
  options: {
    /** Calls a second the bucket refills with. */
    rate: number;
    burst?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const rate = options.rate;
  const burst = Math.max(options.burst ?? DEFAULT_BURST, rate);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const need = Math.min(cost, burst);
  const bucket = buckets.get(url) ?? { tokens: burst, updatedAt: now() };
  buckets.set(url, bucket);
  for (;;) {
    const t = now();
    bucket.tokens = Math.min(burst, bucket.tokens + ((t - bucket.updatedAt) / 1000) * rate);
    bucket.updatedAt = t;
    if (bucket.tokens >= need) {
      bucket.tokens -= need;
      return;
    }
    await sleep(Math.ceil(((need - bucket.tokens) / rate) * 1000));
  }
}

/** Forget the pacing state. For tests. */
export function resetThrottle(): void {
  buckets.clear();
}
