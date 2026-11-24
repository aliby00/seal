import type {
  RawAmount,
  SolanaGraduation,
  SolanaGraduationData,
  SolanaLaunchpadId,
} from '../market/solana-types';
import { addressBytes, encodeBase58, findProgramAddress } from './address';
import {
  DBC_VIRTUAL_POOL_DISCRIMINATOR,
  LAUNCHLAB_POOL_DISCRIMINATOR,
  PUMP_BONDING_CURVE_DISCRIMINATOR,
  findLaunchAccount,
  startsWith,
  type LaunchAccount,
} from './launchpads';
import {
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DBC_PROGRAM,
  NATIVE_MINT,
  PUMP_FUN_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  SYSTEM_PROGRAM,
  knownProgram,
} from './programs';
import { accountBytes, type SolanaRpc } from './rpc';

/**
 * Graduation of a Solana launchpad token: whether it left its curve for an
 * open market, how far along the curve it is, and the pool it moved to.
 *
 * Layouts were read from each project's source or IDL and every field used
 * was compared against real accounts on 24/11/2026
 * (tests/fixtures/solana/market/): a field that could not be checked is not
 * read, and the answer stays `null`.
 */

// ── Little-endian readers ───────────────────────────────────────────────────

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
export function readU64(bytes: Uint8Array, offset: number): bigint {
  return view(bytes).getBigUint64(offset, true);
}
export function readU128(bytes: Uint8Array, offset: number): bigint {
  return readU64(bytes, offset) + (readU64(bytes, offset + 8) << 64n);
}
export function readAddress(bytes: Uint8Array, offset: number): string {
  return encodeBase58(bytes.subarray(offset, offset + 32));
}

/** `part / whole` as a number between 0 and 1, exact enough for a share. */
export function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  if (part <= 0n) return 0;
  if (part >= whole) return 1;
  return Number((part * 1_000_000_000n) / whole) / 1_000_000_000;
}

// ── pump.fun ────────────────────────────────────────────────────────────────

/**
 * `BondingCurve` (https://github.com/pump-fun/pump-public-docs, idl/pump.json
 * and PUMP_PROGRAM_README.md): after the discriminator, five u64 (virtual
 * token, virtual quote, real token, real quote reserves, total supply), then
 * `complete` (bool, 48), `creator` (49), `is_mayhem_mode` (81),
 * `is_cashback_coin` (82), `quote_mint` (83, the default key for SOL)… Fields
 * were appended over time: older curves are shorter (GOAT's is 150 bytes),
 * and a missing field reads as zero.
 */
export type PumpCurve = {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  /** Who receives the creator fees; `null` on curves written before the field (default key). */
  creator: string | null;
  /** The quote asset; `null` for SOL (default key, or a curve older than the field). */
  quoteMint: string | null;
};

export function decodePumpCurve(bytes: Uint8Array): PumpCurve | null {
  if (bytes.length < 49 || !startsWith(bytes, PUMP_BONDING_CURVE_DISCRIMINATOR)) return null;
  const creator = bytes.length >= 81 ? readAddress(bytes, 49) : SYSTEM_PROGRAM;
  const quote = bytes.length >= 115 ? readAddress(bytes, 83) : SYSTEM_PROGRAM;
  return {
    virtualTokenReserves: readU64(bytes, 8),
    virtualQuoteReserves: readU64(bytes, 16),
    realTokenReserves: readU64(bytes, 24),
    realQuoteReserves: readU64(bytes, 32),
    tokenTotalSupply: readU64(bytes, 40),
    complete: bytes[48] === 1,
    creator: creator === SYSTEM_PROGRAM ? null : creator,
    quoteMint: quote === SYSTEM_PROGRAM ? null : quote,
  };
}

/** pump.fun `Global`: PDA ["global"], 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf (README, derived and read). */
export const PUMP_GLOBAL = findProgramAddress(['global'], PUMP_FUN_PROGRAM).address;
export const PUMP_GLOBAL_DISCRIMINATOR = [167, 232, 232, 177, 200, 108, 114, 127] as const;

/** The curve parameters new coins start from (Global, offsets 73 to 105). */
export type PumpGlobal = {
  initialVirtualTokenReserves: bigint;
  initialVirtualQuoteReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
};

