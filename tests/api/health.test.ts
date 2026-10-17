import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../src/app/api/health/route';

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/health', () => {
  it('says which services are configured, without any secret', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk_secret');
    vi.stubEnv('RPC_URL', 'https://keyed.example/v2/secret, https://other.example/secret');
    vi.stubEnv('LOGS_RPC_URL', '');
    vi.stubEnv('KV_REST_API_URL', 'https://secret.upstash.io');
    vi.stubEnv('KV_REST_API_TOKEN', 'secret');
    const body = await GET().json();
    expect(body.config).toEqual({
      reasoning: 'groq',
      rpc: 'custom',
      rpcNodes: 3,
      logsRpc: 'public',
      logsRpcNodes: 1,
      holders: expect.any(String),
      store: 'redis',
      indexer: 'absent',
    });
    expect(JSON.stringify(body)).not.toMatch(/secret/);
  });

  it('says whether the indexer is configured, never its URL or token', async () => {
    vi.stubEnv('INDEXER_URL', 'http://127.0.0.1:8795');
    vi.stubEnv('INDEXER_TOKEN', 'secret-secret-secret-secret');
    const body = await GET().json();
    expect(body.config.indexer).toBe('configured');
    expect(JSON.stringify(body)).not.toMatch(/secret|8795/);
  });

  it('reports offline when no provider key is set', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('AGENT_PROVIDER', '');
    const body = await GET().json();
    expect(body.config.reasoning).toBe('offline');
  });
});
