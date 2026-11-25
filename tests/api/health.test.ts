import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../src/app/api/health/route';
import {
  recordModelAnswer,
  recordModelFailure,
  resetModelHealth,
} from '../../src/lib/model-health';
import { setSharedRedis } from '../../src/lib/store';
import { resetThrottle } from '../../src/lib/throttle';

/** The node answers `getSlot` with this slot; every request is recorded. */
function solanaNode(answer: () => Response | Promise<Response>) {
  const sent: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    sent.push({ url: String(input), method: body.method });
    return answer();
  });
  return sent;
}
const slot = (n: number) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: n }));

// The probe reads the model's last failure from the shared store: never a
// real Redis from the tests, and never a real node.
beforeEach(() => {
  setSharedRedis(null);
  resetThrottle();
  solanaNode(() => slot(1));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetModelHealth();
  setSharedRedis(undefined);
});

describe('GET /api/health', () => {
  it('says which services are configured, without any secret', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk_secret');
    vi.stubEnv('RPC_URL', 'https://eth-mainnet.g.alchemy.com/v2/secretKey123');
    vi.stubEnv('SOLANA_RPC_URL', '');
    vi.stubEnv('KV_REST_API_URL', 'https://secret.upstash.io');
    vi.stubEnv('KV_REST_API_TOKEN', 'secret');
    const body = await (await GET()).json();
    expect(body.config).toEqual({
      reasoning: 'groq',
      chain: 'solana',
      solanaNode: 'alchemy',
      solanaNodes: 2,
      store: 'redis',
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|alchemy\.com/i);
  });

  it('says which Solana node is read and whether it answers a getSlot, never its URL', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://node.example/secretKey123');
    const sent = solanaNode(() => slot(473_500_000));
    const body = await (await GET()).json();
    expect(body.solana).toMatchObject({ node: 'solana-rpc-url', slotOk: true, slot: 473_500_000 });
    // One getSlot, to the node the analyses use first: never a fallback to another.
    expect(sent.map((s) => s.method)).toEqual(['getSlot']);
    expect(sent[0]?.url).toBe('https://node.example/secretKey123');
    expect(JSON.stringify(body)).not.toMatch(/secretKey123|node\.example/);
  });

  it('says the public node is read when no key is set, and when it does not answer', async () => {
    vi.stubEnv('SOLANA_RPC_URL', '');
    vi.stubEnv('RPC_URL', '');
    solanaNode(() => new Response('busy', { status: 503 }));
    const body = await (await GET()).json();
    expect(body.config.solanaNode).toBe('public');
    expect(body.solana).toMatchObject({ node: 'public', slotOk: false });
    expect(body.solana.error).toEqual(expect.any(String));
    expect(body.status).toBe('ok');
  });

  it('reports offline when no provider key is set', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('AGENT_PROVIDER', '');
    const body = await (await GET()).json();
    expect(body.config.reasoning).toBe('offline');
  });

  it('says when the configured model stopped answering, and when it is back', async () => {
    expect((await (await GET()).json()).reasoningFailing).toBeNull();
    await recordModelFailure(new Error('401 invalid x-api-key'));
    const body = await (await GET()).json();
    expect(body.reasoningFailing).toBe('auth');
    expect(body.reasoningFailingSince).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toMatch(/x-api-key/);
    await recordModelAnswer();
    expect((await (await GET()).json()).reasoningFailing).toBeNull();
  });
});
