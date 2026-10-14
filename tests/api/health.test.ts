import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../src/app/api/health/route';

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/health', () => {
  it('says which services are configured, without any secret', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk_secret');
    vi.stubEnv('RPC_URL', 'https://keyed.example/v2/secret');
    const body = await GET().json();
    expect(body.config).toEqual({
      reasoning: 'groq',
      rpc: 'custom',
      logsRpc: 'public',
      holders: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toMatch(/secret/);
  });

  it('reports offline when no provider key is set', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('AGENT_PROVIDER', '');
    const body = await GET().json();
    expect(body.config.reasoning).toBe('offline');
  });
});
