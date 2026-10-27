import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  byHealth,
  createRpcClient,
  DEFAULT_RPC_URL,
  logsRpcUrls,
  parseRpcUrls,
  resetThrottle,
  HEDGE_MS,
  rpcUrls,
  SET_ASIDE_MS,
  SLOW_NODE_MS,
} from '../../src/lib/chain/rpc';
import { createBudget, BudgetExhaustedError } from '../../src/lib/http';

beforeEach(() => resetThrottle());
afterEach(() => vi.unstubAllGlobals());

type Behaviour = 'ok' | 'http-500' | 'http-429' | 'json-429' | 'network' | 'http-401' | 'json-401';

/** Each host answers the way the test says; every request is recorded. */
function nodes(behaviour: Record<string, Behaviour>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const mode = behaviour[url] ?? 'ok';
    if (mode === 'network') throw new TypeError('fetch failed');
    if (mode === 'http-500') return new Response('down', { status: 500 });
    if (mode === 'http-429') return new Response('slow down', { status: 429 });
    if (mode === 'http-401') return new Response('bad key', { status: 401 });
    if (mode === 'json-401') {
      return new Response(
        JSON.stringify({ id: 1, error: { code: -32600, message: 'Must be authenticated' } }),
        { status: 401 },
      );
    }
    if (mode === 'json-429') {
      return new Response(JSON.stringify({ id: 1, error: { code: 429, message: 'busy' } }));
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: number } | { id: number }[];
    const out = Array.isArray(body)
      ? body.map((b) => ({ id: b.id, result: url }))
      : { id: 1, result: url };
    return new Response(JSON.stringify(out));
  });
  return calls;
}

const A = 'https://a.example';
const B = 'https://b.example';

describe('node lists', () => {
  it('reads several nodes from one variable', () => {
    expect(parseRpcUrls(` ${A}, ${B} ,,`)).toEqual([A, B]);
    expect(parseRpcUrls(undefined)).toEqual([]);
  });

  it('tries the configured nodes first and always ends on the public node', () => {
    expect(rpcUrls(undefined, {})).toEqual([DEFAULT_RPC_URL]);
    expect(rpcUrls(A, { RPC_URL_FALLBACK: B })).toEqual([A, B, DEFAULT_RPC_URL]);
    expect(rpcUrls(`${A},${DEFAULT_RPC_URL}`, {})).toEqual([A, DEFAULT_RPC_URL]);
    expect(logsRpcUrls({ LOGS_RPC_URL: A, LOGS_RPC_URL_FALLBACK: B })).toEqual([
      A,
      B,
      DEFAULT_RPC_URL,
    ]);
  });
});

describe('a failing node hands the request to the next one', () => {
  it.each<Behaviour>(['http-500', 'http-429', 'json-429', 'network', 'http-401', 'json-401'])(
    'on %s',
    async (failure) => {
      const calls = nodes({ [A]: failure });
      const rpc = createRpcClient([A, B], undefined, [B]);
      await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(B);
      // The failing node is not retried: the next one is faster than a backoff.
      expect(calls).toEqual([A, B]);
    },
  );

  it('sets a failing node aside for a minute, then starts from it again', async () => {
    const behaviour: Record<string, Behaviour> = { [A]: 'http-500' };
    const calls = nodes(behaviour);
    const rpc = createRpcClient([A, B], undefined, [B]);
    await rpc.call('eth_blockNumber', []);
    behaviour[A] = 'ok';
    // Within the minute the next request goes straight to B.
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(B);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + SET_ASIDE_MS + 1);
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(A);
    expect(calls).toEqual([A, B, B, A]);
    vi.restoreAllMocks();
  });

  it('sets aside a node that answers, but slowly', async () => {
    const calls: string[] = [];
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      // A keyed provider throttling us: right, but 7 s late.
      if (url === A) clock += 7_000;
      return new Response(JSON.stringify({ id: 1, result: url }));
    });
    const rpc = createRpcClient([A, B], undefined, [B]);
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(A);
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(B);
    expect(calls).toEqual([A, B]);
    expect(SLOW_NODE_MS).toBeLessThan(7_000);
    vi.restoreAllMocks();
  });

  it('never sets aside the only node there is', () => {
    expect(byHealth([DEFAULT_RPC_URL])).toEqual([DEFAULT_RPC_URL]);
  });

  it('fails over for log queries and batches too', async () => {
    const calls = nodes({ [A]: 'http-500' });
    const rpc = createRpcClient([B], undefined, [A, B]);
    const out = await rpc.callBatch([{ method: 'eth_getLogs', params: [{}] }]);
    expect(out).toEqual([{ ok: true, value: B }]);
    expect(calls).toEqual([A, B]);
  });

  it('falls back to the public node when every configured node fails', async () => {
    const calls = nodes({ [A]: 'network', [B]: 'http-500' });
    const rpc = createRpcClient([A, B], undefined, [B]);
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(DEFAULT_RPC_URL);
    expect(calls).toEqual([A, B, DEFAULT_RPC_URL]);
  });

  it('does not fail over a spent analysis budget', async () => {
    nodes({});
    const budget = createBudget(0);
    const rpc = createRpcClient([A, B], budget, [B]);
    await expect(rpc.call('eth_blockNumber', [])).rejects.toBeInstanceOf(BudgetExhaustedError);
  });
});

describe('a node that does not answer in time', () => {
  // The keyed logs node answered some eth_getLogs in 8 s while the public
  // node took 0.15 s (19/10/2026): the second one is asked too, and wins.
  it('sends the same request to the next node and keeps the first answer', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === A) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 5_000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return new Response(JSON.stringify({ id: 1, result: url }));
    });
    const rpc = createRpcClient([A, B], undefined, [B]);
    const started = Date.now();
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(B);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(HEDGE_MS - 50);
    expect(took).toBeLessThan(HEDGE_MS + 1_000);
    expect(calls).toEqual([A, B]);
    // Set aside: the next request goes to B at once.
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(B);
    expect(calls).toEqual([A, B, B]);
  }, 10_000);
});

describe('a copy sent alongside a slow node', () => {
  // pools-share is allowed 2 requests: the copy counted as a third request
  // and the read failed with "request budget of 2 exhausted" (19/10/2026).
  it('does not count against the analysis budget', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === A) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 5_000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return new Response(JSON.stringify({ id: 1, result: url }));
    });
    const budget = createBudget(1);
    const rpc = createRpcClient([A, B], budget, [B]);
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe(B);
    expect(budget.spent).toBe(1);
  }, 10_000);
});
