import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DexScreenerPair } from '../../src/lib/market';
import { solanaListedPools } from '../../src/lib/market/solana';
import { accountBytes } from '../../src/lib/solana/rpc';
import {
  PUMP_GLOBAL,
  cpmmMintOrder,
  decodeDbcConfig,
  decodeDbcPool,
  decodeLaunchLabPool,
  decodePumpCurve,
  decodePumpGlobal,
  pumpCurveProgress,
  pumpPoolAuthority,
  pumpSwapPoolAddress,
  ratio,
  readSolanaGraduation,
} from '../../src/lib/solana/graduation';
import { findLaunchAccount } from '../../src/lib/solana/launchpads';
import { NATIVE_MINT } from '../../src/lib/solana/programs';
import type { AccountInfo } from '../../src/lib/solana/rpc';
import { SOLANA_FIXTURES, fakeRpcFor, loadRecordings } from './fixtures';

/**
 * Graduation, decoded from accounts recorded on mainnet on 24-25/11/2026
 * (tests/fixtures/solana/market/, reference/).
 */

const at = () => new Date('2026-11-25T00:00:00.000Z');

function hintsOf(slug: string, mint: string): string[] {
  const pairs = JSON.parse(
    readFileSync(join(SOLANA_FIXTURES, 'market', 'dexscreener', `${slug}.json`), 'utf8'),
  ) as DexScreenerPair[];
  return solanaListedPools(mint, pairs).map((p) => p.id);
}

function bytesOf(zone: string, file: string, address: string): Uint8Array {
  for (const e of loadRecordings(zone, [file])) {
    if (e.method === 'getAccountInfo' && e.params?.[0] === address) {
      return accountBytes((e.result as { value: AccountInfo }).value) as Uint8Array;
    }
    if (e.method === 'getMultipleAccounts') {
      const i = (e.params?.[0] as string[]).indexOf(address);
      const value = i >= 0 ? (e.result as { value: (AccountInfo | null)[] }).value[i] : null;
      if (value) return accountBytes(value) as Uint8Array;
    }
    if (e.method === 'getProgramAccounts') {
      const hit = (e.result as { pubkey: string; account: AccountInfo }[]).find((a) => a.pubkey === address);
      if (hit) return accountBytes(hit.account) as Uint8Array;
    }
  }
  throw new Error(`no ${address} in ${zone}/${file}`);
}

async function graduation(slug: string, mint: string) {
  const rpc = fakeRpcFor('market', [`${slug}.json`]);
  const launch = await findLaunchAccount(rpc, mint, { hints: hintsOf(slug, mint) });
  const before = rpc.calls.length;
  const read = await readSolanaGraduation(rpc, mint, { launch, now: at });
  return { read, calls: rpc.calls.length - before };
}

