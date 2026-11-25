import { afterEach, describe, expect, it, vi } from 'vitest';
import { solanaNodeHealth } from '../../src/lib/solana/health';
import { createSolanaRpc } from '../../src/lib/solana/rpc';

const alchemy = {
  url: 'https://solana-mainnet.g.alchemy.com/v2/k',
  label: 'alchemy' as const,
  public: false,
};
const pub = { url: 'https://api.mainnet-beta.solana.com', label: 'public' as const, public: true };

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('a node that refuses the key', () => {
  it('is said refused with its status at once, not waited out as a rate limit', async () => {
    const fetch = vi.fn(async () =>
      answer(403, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'SOLANA_MAINNET is not enabled for this app' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const health = await solanaNodeHealth({}, { nodes: [alchemy, pub], timeoutMs: 2_000 });
    expect(health).toMatchObject({ node: 'alchemy', slotOk: false, error: 'refused:403:network' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(health.ms).toBeLessThan(1_000);
  });

  it('hands the call to the next node in an analysis', async () => {
    const fetch = vi.fn(async (url: string) =>
      url === alchemy.url
        ? answer(401, { error: { code: -32000, message: 'Must be authenticated!' } })
        : answer(200, { jsonrpc: '2.0', id: 1, result: 123 }),
    );
    vi.stubGlobal('fetch', fetch);
    const rpc = createSolanaRpc({ nodes: [alchemy, pub], maxCalls: 5 });
    await expect(rpc.getSlot()).resolves.toBe(123);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([alchemy.url, pub.url]);
  });

  it('says a probe cut by its own deadline timed out', async () => {
    vi.stubGlobal(
      'fetch',
      (_: string, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    const health = await solanaNodeHealth({}, { nodes: [alchemy], timeoutMs: 50 });
    expect(health.error).toBe('timeout');
  });
});

describe('the reason of a refusal', () => {
  it('is one word, never the answer', async () => {
    const { refusalReason } = await import('../../src/lib/solana/rpc');
    expect(
      refusalReason(
        '{"error":{"message":"SOLANA_MAINNET is not enabled for this app. Visit https://dashboard.alchemy.com/apps/x/networks"}}',
      ),
    ).toBe('network');
    expect(refusalReason('Must be authenticated!')).toBe('key');
    expect(refusalReason('Unspecified origin not on whitelist.')).toBe('allowlist');
    expect(refusalReason('')).toBe('other');
  });
});
