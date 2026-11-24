import { describe, expect, it } from 'vitest';
import { isSolanaAddress } from '../../src/lib/solana/address';
import * as programs from '../../src/lib/solana/programs';
import type { AccountInfo } from '../../src/lib/solana/rpc';
import { fakeRpcFor } from './fixtures';

const { KNOWN_PROGRAMS, knownProgram, INCINERATOR, NATIVE_MINT, TOKEN_PROGRAM } = programs;

describe('program addresses', () => {
  it('are valid, distinct addresses', () => {
    const addresses = KNOWN_PROGRAMS.map((p) => p.address);
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const a of [...addresses, INCINERATOR, NATIVE_MINT])
      expect(isSolanaAddress(a), a).toBe(true);
  });

  it('every constant ending in _PROGRAM is listed', () => {
    const constants = Object.entries(programs)
      .filter(([name, value]) => name.endsWith('_PROGRAM') && typeof value === 'string')
      .map(([, value]) => value);
    expect(new Set(constants)).toEqual(new Set(KNOWN_PROGRAMS.map((p) => p.address)));
  });

  it('are executable on mainnet (read 24/11/2026)', async () => {
    const rpc = fakeRpcFor('programs');
    for (const program of KNOWN_PROGRAMS) {
      const info = (await rpc.getAccountInfo(program.address, {
        dataSlice: { offset: 0, length: 0 },
      })) as AccountInfo | null;
      expect(info?.executable, program.name).toBe(true);
    }
  });

  it('the incinerator holds no account of its own, and wrapped SOL is an SPL mint', async () => {
    const rpc = fakeRpcFor('programs');
    await expect(
      rpc.getAccountInfo(INCINERATOR, { dataSlice: { offset: 0, length: 0 } }),
    ).resolves.toBeNull();
    const wsol = await rpc.getAccountInfo(NATIVE_MINT, { encoding: 'jsonParsed' });
    expect(wsol?.owner).toBe(TOKEN_PROGRAM);
  });

  it('are looked up exactly: case matters', () => {
    expect(knownProgram('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')?.name).toBe('pump.fun');
    expect(knownProgram('6ef8rrecthr5dkzon8nwu78hrvfckubj14m5ubewf6p')).toBeUndefined();
    expect(programs.isTokenProgram(programs.TOKEN_2022_PROGRAM)).toBe(true);
    expect(programs.isTokenProgram(programs.SYSTEM_PROGRAM)).toBe(false);
  });
});