export function decodePumpGlobal(bytes: Uint8Array): PumpGlobal | null {
  if (bytes.length < 105 || !startsWith(bytes, PUMP_GLOBAL_DISCRIMINATOR)) return null;
  return {
    initialVirtualTokenReserves: readU64(bytes, 73),
    initialVirtualQuoteReserves: readU64(bytes, 81),
    initialRealTokenReserves: readU64(bytes, 89),
    tokenTotalSupply: readU64(bytes, 97),
  };
}

/**
 * Part of the curve's tokens sold, from 0 to 1. Buys and sells move the
 * virtual and real token reserves by the same amount, so their difference
 * stays what it was at creation: when it matches the Global parameters, and
 * the curve's total supply is Global's, the curve started from them and its
 * initial real reserves are known. When either differs (a curve created under
 * other parameters), `null`.
 */
export function pumpCurveProgress(curve: PumpCurve, global: PumpGlobal): number | null {
  if (curve.complete) return 1;
  const offset = curve.virtualTokenReserves - curve.realTokenReserves;
  const expected = global.initialVirtualTokenReserves - global.initialRealTokenReserves;
  if (offset !== expected || global.initialRealTokenReserves <= 0n) return null;
  if (curve.tokenTotalSupply !== global.tokenTotalSupply) return null;
  // More left than the curve starts with: not a curve of these parameters.
  if (curve.realTokenReserves > global.initialRealTokenReserves) return null;
  return ratio(global.initialRealTokenReserves - curve.realTokenReserves, global.initialRealTokenReserves);
}

/** The pump.fun PDA that creates a graduated coin's pool: ["pool-authority", mint] (pump.json, `migrate`). */
export function pumpPoolAuthority(mint: string): string {
  return findProgramAddress(['pool-authority', addressBytes(mint)], PUMP_FUN_PROGRAM).address;
}

/**
 * The PumpSwap pool `migrate` creates: ["pool", index 0 (u16 LE), pool
 * authority, mint, quote mint] under PumpSwap (pump.json, `migrate` and
 * `migrate_v2`; PUMP_SWAP_README: canonical index 0). Checked: it gives
 * DjbLtX1H… for B34nXKzC…pump, the pool DexScreener lists.
 */
export function pumpSwapPoolAddress(mint: string, quoteMint: string = NATIVE_MINT): string {
  return findProgramAddress(
    ['pool', new Uint8Array([0, 0]), addressBytes(pumpPoolAuthority(mint)), addressBytes(mint), addressBytes(quoteMint)],
    PUMP_SWAP_PROGRAM,
  ).address;
}

/** PumpSwap `Pool`: base mint at 43 (idl/pump_amm.json, checked). Same discriminator as DAMM v2's `Pool`. */
export const PUMPSWAP_POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188] as const;
export const PUMPSWAP_BASE_MINT_OFFSET = 43;

// ── Meteora DBC ─────────────────────────────────────────────────────────────

/**
 * DBC `VirtualPool` (state/virtual_pool.rs): `config` 72, `creator` 104,
 * `base_mint` 136, `quote_reserve` 240, `is_migrated` 305,
 * `migration_progress` 308 (0 pre-curve, 1 post-curve, 2 locked vesting,
 * 3 pool created). Checked: two migrated pools read 1 and 3, their quote
 * reserve at or above their config's threshold.
 */
export type DbcPool = {
  config: string;
  creator: string;
  baseMint: string;
  quoteReserve: bigint;
  isMigrated: boolean;
  migrationProgress: number;
};

export function decodeDbcPool(bytes: Uint8Array): DbcPool | null {
  if (bytes.length < 309 || !startsWith(bytes, DBC_VIRTUAL_POOL_DISCRIMINATOR)) return null;
  return {
    config: readAddress(bytes, 72),
    creator: readAddress(bytes, 104),
    baseMint: readAddress(bytes, 136),
    quoteReserve: readU64(bytes, 240),
    isMigrated: bytes[305] === 1,
    migrationProgress: bytes[308] ?? 0,
  };
}

export const DBC_CONFIG_DISCRIMINATOR = [26, 108, 14, 123, 116, 230, 129, 43] as const;

/**
 * DBC `PoolConfig` (state/config.rs): `quote_mint` 8, `migration_option` 233
 * (0 DAMM v1, 1 DAMM v2), `migration_quote_threshold` 264. Checked on three
 * configs (SOL and USDC quotes).
 */
export type DbcConfig = { quoteMint: string; migrationOption: number; migrationQuoteThreshold: bigint };

