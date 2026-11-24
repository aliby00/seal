import type {
  SolanaLaunch,
  SolanaLaunchpadId,
  SolanaLaunchpadRef,
} from '../market/solana-types';
import { addressBytes, decodeBase58, encodeBase58, findProgramAddress } from './address';
import {
  METEORA_DBC_PROGRAM,
  NATIVE_MINT,
  PUMP_FUN_PROGRAM,
  RAYDIUM_LAUNCHLAB_PROGRAM,
  pumpBondingCurveAddress,
} from './programs';
import {
  accountBytes,
  transactionKeys,
  type AccountInfo,
  type SolanaRpc,
  type SolanaTransaction,
} from './rpc';

/**
 * Which launchpad a Solana token came from: pump.fun, Meteora Dynamic
 * Bonding Curve or Raydium LaunchLab.
 *
 * Read two ways, both checked on mainnet on 24/11/2026:
 * - the launchpad's own account for the token (pump.fun bonding curve, DBC
 *   virtual pool, LaunchLab pool state), recognised by its owner program, its
 *   Anchor account discriminator and the mint written in it;
 * - the instruction that created the token in its first transaction, by
 *   program and instruction discriminator, the mint among its accounts.
 *
 * Every offset and discriminator below was compared against real accounts
 * and transactions (tests/fixtures/solana/market/). A launchpad not listed
 * here is not guessed: the answer is "none of these", and the read says so.
 */

/** Anchor account discriminators, as the first 8 bytes of each account read. */
export const PUMP_BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96] as const;
export const DBC_VIRTUAL_POOL_DISCRIMINATOR = [213, 224, 5, 209, 98, 69, 119, 92] as const;
/** LaunchLab `PoolState`; Raydium CPMM's `PoolState` has the same name, hence the same bytes. */
export const LAUNCHLAB_POOL_DISCRIMINATOR = [247, 237, 227, 245, 215, 195, 222, 70] as const;

/**
 * DBC `VirtualPool`: 8-byte discriminator, then `VolatilityTracker` (64
 * bytes), `config`, `creator`, `base_mint`… (state/virtual_pool.rs,
 * https://github.com/MeteoraAg/dynamic-bonding-curve). 424 bytes; the mint at
 * 136 on every pool read.
 */
export const DBC_POOL_SIZE = 424;
export const DBC_BASE_MINT_OFFSET = 136;
/**
 * LaunchLab `PoolState` (IDL https://github.com/raydium-io/raydium-idl,
 * raydium_launchpad): 429 bytes, `base_mint` at 205, `quote_mint` at 237.
 */
export const LAUNCHLAB_POOL_SIZE = 429;
export const LAUNCHLAB_BASE_MINT_OFFSET = 205;

type CreateInstruction = { name: string; discriminator: readonly number[] };

export type SolanaLaunchpad = SolanaLaunchpadRef & {
  /** The instructions that create a token, as their first 8 data bytes. */
  creates: readonly CreateInstruction[];
};

export const SOLANA_LAUNCHPADS: readonly SolanaLaunchpad[] = [
  {
    id: 'pump.fun',
    name: 'pump.fun',
    program: PUMP_FUN_PROGRAM,
    // IDL: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json.
    // create_v2 seen in the creation transactions of three pump.fun tokens.
    creates: [
      { name: 'create_v2', discriminator: [214, 144, 76, 236, 95, 139, 49, 180] },
      { name: 'create', discriminator: [24, 30, 200, 40, 5, 28, 7, 119] },
    ],
  },
  {
    id: 'meteora-dbc',
    name: 'Meteora Dynamic Bonding Curve',
    program: METEORA_DBC_PROGRAM,
    // IDL: dynamic-bonding-curve scripts/idl/release_0.1.6.json; the SPL one
    // seen creating 8xKZ1yzP… (InitializeVirtualPoolWithSplToken).
    creates: [
      { name: 'initialize_virtual_pool_with_spl_token', discriminator: [140, 85, 215, 176, 102, 54, 104, 79] },
      { name: 'initialize_virtual_pool_with_token2022', discriminator: [169, 118, 51, 78, 145, 110, 220, 155] },
    ],
  },
  {
    id: 'raydium-launchlab',
    name: 'Raydium LaunchLab',
    program: RAYDIUM_LAUNCHLAB_PROGRAM,
    // IDL: raydium-idl raydium_launchpad.json; initialize_with_token_2022 seen
    // creating FnYLY1FQ… and 4fmByijA… (InitializeWithToken2022).
    creates: [
      { name: 'initialize_with_token_2022', discriminator: [37, 190, 126, 222, 44, 154, 171, 17] },
      { name: 'initialize_v2', discriminator: [67, 153, 175, 39, 218, 16, 38, 32] },
      { name: 'initialize', discriminator: [175, 175, 109, 31, 13, 152, 155, 237] },
    ],
  },
];

