import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError } from '../../src/lib/errors';
import { BudgetExhaustedError, request } from '../../src/lib/http';
import { limitRpc, ReadCapError } from '../../src/lib/solana/creator';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import { readHolders } from '../../src/lib/solana/holders';
import { replayLaunch } from '../../src/lib/solana/launch';
import {
  abortable,
  createSolanaRpc,
  PUBLIC_SOLANA_RPC_URL,
  resetSolanaNodes,
  solanaRpcFrom,
  type SolanaNode,
} from '../../src/lib/solana/rpc';
import { readToken } from '../../src/lib/solana/token';
import { resetThrottle } from '../../src/lib/throttle';

/**
 * A reader's time cap cuts its requests for real: the signal reaches the
 * fetch, the call rejects at once with the reader's own reason, and the node
 * is not blamed for it. One client serves a whole analysis, with a global
 * ceiling of calls.
 */

const KEYED: SolanaNode = { url: 'https://keyed.example/v2/k', label: 'alchemy', public: false };
const PUBLIC: SolanaNode = { url: PUBLIC_SOLANA_RPC_URL, label: 'public', public: true };
const fast = { rate: () => 1e6, sleep: async () => undefined };
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

beforeEach(() => {
  resetThrottle();
  resetSolanaNodes();
});
afterEach(() => vi.unstubAllGlobals());

/** A node that never answers, but lets go when the request's signal aborts, as fetch does. */
function hangingNode() {
  const signals: (AbortSignal | undefined)[] = [];
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    });
  });
  return { signals, urls };
}

/** A client whose every call hangs, recording the signal each call carried. */
function hangingCalls() {
  const seen: (AbortSignal | undefined)[] = [];
  const rpc = solanaRpcFrom(
    <T>(_method: string, _params: readonly unknown[], signal?: AbortSignal) => {
      seen.push(signal);
      return new Promise<T>(() => {});
    },
  );
  return { rpc, seen };
}

describe('the real client and a signal', () => {
  it('passes the signal to fetch, rejects with its reason, and does not retry', async () => {
    const node = hangingNode();
    const rpc = createSolanaRpc({ nodes: [KEYED], ...fast });
    const cut = new AbortController();
    const pending = rpc.withSignal!(cut.signal).getSlot();
    await vi.waitFor(() => expect(node.signals).toHaveLength(1));
    const reason = new TimeoutError('solana-rpc', 123);
    cut.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(node.signals[0]?.aborted).toBe(true);
    // The caller gave up: the last node is not asked again.
    await new Promise((r) => setTimeout(r, 10));
    expect(node.urls).toHaveLength(1);
  });

  it('does not hand a call the caller cut to the next node, nor set the node aside', async () => {
    const node = hangingNode();
    const rpc = createSolanaRpc({ nodes: [KEYED, PUBLIC], ...fast });
    const cut = new AbortController();
    const pending = rpc.withSignal!(cut.signal).getSlot();
    await vi.waitFor(() => expect(node.urls).toHaveLength(1));
    cut.abort(new TimeoutError('solana-rpc', 1));
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await new Promise((r) => setTimeout(r, 10));
    expect(node.urls).toEqual([KEYED.url]);
    // The keyed node is still asked first on the next call.
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      node.urls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
    });
    expect(await rpc.getSlot()).toBe(7);
    expect(node.urls.at(-1)).toBe(KEYED.url);
  });

  it('sends nothing once the signal has aborted', async () => {
    const node = hangingNode();
    const rpc = createSolanaRpc({ nodes: [KEYED], ...fast });
    const cut = new AbortController();
    cut.abort(new TimeoutError('solana-rpc', 0));
    await expect(rpc.withSignal!(cut.signal).getSlot()).rejects.toBeInstanceOf(TimeoutError);
    expect(node.urls).toEqual([]);
  });

  it('shares one ceiling of calls across every view of the client', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 })),
    );
    const rpc = createSolanaRpc({ nodes: [KEYED], maxCalls: 2, ...fast });
    const a = rpc.withSignal!(new AbortController().signal);
    const b = abortable(rpc, new AbortController().signal);
    await a.getSlot();
    await b.getSlot();
    await expect(rpc.getSlot()).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(rpc.usage()).toEqual({ spent: 2, max: 2 });
  });
});

describe('abortable', () => {
  it('settles a call of a client that does not listen to signals', async () => {
    const rpc = { ...createFakeSolanaRpc([]), getSlot: () => new Promise<number>(() => {}) };
    const cut = new AbortController();
    const pending = abortable(rpc, cut.signal).getSlot();
    cut.abort(new TimeoutError('solana-rpc', 5));
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
  });

  it('keeps a method set by hand over the built ones', async () => {
    const fake = createFakeSolanaRpc([{ method: 'getSlot', result: 1 }]);
    const rpc = { ...fake, getSlot: async () => 42 };
    expect(await abortable(rpc, new AbortController().signal).getSlot()).toBe(42);
  });
});

describe('every reader’s time cap aborts its requests', () => {
  it('readToken', async () => {
    const { rpc, seen } = hangingCalls();
    const result = await readToken(USDC, rpc, { timeoutMs: 20 });
    expect(result.completeness).toBe('unavailable');
    expect(seen[0]?.aborted).toBe(true);
  });

  it('readHolders', async () => {
    const { rpc, seen } = hangingCalls();
    const result = await readHolders(USDC, rpc, { timeoutMs: 20 });
    expect(result.completeness).toBe('unavailable');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s?.aborted)).toBe(true);
  });

  it('the creator reads (limitRpc): an aborted call fails as the time cap', async () => {
    const { rpc, seen } = hangingCalls();
    const limited = limitRpc(rpc, { timeoutMs: 20 });
    await expect(limited.getSlot()).rejects.toBeInstanceOf(ReadCapError);
    expect(seen[0]?.aborted).toBe(true);
  });

  it('replayLaunch: a call in flight at the deadline is cut, and the replay says it stopped', async () => {
    const { rpc, seen } = hangingCalls();
    const replay = await replayLaunch(USDC, rpc, { deadlineMs: 20 });
    expect(replay.completeness).not.toBe('full');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s?.aborted)).toBe(true);
  });
});

describe('http: a caller that gave up', () => {
  it('is not retried and spends nothing more', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });
    const cut = new AbortController();
    const budget = { max: 5, spent: 0 };
    const pending = request('https://x.example', {
      source: 'solana-rpc',
      retries: 3,
      budget,
      sleep: async () => undefined,
      init: { signal: cut.signal },
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    cut.abort();
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toBe(1);
    expect(budget.spent).toBe(1);
  });
});
