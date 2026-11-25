/**
 * Pacing of a node: a token bucket per URL, shared by every client of the
 * same URL in this process, so that concurrent analyses on one server
 * instance pace each other too.
 *
 * Moved here from the Robinhood Chain client (chain/rpc.ts) when the EVM
 * reads were retired: the Solana client paces its nodes with it.
 *
 * A call waiting for its turn can be cut (`signal`): it then leaves the queue
 * at once and takes no allowance. Without that, the calls a reader had queued
 * when its time cap fired still took their turn one by one, and the readers
 * still running waited behind them (public node, 3 calls a second).
 */

/** Burst allowed when the caller does not give one. */
export const DEFAULT_BURST = 20;

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();

/** What a cut wait rejects with: the signal's reason when it is an error. */
function cutReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted while waiting for its turn');
}

/** `ms`, or less when `signal` aborts first. */
function sleepUnless(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Waits until `cost` calls fit in the allowance of `url`, then spends them.
 * Rejects with `signal`'s reason, spending nothing, once it aborts.
 */
export async function throttle(
  url: string,
  cost: number,
  options: {
    /** Calls a second the bucket refills with. */
    rate: number;
    burst?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Cuts the wait: the call leaves the queue without its turn. */
    signal?: AbortSignal;
  },
): Promise<void> {
  const rate = options.rate;
  const burst = Math.max(options.burst ?? DEFAULT_BURST, rate);
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const sleep = options.sleep ?? ((ms: number) => sleepUnless(ms, signal));
  const need = Math.min(cost, burst);
  const bucket = buckets.get(url) ?? { tokens: burst, updatedAt: now() };
  buckets.set(url, bucket);
  for (;;) {
    if (signal?.aborted) throw cutReason(signal);
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