export function decodeDbcConfig(bytes: Uint8Array): DbcConfig | null {
  if (bytes.length < 272 || !startsWith(bytes, DBC_CONFIG_DISCRIMINATOR)) return null;
  return {
    quoteMint: readAddress(bytes, 8),
    migrationOption: bytes[233] ?? 0,
    migrationQuoteThreshold: readU64(bytes, 264),
  };
}

/** DBC's pool authority (IDL fixed address); it is the `creator` of the DAMM v2 pools DBC migrates to (read). */
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
/** DAMM v2 `Pool` (cp-amm state/pool.rs): 1,112 bytes, `token_a_mint` 168, `creator` 648. */
export const DAMM_V2_POOL_SIZE = 1112;
export const DAMM_V2_TOKEN_A_OFFSET = 168;
export const DAMM_V2_CREATOR_OFFSET = 648;

// ── Raydium LaunchLab ───────────────────────────────────────────────────────

/**
 * LaunchLab `PoolState` (raydium_launchpad IDL): `status` 17 (0 funding,
 * 1 funding ended, waiting for migration, 2 migrated), `migrate_type` 20
 * (0 AMM v4, 1 CPMM), `real_quote` 61, `total_quote_fund_raising` 69,
 * `platform_config` 173, `quote_mint` 237, `creator` 333. Checked on two
 * migrated pools (status 2, raised ≥ target) and young ones.
 */
export type LaunchLabPool = {
  status: number;
  migrateType: number;
  realQuote: bigint;
  totalQuoteFundRaising: bigint;
  platformConfig: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
};

export function decodeLaunchLabPool(bytes: Uint8Array): LaunchLabPool | null {
  if (bytes.length < 365 || !startsWith(bytes, LAUNCHLAB_POOL_DISCRIMINATOR)) return null;
  return {
    status: bytes[17] ?? 0,
    migrateType: bytes[20] ?? 0,
    realQuote: readU64(bytes, 61),
    totalQuoteFundRaising: readU64(bytes, 69),
    platformConfig: readAddress(bytes, 173),
    baseMint: readAddress(bytes, 205),
    quoteMint: readAddress(bytes, 237),
    creator: readAddress(bytes, 333),
  };
}

/** Raydium AMM v4 `AmmInfo` (raydium-amm program/src/state.rs): 752 bytes, coin mint 400, pc mint 432. */
export const AMM_V4_POOL_SIZE = 752;
export const AMM_V4_COIN_MINT_OFFSET = 400;
export const AMM_V4_PC_MINT_OFFSET = 432;
/** Raydium CPMM `PoolState` (raydium-cp-swap states/pool.rs): 637 bytes, token 0 mint 168, token 1 mint 200. */
export const CPMM_POOL_SIZE = 637;
export const CPMM_TOKEN_0_OFFSET = 168;
export const CPMM_TOKEN_1_OFFSET = 200;

// ── Reading ─────────────────────────────────────────────────────────────────

type Destination = SolanaGraduationData['destination'];

function destination(pool: string, program: string): NonNullable<Destination> {
  return { pool, program, name: knownProgram(program)?.name ?? program };
}

function amount(mint: string | null, raw: bigint): RawAmount {
  return { mint: mint === NATIVE_MINT ? null : mint, raw: raw.toString() };
}

type Reading = {
  data: SolanaGraduationData;
  /** What could not be read, for the source note; the read is partial when set. */
  missing: string | null;
};