describe('pump.fun', () => {
  it('Global: the PDA of ["global"] the README names, and its curve parameters', () => {
    expect(PUMP_GLOBAL).toBe('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
    const global = decodePumpGlobal(bytesOf('market', 'pump-curve-sol.json', PUMP_GLOBAL));
    expect(global).toEqual({
      initialVirtualTokenReserves: 1_073_000_000_000_000n,
      initialVirtualQuoteReserves: 30_000_000_000n,
      initialRealTokenReserves: 793_100_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
    });
  });

  it('decodes a curve on SOL: reserves, creator, no quote mint', () => {
    const curve = decodePumpCurve(bytesOf('market', 'pump-curve-sol.json', 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2'));
    expect(curve).toMatchObject({
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
      creator: 'D234v6Hg5cYYmMkdvRdAdFYBBcLAP9Jcj3Uh2BQ8ChDH',
      quoteMint: null,
      realQuoteReserves: 68_420_913n,
    });
    // Buys and sells move both token reserves alike: their gap stays the Global one.
    expect((curve?.virtualTokenReserves ?? 0n) - (curve?.realTokenReserves ?? 0n)).toBe(279_900_000_000_000n);
  });

  it('decodes a curve paired with another token (WXMR) and an old 150-byte curve', () => {
    const xmr = decodePumpCurve(bytesOf('market', 'pump-curve-xmr.json', '8j8apXSGYWc9m9XySAADCYmUzhetFzs2ZMoj36opQ8YA'));
    expect(xmr?.quoteMint).toBe('WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp');
    const goat = bytesOf('market', 'pump-raydium-era.json', '5JH9u8yJ9WBcH8PfoMLxo6JKafJ1J44n3zQqGz9Ti5ET');
    expect(goat.length).toBe(150);
    expect(decodePumpCurve(goat)).toMatchObject({ complete: true, creator: null, quoteMint: null, realTokenReserves: 0n });
    expect(decodePumpCurve(goat.subarray(0, 40))).toBeNull();
    expect(decodePumpCurve(new Uint8Array(200))).toBeNull();
  });

  it('progress is the part of the curve’s tokens sold; unknown when the curve started elsewhere', () => {
    const global = decodePumpGlobal(bytesOf('market', 'pump-curve-sol.json', PUMP_GLOBAL));
    const curve = decodePumpCurve(bytesOf('market', 'pump-curve-sol.json', 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2'));
    if (!global || !curve) throw new Error('fixtures');
    expect(pumpCurveProgress(curve, global)).toBeCloseTo((793_100_000_000_000 - Number(curve.realTokenReserves)) / 793_100_000_000_000, 8);
    expect(pumpCurveProgress({ ...curve, virtualTokenReserves: curve.virtualTokenReserves + 1n }, global)).toBeNull();
    expect(pumpCurveProgress({ ...curve, complete: true }, global)).toBe(1);
    // Same reserve gap but another supply: not a curve of these parameters, not measured.
    expect(pumpCurveProgress({ ...curve, tokenTotalSupply: 2n * curve.tokenTotalSupply }, global)).toBeNull();
    // Both token reserves moved up together past the start: not measured either, never a negative share.
    const above = 1_000_000n + global.initialRealTokenReserves - curve.realTokenReserves;
    expect(
      pumpCurveProgress(
        { ...curve, realTokenReserves: curve.realTokenReserves + above, virtualTokenReserves: curve.virtualTokenReserves + above },
        global,
      ),
    ).toBeNull();
  });

  it('the PumpSwap pool migrate creates: DjbLtX1H… for B34nXKzC…, the pool DexScreener lists', () => {
    expect(pumpPoolAuthority('B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump')).toBe('5YiRPAz2HCSNAKSQruzi9TfFbCm3CzAFWqjAN6b5SPJc');
    expect(pumpSwapPoolAddress('B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump')).toBe('DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB');
    expect(pumpSwapPoolAddress('B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump', NATIVE_MINT)).toBe('DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB');
  });

  it('on its curve: progress from the Global parameters, quote raised, one call (Global)', async () => {
    const { read, calls } = await graduation('pump-curve-sol', 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump');
    expect(read?.completeness).toBe('full');
    expect(read?.data).toMatchObject({
      launchpad: 'pump.fun',
      graduated: false,
      progressBasis: 'tokens-sold',
      raised: { mint: null, raw: '68420913' },
      target: null,
      destination: null,
      creator: 'D234v6Hg5cYYmMkdvRdAdFYBBcLAP9Jcj3Uh2BQ8ChDH',
    });
    expect(read?.data.progress).toBeCloseTo(0.003078565, 8);
    expect(calls).toBe(1);
  });

  it('on a WXMR curve: the quote raised is in WXMR', async () => {
    const { read } = await graduation('pump-curve-xmr', 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump');
    expect(read?.data.raised).toEqual({ mint: 'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp', raw: '24624534991' });
    expect(read?.data.progress).toBeCloseTo(0.005092801, 8);
  });

  it('graduated: complete, the PumpSwap pool it moved to read and checked', async () => {
    const { read } = await graduation('pump-graduated', 'B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump');
    expect(read?.completeness).toBe('full');
    expect(read?.data).toMatchObject({
      graduated: true,
      progress: 1,
      raised: null,
      destination: { pool: 'DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB', program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', name: 'PumpSwap' },
      creator: 'GReWRrUR5ydD5fRDr1a45CoSUry3NzqA9d3kGuwH7Pwy',
    });
  });

  it('graduated before PumpSwap (GOAT): complete, the pool it moved to not found, said so', async () => {
    const { read } = await graduation('pump-raydium-era', 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump');
    expect(read?.completeness).toBe('partial');
    expect(read?.data.graduated).toBe(true);
    expect(read?.data.destination).toBeNull();
    expect(read?.sources[0]?.note).toMatch(/no PumpSwap pool/);
  });
});

describe('Meteora DBC', () => {
  it('decodes the pool and its config', () => {
    const pool = decodeDbcPool(bytesOf('market', 'dbc-curve.json', 'DbdgjtiiRBWY2C3F3cLssjgfaFQXkRWuoHjduEvexJ9f'));
    expect(pool).toMatchObject({
      config: 'CMJhmYMb2PC7YfVL2voXMKkhsC1SbQmh8uhjEyosEf3g',
      creator: '9kZ2UPtdbqnbwHWtAYt2wTK9nzC2pYQZHe3DvFrCkbuo',
      baseMint: '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx',
      isMigrated: false,
      migrationProgress: 0,
    });
    const config = decodeDbcConfig(bytesOf('market', 'dbc-curve.json', 'CMJhmYMb2PC7YfVL2voXMKkhsC1SbQmh8uhjEyosEf3g'));
    expect(config).toEqual({ quoteMint: NATIVE_MINT, migrationOption: 1, migrationQuoteThreshold: 78_692_406_334n });
    expect(decodeDbcConfig(new Uint8Array(300))).toBeNull();
  });

  it('on its curve: SOL raised against the config’s threshold', async () => {
    const { read } = await graduation('dbc-curve', '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx');
    expect(read?.completeness).toBe('full');
    expect(read?.data).toMatchObject({
      launchpad: 'meteora-dbc',
      graduated: false,
      progressBasis: 'quote-raised',
      raised: { mint: null, raw: '41851873871' },
      target: { mint: null, raw: '78692406334' },
    });
    expect(read?.data.progress).toBeCloseTo(41851873871 / 78692406334, 8);
  });

  it('migrated to DAMM v2 (SOL and USDC): the DAMM v2 pool the DBC created', async () => {
    const sol = await graduation('dbc-migrated-sol', '8X6SyaSgYdPfmZTc1B7Kc7YytMwUYJVTWXgSxJWMBAGS');
    expect(sol.read?.data).toMatchObject({
      graduated: true,
      progress: 1,
      destination: { pool: 'BjoLhkUZKtPMBxEN7Lofn6n4k6vKtm88xSj8V2n1E69u', name: 'Meteora DAMM v2' },
      creator: 'BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv',
    });
    const usdc = await graduation('dbc-migrated-usdc', 'Ax5dAamJPeuaLpFUzs9FdcpoUhHDcxyjPzxCJQidjups');
    expect(usdc.read?.data.target).toEqual({ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', raw: '15390982211' });
    expect(usdc.read?.data.destination?.pool).toBe('CP222Ubb6wY2J3EnMbMmEGGQdgGWDcUADa358LDN7HxX');
  });
});

describe('Raydium LaunchLab', () => {
  it('decodes the pool: status, migration type, raised and target', () => {
    const pool = decodeLaunchLabPool(bytesOf('market', 'launchlab-cpmm.json', '8pDPWkN9ThmR6P9nqHBHftrGw3AbRAwHb1J1dU11XW6y'));
    expect(pool).toMatchObject({
      status: 2,
      migrateType: 1,
      realQuote: 85_000_000_401n,
      totalQuoteFundRaising: 85_000_000_000n,
      baseMint: 'B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk',
      quoteMint: NATIVE_MINT,
    });
  });

  it('migrated to CPMM: the pool of the pair', async () => {
    const { read } = await graduation('launchlab-cpmm', 'B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk');
    expect(read?.completeness).toBe('full');
    expect(read?.data.destination).toEqual({
      pool: 'CuAr9cYgcSr4HVvByctB1qHzKC8UuGRt8rQRC4nByaoa',
      program: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
      name: 'Raydium CPMM',
    });
  });

  it('migrated to AMM v4: the pool of the pair', async () => {
    const { read } = await graduation('launchlab-amm', 'CDBdbNqmrLu1PcgjrFG52yxg71QnFhBZcUE6PSFdbonk');
    expect(read?.data).toMatchObject({
      graduated: true,
      destination: { pool: 'Hv1i8WrxEhL8djBuxhFGJxXTt4qEupywWKFSgGB5A7w6', name: 'Raydium AMM v4' },
      creator: 'BmzDgHABrmhzRpx9BSh6qiG6AY99nBsxePzZB3XRdGJW',
    });
  });

  it('a young pool against another quote token, found by a program scan', async () => {
    const { read } = await graduation('launchlab-curve', 'FnYLY1FQqbfNiMdDpedMPwpKWdM8RtAkwWBvWYNAwq4T');
    expect(read?.data).toMatchObject({
      account: 'BYa8uA3enWj8QfxhQsgxwRYgF8yt89yauE6RpQVPTgWR',
      graduated: false,
      raised: { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', raw: '5571813' },
    });
    expect(read?.data.progress).toBeCloseTo(0.001452909, 8);
  });

  it('CPMM mints in byte order', () => {
    expect(cpmmMintOrder('B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk', NATIVE_MINT)).toEqual([
      NATIVE_MINT,
      'B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk',
    ]);
  });
});

describe('without a launchpad', () => {
  it('nothing to graduate from: null', async () => {
    const rpc = fakeRpcFor('market', ['ray.json']);
    expect(await readSolanaGraduation(rpc, '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', { launch: null })).toBeNull();
    expect(rpc.calls).toEqual([]);
  });

  it('ratio stays within 0 and 1', () => {
    expect(ratio(5n, 0n)).toBe(0);
    expect(ratio(-1n, 10n)).toBe(0);
    expect(ratio(11n, 10n)).toBe(1);
    expect(ratio(1n, 3n)).toBeCloseTo(1 / 3, 8);
  });
});
