import { describe, expect, it } from 'vitest';
import { RateLimitError } from '../../src/lib/errors';
import {
  canonicalJson,
  createFakeSolanaRpc,
  MissingRecordingError,
} from '../../src/lib/solana/fake-rpc';
import { SolanaRpcError } from '../../src/lib/solana/rpc';
import { fakeRpcFor } from './fixtures';

describe('the fake Solana node', () => {
  it('matches params whatever the order of their keys', async () => {
    const rpc = createFakeSolanaRpc([
      {
        method: 'getAccountInfo',
        params: ['A', { encoding: 'base64', commitment: 'confirmed' }],
        result: { context: { slot: 1 }, value: { lamports: 3 } },
      },
    ]);
    await expect(rpc.getAccountInfo('A')).resolves.toEqual({ lamports: 3 });
    expect(rpc.calls).toEqual([
      { method: 'getAccountInfo', params: ['A', { commitment: 'confirmed', encoding: 'base64' }] },
    ]);
  });

  it('answers a method whatever the params when the entry has none', async () => {
    const rpc = createFakeSolanaRpc([{ method: 'getSlot', result: 12 }]);
    await expect(rpc.getSlot()).resolves.toBe(12);
    await expect(rpc.call('getSlot', [{ commitment: 'finalized' }])).resolves.toBe(12);
  });

  it('says which call has no recording', async () => {
    const rpc = createFakeSolanaRpc([]);
    const error = await rpc.getAccountInfo('Zz').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingRecordingError);
    expect(String(error)).toContain(
      'getAccountInfo ["Zz",{"commitment":"confirmed","encoding":"base64"}]',
    );
  });

  it('throws what the real client would for a recorded error', async () => {
    const rpc = createFakeSolanaRpc([
      { method: 'getTokenLargestAccounts', error: { code: 429, message: 'Too many requests' } },
      {
        method: 'getTransaction',
        error: { code: -32015, message: 'Transaction version (1) is not supported' },
      },
    ]);
    await expect(rpc.getTokenLargestAccounts('M')).rejects.toBeInstanceOf(RateLimitError);
    const error = await rpc.getTransaction('s').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolanaRpcError);
    expect((error as SolanaRpcError).code).toBe(-32015);
  });

  it('hands out copies: a reader cannot change the next answer', async () => {
    const rpc = createFakeSolanaRpc([
      { method: 'getAccountInfo', result: { context: { slot: 1 }, value: { lamports: 1 } } },
    ]);
    const first = (await rpc.getAccountInfo('A')) as { lamports: number };
    first.lamports = 99;
    await expect(rpc.getAccountInfo('A')).resolves.toEqual({ lamports: 1 });
  });

  it('replays the recorded mainnet fixtures through the helpers', async () => {
    const rpc = fakeRpcFor('reference', ['usdc.json']);
    const usdc = await rpc.getAccountInfo('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      encoding: 'jsonParsed',
    });
    expect(usdc?.owner).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  });

  it('writes canonical JSON', () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });
});