export function launchpadById(id: SolanaLaunchpadId): SolanaLaunchpad {
  return SOLANA_LAUNCHPADS.find((l) => l.id === id) as SolanaLaunchpad;
}

function ref(id: SolanaLaunchpadId): SolanaLaunchpadRef {
  const { name, program } = launchpadById(id);
  return { id, name, program };
}

export function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/** LaunchLab pool of a mint: seeds ["pool", base mint, quote mint] (IDL, checked on mainnet). */
export function launchLabPoolAddress(mint: string, quoteMint: string = NATIVE_MINT): string {
  return findProgramAddress(
    ['pool', addressBytes(mint), addressBytes(quoteMint)],
    RAYDIUM_LAUNCHLAB_PROGRAM,
  ).address;
}

function mintAt(bytes: Uint8Array, offset: number): string | null {
  return bytes.length >= offset + 32 ? encodeBase58(bytes.subarray(offset, offset + 32)) : null;
}

/**
 * The launchpad an account belongs to, when it is the launch account of
 * `mint`: owner, discriminator and the mint written in it must all agree.
 */
export function launchpadOfAccount(
  mint: string,
  address: string,
  info: Pick<AccountInfo, 'owner' | 'data'> | null,
): SolanaLaunchpadId | null {
  if (!info) return null;
  const bytes = accountBytes(info);
  if (!bytes) return null;
  if (info.owner === PUMP_FUN_PROGRAM && startsWith(bytes, PUMP_BONDING_CURVE_DISCRIMINATOR)) {
    // The curve does not name its mint: its address is derived from it.
    return address === pumpBondingCurveAddress(mint) ? 'pump.fun' : null;
  }
  if (
    info.owner === METEORA_DBC_PROGRAM &&
    startsWith(bytes, DBC_VIRTUAL_POOL_DISCRIMINATOR) &&
    mintAt(bytes, DBC_BASE_MINT_OFFSET) === mint
  ) {
    return 'meteora-dbc';
  }
  if (
    info.owner === RAYDIUM_LAUNCHLAB_PROGRAM &&
    startsWith(bytes, LAUNCHLAB_POOL_DISCRIMINATOR) &&
    mintAt(bytes, LAUNCHLAB_BASE_MINT_OFFSET) === mint
  ) {
    return 'raydium-launchlab';
  }
  return null;
}

export type LaunchAccount = {
  launchpad: SolanaLaunchpadId;
  address: string;
  info: AccountInfo;
};

/**
 * The launch account of a mint, at most three calls: one `getMultipleAccounts`
 * on the derived addresses (pump.fun curve, LaunchLab pool against SOL) and
 * any `hints` (DexScreener pairs), then, when none is the launch account, a
 * `getProgramAccounts` on DBC and one on LaunchLab, filtered on the mint.
 */