async function readPump(rpc: SolanaRpc, mint: string, launch: LaunchAccount): Promise<Reading> {
  const bytes = accountBytes(launch.info);
  const curve = bytes ? decodePumpCurve(bytes) : null;
  const base: SolanaGraduationData = {
    mint,
    launchpad: 'pump.fun',
    account: launch.address,
    graduated: null,
    progress: null,
    progressBasis: null,
    raised: null,
    target: null,
    destination: null,
    creator: null,
  };
  if (!curve) return { data: base, missing: 'the bonding curve could not be decoded' };
  const quote = curve.quoteMint ?? NATIVE_MINT;
  const data: SolanaGraduationData = {
    ...base,
    graduated: curve.complete,
    creator: curve.creator,
    raised: curve.complete ? null : amount(quote, curve.realQuoteReserves),
  };

  if (curve.complete) {
    // Migration zeroes the curve; the pool it created is derived, then read.
    const pool = pumpSwapPoolAddress(mint, quote);
    const info = await rpc.getAccountInfo(pool);
    const poolBytes = info ? accountBytes(info) : null;
    const isPool =
      info?.owner === PUMP_SWAP_PROGRAM &&
      poolBytes !== null &&
      startsWith(poolBytes, PUMPSWAP_POOL_DISCRIMINATOR) &&
      poolBytes.length >= PUMPSWAP_BASE_MINT_OFFSET + 32 &&
      readAddress(poolBytes, PUMPSWAP_BASE_MINT_OFFSET) === mint;
    return {
      data: { ...data, progress: 1, progressBasis: 'tokens-sold', ...(isPool ? { destination: destination(pool, PUMP_SWAP_PROGRAM) } : {}) },
      // Coins that graduated before PumpSwap (spring 2025) moved to Raydium:
      // that pool is not derived from the curve (GOAT: none at the PumpSwap address).
      missing: isPool ? null : 'the curve is complete but no PumpSwap pool sits at the address its migration creates: the pool it moved to was not found',
    };
  }

  const globalInfo = await rpc.getAccountInfo(PUMP_GLOBAL);
  const globalBytes = globalInfo ? accountBytes(globalInfo) : null;
  const global = globalInfo?.owner === PUMP_FUN_PROGRAM && globalBytes ? decodePumpGlobal(globalBytes) : null;
  const progress = global ? pumpCurveProgress(curve, global) : null;
  return {
    data: { ...data, progress, progressBasis: progress === null ? null : 'tokens-sold' },
    missing:
      progress === null
        ? 'the curve was not created with the current pump.fun parameters: its progress is not measured'
        : null,
  };
}

async function readDbc(rpc: SolanaRpc, mint: string, launch: LaunchAccount): Promise<Reading> {
  const bytes = accountBytes(launch.info);
  const pool = bytes ? decodeDbcPool(bytes) : null;
  const base: SolanaGraduationData = {
    mint,
    launchpad: 'meteora-dbc',
    account: launch.address,
    graduated: null,
    progress: null,
    progressBasis: null,
    raised: null,
    target: null,
    destination: null,
    creator: null,
  };
  if (!pool) return { data: base, missing: 'the DBC pool could not be decoded' };
  const configInfo = await rpc.getAccountInfo(pool.config);
  const configBytes = configInfo?.owner === METEORA_DBC_PROGRAM ? accountBytes(configInfo) : null;
  const config = configBytes ? decodeDbcConfig(configBytes) : null;
  const data: SolanaGraduationData = {
    ...base,
    graduated: pool.isMigrated,
    creator: pool.creator,
    raised: config ? amount(config.quoteMint, pool.quoteReserve) : null,
    target: config ? amount(config.quoteMint, config.migrationQuoteThreshold) : null,
    progress: pool.isMigrated
      ? 1
      : config && config.migrationQuoteThreshold > 0n
        ? ratio(pool.quoteReserve, config.migrationQuoteThreshold)
        : null,
  };
  data.progressBasis = data.progress === null ? null : 'quote-raised';
  if (!config) return { data, missing: 'the DBC config could not be read: no target to measure against' };
  if (!pool.isMigrated) return { data, missing: null };
  if (config.migrationOption !== 1) {
    return { data, missing: 'migrated to Meteora DAMM v1: the pool it moved to is not read' };
  }
  const found = await rpc.getProgramAccounts(METEORA_DAMM_V2_PROGRAM, {
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { dataSize: DAMM_V2_POOL_SIZE },
      { memcmp: { offset: DAMM_V2_TOKEN_A_OFFSET, bytes: mint } },
      { memcmp: { offset: DAMM_V2_CREATOR_OFFSET, bytes: DBC_POOL_AUTHORITY } },
    ],
  });
  if (found.length === 1 && found[0]) {
    return { data: { ...data, destination: destination(found[0].pubkey, METEORA_DAMM_V2_PROGRAM) }, missing: null };
  }
  return {
    data,
    missing:
      found.length === 0
        ? 'migrated, but no DAMM v2 pool created by the DBC was found for this mint'
        : `migrated, and ${found.length} DAMM v2 pools created by the DBC hold this mint: none is named`,
  };
}

