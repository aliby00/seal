import { describe, expect, it } from 'vitest';
import { isProduction, parseEnv } from '../src/lib/env';

describe('parseEnv', () => {
  it('applique les valeurs par défaut sur un environnement vide', () => {
    const env = parseEnv({});
    expect(env.SEAL_ENV).toBe('development');
    expect(env.RPC_URL).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-5');
  });

  it('accepte les trois environnements attendus', () => {
    for (const value of ['development', 'staging', 'production'] as const) {
      expect(parseEnv({ SEAL_ENV: value }).SEAL_ENV).toBe(value);
    }
  });

  it('rejette un SEAL_ENV inconnu plutôt que de le laisser passer', () => {
    expect(() => parseEnv({ SEAL_ENV: 'preprod' })).toThrow(/SEAL_ENV/);
  });

  it("rejette une RPC_URL qui n'est pas une URL", () => {
    expect(() => parseEnv({ RPC_URL: 'pas-une-url' })).toThrow(/RPC_URL/);
  });

  it('distingue la production du reste', () => {
    expect(isProduction(parseEnv({ SEAL_ENV: 'production' }))).toBe(true);
    expect(isProduction(parseEnv({ SEAL_ENV: 'staging' }))).toBe(false);
  });
});
