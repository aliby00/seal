import type {
  LpHolder,
  SolanaLiquidity,
  SolanaPoolKind,
  SolanaPoolLiquidity,
} from '../market/solana-types';
import { findProgramAddress } from './address';
import { SealError } from '../errors';
import { BudgetExhaustedError } from '../http';
import {
  DAMM_V2_POOL_SIZE,
  PUMPSWAP_POOL_DISCRIMINATOR,
  ratio,
  readAddress,
  readU128,
  readU64,
} from './graduation';
import { LAUNCHLAB_POOL_DISCRIMINATOR, startsWith } from './launchpads';
import {
  INCINERATOR,
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_LP_LOCK_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  associatedTokenAddress,
  knownProgram,
} from './programs';
import { accountBytes, parsedAccount, type AccountInfo, type SolanaRpc } from './rpc';

/**
 * What became of a pool's liquidity: burned, locked, or still in hands that
 * can withdraw it. One reading per kind of pool, each checked on a real pool
 * on 24/11/2026 (tests/fixtures/solana/market/):
 *
 * - LP-token pools (PumpSwap, Raydium AMM v4, Raydium CPMM): the pool counts
 *   the LP it issued; the LP mint's supply is what still exists. The gap is
 *   LP burned outside a withdrawal (a withdrawal lowers both). Of what
 *   exists, the part held for good is read from two derived accounts, Raydium
 *   Burn & Earn's vault and the incinerator's; the rest can be withdrawn.
 *   The largest holders are listed when the node serves
 *   `getTokenLargestAccounts` (a keyed node; the public one does not), never
 *   by scanning every LP account: RAY/USDC's LP has thousands of them, and
 *   that scan answered 20 MB.
 * - Meteora DAMM v2: liquidity is held in positions; the pool counts the
 *   part locked for good, and each position its own vesting.
 * - Concentrated pools (Raydium CLMM, Orca Whirlpool, Meteora DLMM) and
 *   Meteora DAMM v1: liquidity sits in positions whose holders are not read
 *   here. They are reported `known: false`, never guessed.
 */

export const POOL_KINDS: Readonly<Record<string, SolanaPoolKind>> = {
  [PUMP_SWAP_PROGRAM]: 'pumpswap',
  [RAYDIUM_AMM_V4_PROGRAM]: 'raydium-amm-v4',
  [RAYDIUM_CPMM_PROGRAM]: 'raydium-cpmm',
  [METEORA_DAMM_V2_PROGRAM]: 'meteora-damm-v2',
  [RAYDIUM_CLMM_PROGRAM]: 'raydium-clmm',
  [ORCA_WHIRLPOOL_PROGRAM]: 'orca-whirlpool',
  [METEORA_DLMM_PROGRAM]: 'meteora-dlmm',
  [METEORA_DAMM_V1_PROGRAM]: 'meteora-damm-v1',
};

/**
 * Raydium Burn & Earn's authority over locked CPMM LP: PDA
 * ["lock_cp_authority_seed"] under LockrWmn… (raydium_launchpad IDL,
 * `migrate_to_cpswap`.`lock_authority`). Derived: 3f7GcQFG…, the owner of
 * the locked LP of a LaunchLab token's CPMM pool.
 */
export const RAYDIUM_LOCK_CP_AUTHORITY = findProgramAddress(
  ['lock_cp_authority_seed'],
  RAYDIUM_LP_LOCK_PROGRAM,
).address;

/** Where each LP pool keeps its fields (sources beside each reader). */
type LpLayout = {
  size?: number;
  discriminator?: readonly number[];
  mints: [number, number];
  lpMint: number;
  /** The token program of the LP mint (read on every pool: the mint's owner). */
  lpProgram: string;
  /** The pool's own count of LP issued and not withdrawn. */
  issued: number;
  /** LP the pool counts but never minted to anyone. */
  reserve: (lpDecimals: number) => bigint;
};