/** Mint order in a CPMM pool: token 0 is the smaller key, byte by byte (raydium-cp-swap initialize.rs; both pools read). */
export function cpmmMintOrder(mintA: string, mintB: string): [string, string] {
  const [a, b] = [addressBytes(mintA), addressBytes(mintB)];
  for (let i = 0; i < 32; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d < 0 ? [mintA, mintB] : [mintB, mintA];
  }
  return [mintA, mintB];
}

async function readLaunchLab(rpc: SolanaRpc, mint: string, launch: LaunchAccount): Promise<Reading> {
  const bytes = accountBytes(launch.info);
  const pool = bytes ? decodeLaunchLabPool(bytes) : null;
  const base: SolanaGraduationData = {
    mint,
    launchpad: 'raydium-launchlab',
    account: launch.address,
    graduated: null,
    progress: null,
    progressBasis: null,
    raised: null,
    target: null,
    destination: null,
    creator: null,
  };
  if (!pool) return { data: base, missing: 'the LaunchLab pool could not be decoded' };
  const graduated = pool.status === 2;
  const data: SolanaGraduationData = {
    ...base,
    graduated,
    creator: pool.creator,
    raised: amount(pool.quoteMint, pool.realQuote),
    target: amount(pool.quoteMint, pool.totalQuoteFundRaising),
    progress: graduated
      ? 1
      : pool.totalQuoteFundRaising > 0n
        ? ratio(pool.realQuote, pool.totalQuoteFundRaising)
        : null,
  };
  data.progressBasis = data.progress === null ? null : 'quote-raised';
  if (!graduated) return { data, missing: null };

  // The pool the migration created is looked up by its pair: LaunchLab's
  // platform config names a CPMM config, but not always the one the pool was
  // created with (letsbonk.fun: Gtdipq… named, D4FPEr… used by B4aJyVCi…'s pool).
  const cpmm = pool.migrateType === 1;
  const [token0, token1] = cpmmMintOrder(mint, pool.quoteMint);
  const found = await rpc.getProgramAccounts(cpmm ? RAYDIUM_CPMM_PROGRAM : RAYDIUM_AMM_V4_PROGRAM, {
    dataSlice: { offset: 0, length: 0 },
    filters: cpmm
      ? [
          { dataSize: CPMM_POOL_SIZE },
          { memcmp: { offset: CPMM_TOKEN_0_OFFSET, bytes: token0 } },
          { memcmp: { offset: CPMM_TOKEN_1_OFFSET, bytes: token1 } },
        ]
      : [
          { dataSize: AMM_V4_POOL_SIZE },
          { memcmp: { offset: AMM_V4_COIN_MINT_OFFSET, bytes: mint } },
          { memcmp: { offset: AMM_V4_PC_MINT_OFFSET, bytes: pool.quoteMint } },
        ],
  });
  const program = cpmm ? RAYDIUM_CPMM_PROGRAM : RAYDIUM_AMM_V4_PROGRAM;
  const name = cpmm ? 'Raydium CPMM' : 'Raydium AMM v4';
  if (found.length === 1 && found[0]) {
    return { data: { ...data, destination: destination(found[0].pubkey, program) }, missing: null };
  }
  return {
    data,
    missing:
      found.length === 0
        ? `migrated to ${name}, but no ${name} pool of this pair was found`
        : `migrated to ${name}, and ${found.length} ${name} pools of this pair exist: none is named`,
  };
}

const READERS: Record<SolanaLaunchpadId, (rpc: SolanaRpc, mint: string, launch: LaunchAccount) => Promise<Reading>> = {
  'pump.fun': readPump,
  'meteora-dbc': readDbc,
  'raydium-launchlab': readLaunchLab,
};

/**
 * The graduation of a launchpad token, `null` when no launchpad read here
 * holds it (nothing to graduate from). Pass `launch` when the launch account
 * was already found, to spare the reads.
 */
export async function readSolanaGraduation(
  rpc: SolanaRpc,
  mint: string,
  options: { launch?: LaunchAccount | null; hints?: readonly string[]; now?: () => Date } = {},
): Promise<SolanaGraduation | null> {
  const launch =
    options.launch !== undefined ? options.launch : await findLaunchAccount(rpc, mint, options);
  if (!launch) return null;
  const { data, missing } = await READERS[launch.launchpad](rpc, mint, launch);
  return {
    completeness: missing ? 'partial' : 'full',
    sources: [
      {
        name: 'solana-rpc',
        fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
        ...(missing ? { note: missing } : {}),
      },
    ],
    data,
  };
}
