import { describe, expect, it } from 'vitest';
import {
  addressBytes,
  createProgramAddress,
  decodeBase58,
  encodeBase58,
  findProgramAddress,
  isOnCurve,
  isSolanaAddress,
  shortAddress,
} from '../../src/lib/solana/address';
import {
  associatedTokenAddress,
  metadataAddress,
  PUMP_FUN_PROGRAM,
  pumpBondingCurveAddress,
  TOKEN_METADATA_PROGRAM,
} from '../../src/lib/solana/programs';
import { accountBytes, transactionKeys, type SolanaTransaction } from '../../src/lib/solana/rpc';
import { loadRecordings } from './fixtures';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('base58 addresses', () => {
  it('accepts 32-byte base58 strings only', () => {
    expect(isSolanaAddress(USDC)).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true);
    expect(isSolanaAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(false);
    // 0, O, I and l are not in the alphabet.
    expect(isSolanaAddress('0PjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false);
    expect(isSolanaAddress(USDC.slice(0, 40))).toBe(false);
    expect(isSolanaAddress(`${USDC}1`)).toBe(false);
    expect(isSolanaAddress(undefined)).toBe(false);
    expect(isSolanaAddress(42)).toBe(false);
  });

  it('is case-sensitive: a lower-cased address is another address, or none', () => {
    const lower = USDC.toLowerCase();
    if (isSolanaAddress(lower)) {
      expect(encodeBase58(decodeBase58(lower))).not.toBe(USDC);
    } else {
      expect(isSolanaAddress(lower)).toBe(false);
    }
  });

  it('round-trips bytes', () => {
    expect(decodeBase58('11111111111111111111111111111111')).toEqual(new Uint8Array(32));
    expect(encodeBase58(addressBytes(USDC))).toBe(USDC);
    expect(() => addressBytes('abc')).toThrow(/not a Solana address/);
  });

  it('shortens the way explorers do', () => {
    expect(shortAddress(USDC)).toBe('EPjF…Dt1v');
    expect(shortAddress(USDC, 6)).toBe('EPjFWd…yTDt1v');
    expect(shortAddress('short')).toBe('short');
  });
});

describe('the ed25519 curve', () => {
  it('says a wallet that signed a transaction is on the curve', () => {
    const [entry] = loadRecordings('rpc', ['v1-transaction.json']);
    const tx = entry?.result as SolanaTransaction;
    const signer = tx.transaction.message.accountKeys[0] as string;
    expect(isOnCurve(signer)).toBe(true);
  });

  it('says a program-derived address is off the curve', () => {
    expect(isOnCurve(pumpBondingCurveAddress('FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump'))).toBe(
      false,
    );
    expect(isOnCurve(new Uint8Array(31))).toBe(false);
  });
});

describe('program-derived addresses, checked against mainnet accounts', () => {
  it('derives the pump.fun bonding curves the chain holds', () => {
    for (const slug of ['pump-curve', 'pump-bundled', 'pump-creator-sold', 'pump-graduated']) {
      const entries = loadRecordings('reference', [`${slug}.json`]);
      const mintEntry = entries.find(
        (e) =>
          e.method === 'getAccountInfo' &&
          (e.params?.[1] as { encoding: string }).encoding === 'jsonParsed',
      );
      const mint = mintEntry?.params?.[0] as string;
      const curve = pumpBondingCurveAddress(mint);
      const curveEntry = entries.find(
        (e) => e.method === 'getAccountInfo' && e.params?.[0] === curve,
      );
      const value = (curveEntry?.result as { value: { owner: string } } | undefined)?.value;
      expect(value?.owner, slug).toBe(PUMP_FUN_PROGRAM);
    }
  });

  it('derives the Metaplex metadata accounts, which name their mint', () => {
    for (const slug of ['usdc', 'bonk', 'jup', 'ray']) {
      const entries = loadRecordings('reference', [`${slug}.json`]);
      const mint = entries[0]?.params?.[0] as string;
      const address = metadataAddress(mint);
      const entry = entries.find((e) => e.params?.[0] === address);
      const value = (entry?.result as { value: { owner: string; data: [string, 'base64'] } }).value;
      expect(value.owner).toBe(TOKEN_METADATA_PROGRAM);
      // Metadata: key (1 byte), update authority (32), mint (32).
      const bytes = accountBytes(value) as Uint8Array;
      expect(encodeBase58(bytes.subarray(33, 65))).toBe(mint);
    }
  });

  it('derives the associated token accounts of a creator and of a bonding curve', () => {
    const mint = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
    const creator = 'D234v6Hg5cYYmMkdvRdAdFYBBcLAP9Jcj3Uh2BQ8ChDH';
    const curve = pumpBondingCurveAddress(mint);
    const entries = loadRecordings('reference', ['pump-creator-sold.json']);
    const creation = entries.find(
      (e) =>
        e.method === 'getTransaction' &&
        e.params?.[0] ===
          '5Rftux227E8C37AFjXqDFkoqDvd15tTGAeqD4pk8PubLmuZfNCUtydsBh6coFiVQc1V9NxaxtM4Cpd8YGKjTvico',
    )?.result as SolanaTransaction;
    const keys = transactionKeys(creation);
    const checked = new Set<string>();
    for (const balance of creation.meta?.postTokenBalances ?? []) {
      if (balance.mint !== mint || (balance.owner !== creator && balance.owner !== curve)) continue;
      expect(keys[balance.accountIndex]).toBe(
        associatedTokenAddress(balance.owner, mint, balance.programId as string),
      );
      checked.add(balance.owner);
    }
    expect([...checked].sort()).toEqual([creator, curve].sort());
  });

  it('refuses seeds longer than 32 bytes, and more than 16 seeds', () => {
    expect(() => createProgramAddress([new Uint8Array(33)], PUMP_FUN_PROGRAM)).toThrow();
    expect(() => findProgramAddress(Array(16).fill('a'), PUMP_FUN_PROGRAM)).toThrow();
  });

  it('gives the bump the chain uses (255 down to the first off-curve)', () => {
    const { address, bump } = findProgramAddress(
      ['bonding-curve', addressBytes(USDC)],
      PUMP_FUN_PROGRAM,
    );
    expect(
      createProgramAddress(
        ['bonding-curve', addressBytes(USDC), Uint8Array.of(bump)],
        PUMP_FUN_PROGRAM,
      ),
    ).toBe(address);
    for (let higher = bump + 1; higher <= 255; higher += 1) {
      expect(
        createProgramAddress(
          ['bonding-curve', addressBytes(USDC), Uint8Array.of(higher)],
          PUMP_FUN_PROGRAM,
        ),
      ).toBeNull();
    }
  });
});
