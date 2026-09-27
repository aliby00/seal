import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  MAX_BATCH_SIZE,
  createRpcClient,
  decodeGraduationResult,
  fetchBlockTimestamps,
  fetchGraduationStatusBatch,
  type RpcClient,
} from '../../src/lib/chain';
import { UpstreamError } from '../../src/lib/errors';

afterEach(() => vi.unstubAllGlobals());

/** Nœud simulé qui répond aux batches, et enregistre ce qu'on lui envoie. */
function batchNode(handler: (req: { id: number; method: string }) => unknown) {
  const sent: { id: number; method: string }[][] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { id: number; method: string }[];
    sent.push(payload);
    return new Response(
      JSON.stringify(payload.map((r) => ({ jsonrpc: '2.0', id: r.id, result: handler(r) }))),
      { status: 200 },
    );
  });
  return sent;
}

describe('callBatch', () => {
  it('envoie une seule requête HTTP pour plusieurs appels', async () => {
    const sent = batchNode(() => '0x1');
    const rpc = createRpcClient('https://noeud.test');
    const out = await rpc.callBatch<string>([
      { method: 'eth_call', params: [] },
      { method: 'eth_call', params: [] },
      { method: 'eth_blockNumber', params: [] },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(3);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it('découpe au-delà de la taille maximale', async () => {
    const sent = batchNode(() => '0x1');
    const rpc = createRpcClient('https://noeud.test');
    const n = MAX_BATCH_SIZE * 2 + 3;
    const out = await rpc.callBatch<string>(
      Array.from({ length: n }, () => ({ method: 'eth_call', params: [] })),
    );
    expect(out).toHaveLength(n);
    expect(sent).toHaveLength(3);
  });

  // La spec JSON-RPC n'impose pas l'ordre des réponses dans un batch.
  it("réaligne les réponses sur les id, même renvoyées à l'envers", async () => {
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { id: number }[];
      const reversed = [...payload].reverse().map((r) => ({ id: r.id, result: `v${r.id}` }));
      return new Response(JSON.stringify(reversed), { status: 200 });
    });
    const out = await createRpcClient('https://noeud.test').callBatch<string>([
      { method: 'a', params: [] },
      { method: 'b', params: [] },
      { method: 'c', params: [] },
    ]);
    expect(out.map((o) => (o.ok ? o.value : null))).toEqual(['v0', 'v1', 'v2']);
  });

  // Un token dont l'appel revert ne doit pas faire échouer les autres.
  it('isole les échecs par entrée', async () => {
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { id: number }[];
      return new Response(
        JSON.stringify(
          payload.map((r) =>
            r.id === 1
              ? { id: r.id, error: { code: 3, message: 'execution reverted' } }
              : { id: r.id, result: '0xok' },
          ),
        ),
        { status: 200 },
      );
    });
    const out = await createRpcClient('https://noeud.test').callBatch<string>([
      { method: 'a', params: [] },
      { method: 'b', params: [] },
      { method: 'c', params: [] },
    ]);
    expect(out[0]?.ok).toBe(true);
    expect(out[1]).toEqual({ ok: false, error: 'execution reverted' });
    expect(out[2]?.ok).toBe(true);
  });

  it('lève si le nœud répond à un batch par un objet', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { message: 'batch non supporté' } }), { status: 200 }),
    );
    await expect(
      createRpcClient('https://noeud.test').callBatch([{ method: 'a', params: [] }]),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it('ne fait aucun appel pour une liste vide', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await createRpcClient('https://noeud.test').callBatch([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('decodeGraduationResult', () => {
  const RAW =
    '0x0000000000000000000000000000000000000000000000000007f10b21d300aa' +
    '0000000000000000000000000000000000000000000000003a4965bf58a40000' +
    '0000000000000000000000000000000000000000000000000000000000000000';

  it('décode une réponse réelle', () => {
    const s = decodeGraduationResult(RAW);
    expect(s?.thresholdEth).toBeCloseTo(4.2);
    expect(s?.pairedEth).toBeCloseTo(0.002235, 6);
  });

  it('traite une réponse vide comme inconnue', () => {
    expect(decodeGraduationResult('0x')).toBeNull();
    expect(decodeGraduationResult(undefined)).toBeNull();
  });

  it('ne lève pas sur une réponse illisible', () => {
    expect(decodeGraduationResult('0xdeadbeef')).toBeNull();
  });
});

describe('fetchGraduationStatusBatch', () => {
  it("rend un résultat par token, dans l'ordre", async () => {
    const rpc: RpcClient = {
      async call<T>(): Promise<T> {
        throw new Error('non utilisé');
      },
      async callBatch() {
        return [
          { ok: false as const, error: 'execution reverted' },
          { ok: true as const, value: '0x' },
        ];
      },
    };
    const out = await fetchGraduationStatusBatch(
      rpc,
      '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75',
      ['0xd0c538e01a22ebf8502b4dc3a92026cec870cec6', '0x96bd50946461f6dfc07aa3861b2f8648cd19847c'],
    );
    expect(out).toEqual([null, null]);
  });

  it('ne fait rien sans token', async () => {
    const rpc = { call: vi.fn(), callBatch: vi.fn() } as unknown as RpcClient;
    expect(
      await fetchGraduationStatusBatch(rpc, '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75', []),
    ).toEqual([]);
    expect(rpc.callBatch).not.toHaveBeenCalled();
  });
});

describe('fetchBlockTimestamps', () => {
  it('convertit les timestamps en ISO', async () => {
    const rpc: RpcClient = {
      async call<T>(): Promise<T> {
        throw new Error('non utilisé');
      },
      async callBatch() {
        return [
          { ok: true as const, value: { timestamp: '0x6aa2b8af' } },
          { ok: false as const, error: 'absent' },
        ];
      },
    };
    const out = await fetchBlockTimestamps(rpc, [1, 2]);
    expect(out[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out[1]).toBeNull();
  });
});
