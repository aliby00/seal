import { beforeEach, describe, expect, it } from 'vitest';
import { resetThrottle, throttle } from '../../src/lib/throttle';

/** A fake clock: sleeping moves time forward instead of waiting. */
function clock() {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe('throttle', () => {
  beforeEach(() => resetThrottle());

  it('lets a first batch through at once', async () => {
    const c = clock();
    await throttle('rpc://a', 19, { rate: 4, burst: 20, ...c });
    expect(c.waits).toEqual([]);
  });

  // The measured failure: a second batch sent right after the first got 429 for ~5 s.
  it('makes a second batch wait for the allowance to refill', async () => {
    const c = clock();
    await throttle('rpc://a', 19, { rate: 4, burst: 20, ...c });
    await throttle('rpc://a', 19, { rate: 4, burst: 20, ...c });
    // 19 calls at 4 per second, minus the one left over: about 4.5 s.
    expect(c.waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4_000);
  });

  it('paces each node separately', async () => {
    const c = clock();
    await throttle('rpc://a', 20, { rate: 4, burst: 20, ...c });
    await throttle('rpc://b', 20, { rate: 4, burst: 20, ...c });
    expect(c.waits).toEqual([]);
  });

  // A reader's time cap used to leave its queued calls in the queue: each
  // still took its turn, and the readers still running waited behind them.
  it('lets a cut call leave the queue without taking a turn', async () => {
    const c = clock();
    await throttle('rpc://a', 1, { rate: 1, burst: 1, ...c });
    const cut = new AbortController();
    const queued = throttle('rpc://a', 1, {
      rate: 1,
      burst: 1,
      now: c.now,
      signal: cut.signal,
      sleep: async (ms) => {
        await c.sleep(ms);
        cut.abort(new Error('time cap'));
      },
    });
    await expect(queued).rejects.toThrow('time cap');
    const waited = c.waits.length;
    // The turn the cut call did not take is still there.
    await throttle('rpc://a', 1, { rate: 1, burst: 1, ...c });
    expect(c.waits.length).toBe(waited);
  });

  it('cuts a real wait at once', async () => {
    await throttle('rpc://b', 1, { rate: 0.01, burst: 1 });
    const cut = new AbortController();
    const started = Date.now();
    // The next turn is 100 s away.
    const queued = throttle('rpc://b', 1, { rate: 0.01, burst: 1, signal: cut.signal });
    setTimeout(() => cut.abort(new Error('gone')), 20);
    await expect(queued).rejects.toThrow('gone');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never waits forever on a batch larger than the rate', async () => {
    const c = clock();
    await throttle('rpc://a', 50, { rate: 4, burst: 20, ...c });
    await throttle('rpc://a', 50, { rate: 4, burst: 20, ...c });
    expect(c.waits.length).toBeGreaterThan(0);
  });
});
