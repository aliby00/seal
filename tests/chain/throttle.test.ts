import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configuredRate,
  DEFAULT_RPC_URL,
  logQueries,
  resetThrottle,
  RPC_CALLS_PER_SECOND,
  throttle,
} from '../../src/lib/chain/rpc';

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

  it('never waits forever on a batch larger than the rate', async () => {
    const c = clock();
    await throttle('rpc://a', 50, { rate: 4, burst: 20, ...c });
    await throttle('rpc://a', 50, { rate: 4, burst: 20, ...c });
    expect(c.waits.length).toBeGreaterThan(0);
  });
});

describe('logQueries', () => {
  it('counts only eth_getLogs, single or batched', () => {
    expect(logQueries({ method: 'eth_blockNumber' })).toBe(0);
    expect(logQueries({ method: 'eth_getLogs' })).toBe(1);
    expect(
      logQueries([{ method: 'eth_getLogs' }, { method: 'eth_call' }, { method: 'eth_getLogs' }]),
    ).toBe(2);
  });
});

describe('configuredRate', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('raises the pace of a configured node, never of the public one', () => {
    vi.stubEnv('SEAL_RPC_RATE', '50');
    vi.stubEnv('SEAL_PUBLIC_RPC_RATE', '');
    expect(configuredRate('https://paid.example')).toBe(50);
    expect(configuredRate(DEFAULT_RPC_URL)).toBe(RPC_CALLS_PER_SECOND);
  });
});