const LP_LAYOUTS: Partial<Record<SolanaPoolKind, LpLayout>> = {
  // idl/pump_amm.json `Pool`: base 43, quote 75, lp_mint 107, lp_supply 203.
  // README: lp_supply is the LP supply "without burns and lock-ups".
  pumpswap: {
    discriminator: PUMPSWAP_POOL_DISCRIMINATOR,
    mints: [43, 75],
    lpMint: 107,
    lpProgram: TOKEN_2022_PROGRAM,
    issued: 203,
    reserve: () => 0n,
  },
  // raydium-amm state.rs `AmmInfo`: coin mint 400, pc mint 432, lp_mint 464,
  // lp_amount 720. processor.rs: initialize sets lp_amount to the liquidity
  // and mints it less 10^lp_decimals; withdraw subtracts what it burns.
  'raydium-amm-v4': {
    size: 752,
    mints: [400, 432],
    lpMint: 464,
    lpProgram: TOKEN_PROGRAM,
    issued: 720,
    reserve: (decimals) => 10n ** BigInt(decimals),
  },
  // raydium-cp-swap states/pool.rs `PoolState`: mints 168 and 200, lp_mint
  // 136, lp_supply 333. initialize.rs: lock_lp_amount = 100 is never minted.
  'raydium-cpmm': {
    size: 637,
    discriminator: LAUNCHLAB_POOL_DISCRIMINATOR,
    mints: [168, 200],
    lpMint: 136,
    lpProgram: TOKEN_PROGRAM,
    issued: 333,
    reserve: () => 100n,
  },
};

/** DAMM v2 `Pool` (cp-amm state/pool.rs): liquidity 360, permanent_lock_liquidity 552 (u128). */
const DAMM_V2 = { liquidity: 360, permanentLock: 552, mints: [168, 200] as const };
/**
 * DAMM v2 `Position` (state/position.rs): 408 bytes, `pool` at 8, then
 * unlocked (152), vested (168) and permanent locked (184) liquidity. Checked:
 * the positions of two pools add up to the pool's liquidity and lock.
 */
const DAMM_V2_POSITION = { size: 408, pool: 8, liquidity: 152 };

/** Largest LP holders listed per pool. */
export const MAX_LP_HOLDERS = 5;
/** Pools read per token, the main ones first. */
export const MAX_LIQUIDITY_POOLS = 3;

function kindOf(owner: string | null): SolanaPoolKind {
  return (owner && POOL_KINDS[owner]) || 'other';
}

function unknownPool(pool: string, info: AccountInfo | null, note: string): SolanaPoolLiquidity {
  const program = info?.owner ?? null;
  return {
    pool,
    program,
    kind: kindOf(program),
    programName: program ? (knownProgram(program)?.name ?? null) : null,
    known: false,
    burnedShare: null,
    lockedShare: null,
    withdrawableShare: null,
    holders: [],
    holdersCount: null,
    note,
  };
}

function holderKind(owner: string): LpHolder['kind'] {
  if (owner === RAYDIUM_LOCK_CP_AUTHORITY) return 'lock';
  if (owner === INCINERATOR) return 'burn';
  return 'wallet';
}

type ParsedMint = { supply: string; decimals: number };
type ParsedTokenAccount = { mint: string; owner: string; amount: bigint };

function parsedMint(info: AccountInfo | null, program: string): ParsedMint | null {
  if (!info || info.owner !== program) return null;
  const parsed = parsedAccount(info)?.parsed as { type?: string; info?: Partial<ParsedMint> } | undefined;
  if (parsed?.type !== 'mint' || typeof parsed.info?.supply !== 'string') return null;
  return { supply: parsed.info.supply, decimals: parsed.info.decimals ?? 0 };
}

function parsedTokenAccount(info: AccountInfo | null): ParsedTokenAccount | null {
  if (!info || (info.owner !== TOKEN_PROGRAM && info.owner !== TOKEN_2022_PROGRAM)) return null;
  const parsed = parsedAccount(info)?.parsed as
    | { type?: string; info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string } } }
    | undefined;
  const t = parsed?.info;
  if (parsed?.type !== 'account' || !t?.mint || !t.owner || typeof t.tokenAmount?.amount !== 'string') {
    return null;
  }
  return { mint: t.mint, owner: t.owner, amount: BigInt(t.tokenAmount.amount) };
}

