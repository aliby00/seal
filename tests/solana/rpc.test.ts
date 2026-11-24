import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetThrottle } from '../../src/lib/chain/rpc';
import { RateLimitError } from '../../src/lib/errors';
import { BudgetExhaustedError } from '../../src/lib/http';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import {
  alchemySolanaUrl,
  collectSignatures,
  createSolanaRpc,
  MAX_TRANSACTION_VERSION,
  MethodUnavailableError,
  PUBLIC_SOLANA_RPC_URL,
  resetSolanaNodes,
  solanaRpcNodes,
  solanaRpcUrl,
  SolanaRpcError,
  transactionKeys,
  type RecordedCall,
  type SignatureInfo,
  type SolanaNode,
  type SolanaTransaction,
} from '../../src/lib/solana/rpc';
import { loadRecordings } from './fixtures';

const KEY = 'secretKey123';
const ALCHEMY: SolanaNode = {
  url: `https://solana-mainnet.g.alchemy.com/v2/${KEY}`,
  label: 'alchemy',
  public: false,
};
const PUBLIC: SolanaNode = { url: PUBLIC_SOLANA_RPC_URL, label: 'public', public: true };

beforeEach(() => {
  resetThrottle();
  resetSolanaNodes();
});
afterEach(() => vi.unstubAllGlobals());

type Sent = { url: string; method: string; params: unknown[] };
type Reply = (sent: Sent) => Response | Promise<Response>;

/** Every request recorded; each node answers as `reply` says. */
function node(reply: Reply) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const entry = { url: String(input), method: body.method, params: body.params };
    sent.push(entry);
    return reply(entry);
  });
  return sent;
}

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
const rpcError = (code: number, message: string, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), { status });

/** No test waits: pacing and backoff go through this. */
const noSleep = async () => undefined;
const fast = { rate: () => 1e6, sleep: noSleep };

describe('which node', () => {
  it('builds the Solana node of an Alchemy key found in RPC_URL', () => {
    expect(alchemySolanaUrl(`https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`)).toBe(ALCHEMY.url);
    expect(
      alchemySolanaUrl(
        `https://rpc.mainnet.chain.robinhood.com, https://x.g.alchemy.com/v2/${KEY}/`,
      ),
    ).toBe(ALCHEMY.url);
    expect(alchemySolanaUrl('https://rpc.mainnet.chain.robinhood.com')).toBeUndefined();
    expect(alchemySolanaUrl('https://evil.com/g.alchemy.com/v2/abc')).toBeUndefined();
    expect(alchemySolanaUrl(undefined)).toBeUndefined();
  });

  it('prefers SOLANA_RPC_URL, then Alchemy, and always ends on the public node', () => {
    expect(solanaRpcNodes({ SOLANA_RPC_URL: 'https://my.node/x', RPC_URL: ALCHEMY.url })).toEqual([
      { url: 'https://my.node/x', label: 'solana-rpc-url', public: false },
      PUBLIC,
    ]);
    expect(
      solanaRpcNodes({ RPC_URL: `https://robinhood-mainnet.g.alchemy.com/v2/${KEY}` }),
    ).toEqual([ALCHEMY, PUBLIC]);
    expect(solanaRpcNodes({})).toEqual([PUBLIC]);
    expect(solanaRpcNodes({ SOLANA_RPC_URL: PUBLIC_SOLANA_RPC_URL })).toEqual([PUBLIC]);
    expect(solanaRpcUrl({})).toBe(PUBLIC_SOLANA_RPC_URL);
  });
});