export async function findLaunchAccount(
  rpc: SolanaRpc,
  mint: string,
  options: { hints?: readonly string[] } = {},
): Promise<LaunchAccount | null> {
  const candidates = [
    ...new Set([pumpBondingCurveAddress(mint), launchLabPoolAddress(mint), ...(options.hints ?? [])]),
  ].slice(0, 100);
  const infos = await rpc.getMultipleAccounts(candidates);
  for (const [i, address] of candidates.entries()) {
    const info = infos[i] ?? null;
    const launchpad = launchpadOfAccount(mint, address, info);
    if (launchpad && info) return { launchpad, address, info };
  }

  for (const [program, size, offset] of [
    [METEORA_DBC_PROGRAM, DBC_POOL_SIZE, DBC_BASE_MINT_OFFSET],
    [RAYDIUM_LAUNCHLAB_PROGRAM, LAUNCHLAB_POOL_SIZE, LAUNCHLAB_BASE_MINT_OFFSET],
  ] as const) {
    const found = await rpc.getProgramAccounts(program, {
      filters: [{ dataSize: size }, { memcmp: { offset, bytes: mint } }],
    });
    for (const { pubkey, account } of found) {
      const launchpad = launchpadOfAccount(mint, pubkey, account);
      if (launchpad) return { launchpad, address: pubkey, info: account };
    }
  }
  return null;
}

/** The launch read from its account; `none` when no launchpad above holds one for the mint. */
export async function readSolanaLaunch(
  rpc: SolanaRpc,
  mint: string,
  options: { hints?: readonly string[]; now?: () => Date; found?: LaunchAccount | null } = {},
): Promise<SolanaLaunch> {
  const found =
    options.found !== undefined ? options.found : await findLaunchAccount(rpc, mint, options);
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  return {
    completeness: 'full',
    sources: [
      {
        name: 'solana-rpc',
        fetchedAt,
        ...(found
          ? {}
          : {
              note: 'no pump.fun curve, Meteora DBC pool or Raydium LaunchLab pool holds this mint',
            }),
      },
    ],
    data: {
      mint,
      launchpad: found ? ref(found.launchpad) : null,
      account: found?.address ?? null,
      foundBy: found ? 'curve-account' : null,
    },
  };
}

export type CreationInstruction = {
  launchpad: SolanaLaunchpadRef;
  instruction: string;
  /** Whether the instruction was called by the transaction itself or by another program. */
  inner: boolean;
};

/**
 * The launchpad instruction that created `mint` in a transaction: a create
 * instruction of one of the launchpads above with the mint among its
 * accounts, called directly or from another program. `null` when none did.
 */
export function creationInstruction(
  tx: SolanaTransaction,
  mint: string,
): CreationInstruction | null {
  const keys = transactionKeys(tx);
  const all = [
    ...tx.transaction.message.instructions.map((ix) => ({ ix, inner: false })),
    ...(tx.meta?.innerInstructions ?? []).flatMap((group) =>
      group.instructions.map((ix) => ({ ix, inner: true })),
    ),
  ];
  for (const { ix, inner } of all) {
    const launchpad = SOLANA_LAUNCHPADS.find((l) => l.program === keys[ix.programIdIndex]);
    if (!launchpad || !ix.accounts.some((index) => keys[index] === mint)) continue;
    let data: Uint8Array;
    try {
      data = decodeBase58(ix.data);
    } catch {
      continue;
    }
    const create = launchpad.creates.find((c) => startsWith(data, c.discriminator));
    if (create) return { launchpad: ref(launchpad.id), instruction: create.name, inner };
  }
  return null;
}

/** The launch read from the token's first transaction, for a caller that already has it. */
export function launchFromTransaction(
  tx: SolanaTransaction,
  mint: string,
  options: { now?: () => Date } = {},
): SolanaLaunch {
  const found = tx.meta?.err ? null : creationInstruction(tx, mint);
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  return {
    completeness: 'full',
    sources: [
      {
        name: 'solana-rpc',
        fetchedAt,
        ...(found
          ? {}
          : { note: 'the transaction given creates the mint with none of the launchpads read' }),
      },
    ],
    data: {
      mint,
      launchpad: found?.launchpad ?? null,
      account: null,
      foundBy: found ? 'creation-transaction' : null,
    },
  };
}