/**
 * The accounts that hold LP for good, derived: the associated token account
 * of Raydium's lock authority (the vault of the locked LP of B4aJyVCi…'s
 * CPMM pool is that address) and the incinerator's.
 */
export function lpLockAccounts(lpMint: string, lpProgram: string): { lock: string; burn: string } {
  return {
    lock: associatedTokenAddress(RAYDIUM_LOCK_CP_AUTHORITY, lpMint, lpProgram),
    burn: associatedTokenAddress(INCINERATOR, lpMint, lpProgram),
  };
}

/**
 * The largest LP holders, with their owners: `getTokenLargestAccounts` (a
 * keyed node serves it, the public node does not), then the owners in one
 * `getMultipleAccounts`. `null` when the node would not list them.
 */
async function largestLpHolders(
  rpc: SolanaRpc,
  lpMint: string,
): Promise<{ account: string; owner: string; amount: bigint }[] | 'not-served' | 'allowance-spent'> {
  let largest;
  try {
    largest = await rpc.getTokenLargestAccounts(lpMint);
  } catch (error) {
    // A spent allowance is not a node that does not list holders: said apart.
    return error instanceof BudgetExhaustedError ? 'allowance-spent' : 'not-served';
  }
  const withBalance = largest.filter((a) => a.amount !== '0').slice(0, MAX_LP_HOLDERS);
  if (withBalance.length === 0) return [];
  let infos: (AccountInfo | null)[];
  try {
    infos = await rpc.getMultipleAccounts(
      withBalance.map((a) => a.address),
      { encoding: 'jsonParsed' },
    );
  } catch (error) {
    if (error instanceof BudgetExhaustedError) return 'allowance-spent';
    throw error;
  }
  return withBalance.flatMap((a, i) => {
    const parsed = parsedTokenAccount(infos[i] ?? null);
    return parsed && parsed.mint === lpMint
      ? [{ account: a.address, owner: parsed.owner, amount: BigInt(a.amount) }]
      : [];
  });
}

async function readLpPool(
  rpc: SolanaRpc,
  pool: string,
  info: AccountInfo,
  bytes: Uint8Array,
  layout: LpLayout,
  reads: Map<string, AccountInfo | null>,
): Promise<SolanaPoolLiquidity> {
  const lpMint = readAddress(bytes, layout.lpMint);
  const lp = parsedMint(reads.get(lpMint) ?? null, layout.lpProgram);
  if (!lp) return unknownPool(pool, info, 'the LP mint could not be read');
  const issued = readU64(bytes, layout.issued);
  if (issued <= 0n) return unknownPool(pool, info, 'the pool counts no LP: it is empty');
  const reserve = layout.reserve(lp.decimals);
  const supply = BigInt(lp.supply);
  const burned = issued - reserve - supply;

  const vaults = lpLockAccounts(lpMint, layout.lpProgram);
  const held = (address: string, owner: string): bigint => {
    const account = parsedTokenAccount(reads.get(address) ?? null);
    return account && account.mint === lpMint && account.owner === owner ? account.amount : 0n;
  };
  const locked = held(vaults.lock, RAYDIUM_LOCK_CP_AUTHORITY) + held(vaults.burn, INCINERATOR);
  const withdrawable = supply > locked ? supply - locked : 0n;

  const listed = withdrawable > 0n ? await largestLpHolders(rpc, lpMint) : [];
  const largest = Array.isArray(listed) ? listed : null;
  const notes = [
    burned < 0n ? 'the LP mint holds more than the pool counts: shares are of the pool’s count' : null,
    listed === 'not-served' ? 'the LP holders were not listed: the node does not serve getTokenLargestAccounts' : null,
    listed === 'allowance-spent' ? 'the LP holders were not listed: the read ran out of calls' : null,
  ].filter((n): n is string => n !== null);
  return {
    pool,
    program: info.owner,
    kind: kindOf(info.owner),
    programName: knownProgram(info.owner)?.name ?? null,
    known: true,
    burnedShare: ratio(burned, issued),
    lockedShare: ratio(locked, issued),
    withdrawableShare: ratio(withdrawable, issued),
    holders: (largest ?? []).map((h) => ({
      account: h.account,
      owner: h.owner,
      share: ratio(h.amount, issued),
      kind: holderKind(h.owner),
    })),
    holdersCount: null,
    note: notes.length > 0 ? notes.join('; ') : null,
  };
}