describe('the params each helper sends', () => {
  it('match the recorded fixtures (commitment, encoding, transaction version)', async () => {
    const sent = node(() => ok({ context: { slot: 1 }, value: null }));
    const rpc = createSolanaRpc({ nodes: [PUBLIC], ...fast });
    await rpc.getAccountInfo('A', { encoding: 'jsonParsed' });
    await rpc.getAccountInfo('A', { dataSlice: { offset: 0, length: 0 } });
    expect(sent.map((s) => s.params)).toEqual([
      ['A', { commitment: 'confirmed', encoding: 'jsonParsed' }],
      ['A', { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
    ]);

    const tx = createSolanaRpc({ nodes: [PUBLIC], ...fast });
    const calls = node(() => ok(null));
    await tx.getTransaction('sig');
    await tx.getSignaturesForAddress('A', { limit: 5000, before: 'b' });
    expect(calls.map((s) => [s.method, s.params])).toEqual([
      [
        'getTransaction',
        [
          'sig',
          {
            commitment: 'confirmed',
            encoding: 'json',
            maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION,
          },
        ],
      ],
      ['getSignaturesForAddress', ['A', { commitment: 'confirmed', limit: 1000, before: 'b' }]],
    ]);
    expect(MAX_TRANSACTION_VERSION).toBe(1);
  });

  it('sends getMultipleAccounts 100 addresses a call and keeps the order', async () => {
    const sent = node(({ params }) => {
      const list = params[0] as string[];
      return ok({ context: { slot: 1 }, value: list.map((a) => ({ address: a })) });
    });
    const rpc = createSolanaRpc({ nodes: [PUBLIC], ...fast });
    const addresses = Array.from({ length: 250 }, (_, i) => `a${i}`);
    const out = await rpc.getMultipleAccounts(addresses);
    expect(sent.map((s) => (s.params[0] as string[]).length)).toEqual([100, 100, 50]);
    expect(out.map((a) => (a as unknown as { address: string }).address)).toEqual(addresses);
  });

  it('refuses an answer that does not match the request', async () => {
    node(() => ok({ context: { slot: 1 }, value: [null] }));
    const rpc = createSolanaRpc({ nodes: [PUBLIC], ...fast });
    await expect(rpc.getMultipleAccounts(['a', 'b'])).rejects.toThrow(/does not match/);
  });
});

describe('failures', () => {
  it('hands a refused call to the next node, and sets the refusing one aside', async () => {
    const sent = node(({ url }) =>
      url === ALCHEMY.url ? new Response('slow down', { status: 429 }) : ok(7),
    );
    const rpc = createSolanaRpc({ nodes: [ALCHEMY, PUBLIC], ...fast });
    await expect(rpc.getSlot()).resolves.toBe(7);
    await expect(rpc.getSlot()).resolves.toBe(7);
    // The second call starts on the public node: Alchemy is aside for ten minutes.
    expect(sent.map((s) => s.url)).toEqual([ALCHEMY.url, PUBLIC.url, PUBLIC.url]);
  });

  it('retries the last node on a 429 with a wait, then gives up with a rate-limit error', async () => {
    const waits: number[] = [];
    const sent = node(() => rpcError(429, 'Too many requests for a specific RPC call', 429));
    const rpc = createSolanaRpc({
      nodes: [PUBLIC],
      rate: () => 1e6,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await expect(rpc.getSlot()).rejects.toBeInstanceOf(RateLimitError);
    expect(sent).toHaveLength(4);
    expect(waits.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(1_500);
  });

  it('retries a 5xx on the last node', async () => {
    let n = 0;
    node(() => (n++ < 2 ? new Response('down', { status: 503 }) : ok(9)));
    const rpc = createSolanaRpc({ nodes: [PUBLIC], ...fast });
    await expect(rpc.getSlot()).resolves.toBe(9);
  });

  it('does not hand over an error about the request itself', async () => {
    const sent = node(() => rpcError(-32602, 'Invalid param: WrongSize'));
    const rpc = createSolanaRpc({ nodes: [ALCHEMY, PUBLIC], ...fast });
    const error = await rpc.getAccountInfo('bad').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolanaRpcError);
    expect((error as SolanaRpcError).code).toBe(-32602);
    expect((error as SolanaRpcError).detail).toBe('Invalid param: WrongSize');
    expect(sent).toHaveLength(1);
  });

  it('hands any other node error to the next node, without setting the node aside', async () => {
    const sent = node(({ url }) =>
      url === ALCHEMY.url ? rpcError(-32601, 'Method not found') : ok(3),
    );
    const rpc = createSolanaRpc({ nodes: [ALCHEMY, PUBLIC], ...fast });
    await expect(rpc.getSlot()).resolves.toBe(3);
    await expect(rpc.getSlot()).resolves.toBe(3);
    expect(sent.map((s) => s.url)).toEqual([ALCHEMY.url, PUBLIC.url, ALCHEMY.url, PUBLIC.url]);
  });

  it('never sends getTokenLargestAccounts to the public node', async () => {
    const sent = node(() => ok({ context: { slot: 1 }, value: [] }));
    await expect(
      createSolanaRpc({ nodes: [PUBLIC], ...fast }).getTokenLargestAccounts('M'),
    ).rejects.toBeInstanceOf(MethodUnavailableError);
    expect(sent).toHaveLength(0);
    await createSolanaRpc({ nodes: [ALCHEMY, PUBLIC], ...fast }).getTokenLargestAccounts('M');
    expect(sent.map((s) => s.url)).toEqual([ALCHEMY.url]);
  });

  it('stops at the read allowance', async () => {
    node(() => ok(1));
    const rpc = createSolanaRpc({ nodes: [PUBLIC], maxCalls: 2, ...fast });
    await rpc.getSlot();
    await rpc.getSlot();
    await expect(rpc.getSlot()).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(rpc.usage()).toEqual({ spent: 2, max: 2 });
  });

  it('never writes the node URL, which holds the key, in a log or an error', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const spyLog = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    node(() => new Response('down', { status: 500 }));
    const rpc = createSolanaRpc({ nodes: [ALCHEMY], ...fast });
    const error = await rpc.getSlot().catch((e: unknown) => e);
    spy.mockRestore();
    spyLog.mockRestore();
    expect(String((error as Error).message)).not.toContain(KEY);
    for (const line of lines) expect(line).not.toContain(KEY);
    const second = createSolanaRpc({ nodes: [ALCHEMY, PUBLIC], ...fast });
    node(({ url }) => (url === ALCHEMY.url ? new Response('down', { status: 500 }) : ok(1)));
    const warn = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    await second.getSlot();
    warn.mockRestore();
    expect(lines.some((l) => l.includes('"node":"alchemy"'))).toBe(true);
    for (const line of lines) expect(line).not.toContain(KEY);
  });
});

describe('recording a read and replaying it', () => {
  it('replays through the fake exactly what the real client recorded', async () => {
    node(({ method }) =>
      method === 'getSlot' ? ok(42) : ok({ context: { slot: 1 }, value: { lamports: 5 } }),
    );
    const recorded: RecordedCall[] = [];
    const real = createSolanaRpc({ nodes: [PUBLIC], ...fast, record: (e) => recorded.push(e) });
    await real.getSlot();
    await real.getAccountInfo('A', { encoding: 'jsonParsed' });
    vi.unstubAllGlobals();

    const fake = createFakeSolanaRpc(JSON.parse(JSON.stringify(recorded)) as RecordedCall[]);
    await expect(fake.getSlot()).resolves.toBe(42);
    await expect(fake.getAccountInfo('A', { encoding: 'jsonParsed' })).resolves.toEqual({
      lamports: 5,
    });
  });
});

describe('transactions and signatures', () => {
  it('reads a version-1 transaction recorded on mainnet', async () => {
    const rpc = createFakeSolanaRpc(loadRecordings('rpc', ['v1-transaction.json']));
    const signature =
      '3ABDoRCe7Bau69dSt8e5XFAeYtT9n2Md5kQSzczP9HfywSwdz5D36ea9d1WYt4tz6iDudkWRGUhwoXpULUGaJkWE';
    const tx = (await rpc.getTransaction(signature)) as SolanaTransaction;
    expect(tx.version).toBe(1);
    expect(tx.transaction.message.transactionConfig).toBeDefined();
    expect(transactionKeys(tx)).toEqual(tx.transaction.message.accountKeys);
  });

  it('puts lookup-table addresses after the message keys, writable first', () => {
    const tx = {
      meta: { loadedAddresses: { writable: ['w'], readonly: ['r'] } },
      transaction: { message: { accountKeys: ['a', 'b'] } },
    } as unknown as SolanaTransaction;
    expect(transactionKeys(tx)).toEqual(['a', 'b', 'w', 'r']);
  });

  it('pages signatures until the oldest, or says the history was cut', async () => {
    const sig = (n: number): SignatureInfo => ({
      signature: `s${n}`,
      slot: n,
      err: null,
      memo: null,
      blockTime: n,
    });
    const all = Array.from({ length: 5 }, (_, i) => sig(5 - i));
    const page = (before?: string) => {
      const start = before ? all.findIndex((s) => s.signature === before) + 1 : 0;
      return all.slice(start, start + 2);
    };
    const calls: RecordedCall[] = [
      {
        method: 'getSignaturesForAddress',
        params: ['A', { commitment: 'confirmed', limit: 2 }],
        result: page(),
      },
      ...['s4', 's2'].map((before) => ({
        method: 'getSignaturesForAddress',
        params: ['A', { commitment: 'confirmed', limit: 2, before }],
        result: page(before),
      })),
    ];
    const rpc = createFakeSolanaRpc(calls);
    const full = await collectSignatures(rpc, 'A', { pageSize: 2 });
    expect(full.complete).toBe(true);
    expect(full.signatures.map((s) => s.signature)).toEqual(['s5', 's4', 's3', 's2', 's1']);
    const cut = await collectSignatures(rpc, 'A', { pageSize: 2, maxPages: 1 });
    expect(cut).toEqual({ signatures: [sig(5), sig(4)], complete: false });
  });
});
