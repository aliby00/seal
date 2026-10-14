import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpcClient, DEFAULT_RPC_URL, logsRpcUrl } from '../../src/lib/chain/rpc';

afterEach(() => vi.unstubAllGlobals());

function recordHosts() {
  const hosts: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    hosts.push(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number } | { id: number }[];
    const out = Array.isArray(body)
      ? body.map((b) => ({ id: b.id, result: [] }))
      : { id: 1, result: '0x1' };
    return new Response(JSON.stringify(out), { status: 200 });
  });
  return hosts;
}

describe('log queries and plain calls go to different nodes', () => {
  // A keyed free plan (Alchemy: 10 blocks per eth_getLogs) cannot serve the
  // 10 M-block windows; the public node can. Plain calls use the key.
  it('sends plain calls to RPC_URL and logs to the logs node', async () => {
    const hosts = recordHosts();
    const rpc = createRpcClient('https://keyed.example/v2/k', undefined, 'https://logs.example');
    await rpc.call('eth_blockNumber', []);
    await rpc.callBatch([{ method: 'eth_call', params: [] }]);
    await rpc.call('eth_getLogs', [{}]);
    await rpc.callBatch([{ method: 'eth_getLogs', params: [{}] }]);
    expect(hosts).toEqual([
      'https://keyed.example/v2/k',
      'https://keyed.example/v2/k',
      'https://logs.example',
      'https://logs.example',
    ]);
  });

  it('keeps logs on the public node unless LOGS_RPC_URL says otherwise', () => {
    expect(logsRpcUrl({})).toBe(DEFAULT_RPC_URL);
    expect(logsRpcUrl({ LOGS_RPC_URL: '' })).toBe(DEFAULT_RPC_URL);
    expect(logsRpcUrl({ LOGS_RPC_URL: 'https://paid.example' })).toBe('https://paid.example');
  });
});