async function readDammV2(rpc: SolanaRpc, pool: string, info: AccountInfo, bytes: Uint8Array): Promise<SolanaPoolLiquidity> {
  const liquidity = readU128(bytes, DAMM_V2.liquidity);
  const permanent = readU128(bytes, DAMM_V2.permanentLock);
  const positions = await rpc.getProgramAccounts(METEORA_DAMM_V2_PROGRAM, {
    dataSlice: { offset: DAMM_V2_POSITION.liquidity, length: 48 },
    filters: [{ dataSize: DAMM_V2_POSITION.size }, { memcmp: { offset: DAMM_V2_POSITION.pool, bytes: pool } }],
  });
  let unlocked = 0n;
  let vested = 0n;
  let locked = 0n;
  for (const { account } of positions) {
    const b = accountBytes(account);
    if (!b || b.length < 48) continue;
    unlocked += readU128(b, 0);
    vested += readU128(b, 16);
    locked += readU128(b, 32);
  }
  // The positions add up to the pool (checked on BjoLhk… and CP222U…); when
  // they do not, some were not returned and the shares below fall short.
  const complete = unlocked + vested + locked === liquidity;
  const vestedShare = ratio(vested, liquidity);
  const notes =
    liquidity === 0n
      ? ['the pool holds no liquidity']
      : [
          vested > 0n ? `${(vestedShare * 100).toFixed(2)}% of the liquidity unlocks over time (vesting)` : null,
          // A position is held through its NFT; who holds each NFT is not read here.
          unlocked > 0n ? 'who holds the positions that can be withdrawn is not read' : null,
          complete ? null : 'the positions read do not add up to the pool’s liquidity: the withdrawable part may be larger',
        ].filter((n): n is string => n !== null);
  return {
    pool,
    program: info.owner,
    kind: 'meteora-damm-v2',
    programName: knownProgram(info.owner)?.name ?? null,
    known: liquidity > 0n,
    burnedShare: null,
    lockedShare: liquidity > 0n ? ratio(permanent, liquidity) : null,
    withdrawableShare: liquidity > 0n ? ratio(unlocked, liquidity) : null,
    holders: [],
    holdersCount: positions.length,
    note: notes.length > 0 ? notes.join('; ') : null,
  };
}

const NOT_READ: Partial<Record<SolanaPoolKind, string>> = {
  'raydium-clmm': 'Raydium CLMM liquidity sits in positions whose holders are not read',
  'orca-whirlpool': 'Orca Whirlpool liquidity sits in positions whose holders are not read',
  'meteora-dlmm': 'Meteora DLMM liquidity sits in positions whose holders are not read',
  'meteora-damm-v1': 'Meteora DAMM v1 LP is held through vaults that are not read',
};

/**
 * One pool's read: when its own calls fail (rate limit, spent allowance, a
 * node error), that pool is reported unknown with the reason and the pools
 * already read stand. Anything else is a bug and is thrown.
 */
async function isolated(
  pool: string,
  info: AccountInfo,
  read: () => Promise<SolanaPoolLiquidity>,
): Promise<SolanaPoolLiquidity> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SealError || error instanceof BudgetExhaustedError) {
      return unknownPool(pool, info, `the pool could not be read: ${error.message}`);
    }
    throw error;
  }
}

function holdsMint(bytes: Uint8Array, offsets: readonly number[], mint: string): boolean {
  return offsets.some((o) => bytes.length >= o + 32 && readAddress(bytes, o) === mint);
}

/**
 * What became of the liquidity of a token's pools (the first
 * `MAX_LIQUIDITY_POOLS` given, the main one first). At most 2 + one call per
 * pool read: the pools, their LP mints, then each pool's LP holders or
 * positions.
 */
export async function readSolanaLiquidity(
  rpc: SolanaRpc,
  mint: string,
  pools: readonly string[],
  options: { now?: () => Date; maxPools?: number } = {},
): Promise<SolanaLiquidity> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const ids = [...new Set(pools)].slice(0, options.maxPools ?? MAX_LIQUIDITY_POOLS);
  if (ids.length === 0) {
    return {
      completeness: 'unavailable',
      sources: [{ name: 'solana-rpc', fetchedAt, note: 'no pool to read' }],
      data: { mint, pools: [] },
    };
  }
  const infos = await rpc.getMultipleAccounts(ids);
  const decoded = ids.map((pool, i) => {
    const info = infos[i] ?? null;
    const bytes = info ? accountBytes(info) : null;
    const kind = kindOf(info?.owner ?? null);
    return { pool, info, bytes, kind, layout: LP_LAYOUTS[kind] };
  });

  // One call for every LP mint and the accounts that would hold its LP for good.
  const wanted = decoded.flatMap((d) => {
    if (!d.layout || !d.bytes || d.bytes.length < d.layout.issued + 8) return [];
    const lpMint = readAddress(d.bytes, d.layout.lpMint);
    const { lock, burn } = lpLockAccounts(lpMint, d.layout.lpProgram);
    return [lpMint, lock, burn];
  });
  const unique = [...new Set(wanted)];
  const answers = unique.length > 0 ? await rpc.getMultipleAccounts(unique, { encoding: 'jsonParsed' }) : [];
  const reads = new Map(unique.map((address, i) => [address, answers[i] ?? null]));

  const out: SolanaPoolLiquidity[] = [];
  for (const d of decoded) {
    if (!d.info || !d.bytes) {
      out.push(unknownPool(d.pool, d.info, 'no pool account at this address'));
      continue;
    }
    if (d.layout) {
      const fits =
        (d.layout.size === undefined || d.bytes.length === d.layout.size) &&
        (d.layout.discriminator === undefined || startsWith(d.bytes, d.layout.discriminator)) &&
        d.bytes.length >= d.layout.issued + 8;
      if (!fits) {
        out.push(unknownPool(d.pool, d.info, 'the pool account does not have the layout read'));
      } else if (!holdsMint(d.bytes, d.layout.mints, mint)) {
        out.push(unknownPool(d.pool, d.info, 'the pool does not hold this token'));
      } else {
        const info = d.info;
        const bytes = d.bytes;
        const layout = d.layout;
        out.push(await isolated(d.pool, info, () => readLpPool(rpc, d.pool, info, bytes, layout, reads)));
      }
      continue;
    }
    if (d.kind === 'meteora-damm-v2') {
      if (d.bytes.length !== DAMM_V2_POOL_SIZE || !startsWith(d.bytes, PUMPSWAP_POOL_DISCRIMINATOR)) {
        out.push(unknownPool(d.pool, d.info, 'the pool account does not have the layout read'));
      } else if (!holdsMint(d.bytes, DAMM_V2.mints, mint)) {
        out.push(unknownPool(d.pool, d.info, 'the pool does not hold this token'));
      } else {
        const info = d.info;
        const bytes = d.bytes;
        out.push(await isolated(d.pool, info, () => readDammV2(rpc, d.pool, info, bytes)));
      }
      continue;
    }
    out.push(
      unknownPool(
        d.pool,
        d.info,
        NOT_READ[d.kind] ??
          (knownProgram(d.info.owner)?.kind === 'launchpad'
            ? 'a launchpad curve, not a pool: see the graduation'
            : 'a pool program SEAL does not read: its liquidity is unknown'),
      ),
    );
  }

  const unknown = out.filter((p) => !p.known).length;
  return {
    completeness: unknown === 0 ? 'full' : unknown === out.length ? 'unavailable' : 'partial',
    sources: [
      {
        name: 'solana-rpc',
        fetchedAt,
        ...(unknown > 0
          ? { note: `${unknown} of ${out.length} pools read could not be described: ${out.filter((p) => !p.known).map((p) => p.note).join('; ')}` }
          : {}),
      },
    ],
    data: { mint, pools: out },
  };
}
