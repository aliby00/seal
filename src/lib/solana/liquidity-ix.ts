import { sha256 } from '@noble/hashes/sha2';
import { decodeBase58 } from './address';
import {
  FLUXBEAM_PROGRAM,
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
} from './programs';
import { transactionKeys, type SolanaTransaction } from './rpc';

/**
 * Whether a transaction added liquidity to a pool or took some out, from the
 * instructions it ran: a pool created with its first tokens, a deposit, a
 * position opened or increased (add); a withdrawal, a position decreased
 * (remove). A trade is neither.
 *
 * Why it matters: a wallet that seeds a pool gives the pool its tokens and
 * pays SOL besides. Read from balances alone, the tokens leaving its account
 * for a pool look like a sale. On mainnet (read 26/11/2026):
 * - GIGA 63LfDm…: 5Td2rKaX… is a Raydium AMM v4 `initialize2` signed by the
 *   creator, 87.5 % of the supply and 15 SOL into the pool, logged as
 *   `init_pc_amount: 15000000000, init_coin_amount: 875000000000000`;
 * - NEST 68Nq68…: VCciyf8H… is a Meteora DAMM v2 `initialize_customizable_pool`
 *   taking 40.2 % of the supply from the creator, one-sided;
 * - "SOL" 6Dyz9e…: 4TpKiF… is a Raydium CLMM `create_customizable_pool_v2`
 *   then `open_position_with_token22_nft`, 99.99 % of the supply deposited;
 * - POPCAT 7GCihg…: 5CdhWtCP… is a Meteora DAMM v1
 *   `initialize_permissionless_pool_with_fee_tier`.
 * Each was read as the creator "selling" those tokens.
 *
 * Anchor programs name an instruction by its first 8 data bytes,
 * sha256("global:<name>")[..8]; every discriminator above matched its
 * transaction (tests/solana/liquidity-ix.test.ts). Raydium AMM v4 and
 * FluxBeam (SPL token-swap) are not Anchor: one tag byte
 * (raydium-amm program/src/instruction.rs: 0 initialize, 1 initialize2,
 * 3 deposit, 4 withdraw; spl token-swap: 0 initialize, 2 and 4 deposit,
 * 3 and 5 withdraw).
 */

export type LiquidityAction = 'add' | 'remove';

const anchor = (name: string) => sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);

type Venue = {
  program: string;
  add: readonly string[];
  remove: readonly string[];
};

/** Instruction names by program: from each project's IDL. */
const ANCHOR_VENUES: readonly Venue[] = [
  {
    // cp-amm IDL (MeteoraAg/damm-v2).
    program: METEORA_DAMM_V2_PROGRAM,
    add: [
      'initialize_pool',
      'initialize_customizable_pool',
      'initialize_pool_with_dynamic_config',
      'add_liquidity',
    ],
    remove: ['remove_liquidity', 'remove_all_liquidity'],
  },
  {
    // dynamic-amm IDL (MeteoraAg/dynamic-amm-sdk). Its vault's own `deposit`
    // and `withdraw` run in every swap: the vault program is not listed.
    program: METEORA_DAMM_V1_PROGRAM,
    add: [
      'initialize_permissionless_pool',
      'initialize_permissionless_pool_with_fee_tier',
      'initialize_permissionless_constant_product_pool_with_config',
      'initialize_permissionless_constant_product_pool_with_config2',
      'initialize_customizable_permissionless_constant_product_pool',
      'add_balance_liquidity',
      'add_imbalance_liquidity',
      'bootstrap_liquidity',
    ],
    remove: ['remove_balance_liquidity', 'remove_liquidity_single_side'],
  },
  {
    // lb_clmm IDL (MeteoraAg/dlmm-sdk).
    program: METEORA_DLMM_PROGRAM,
    add: [
      'add_liquidity',
      'add_liquidity2',
      'add_liquidity_by_weight',
      'add_liquidity_by_strategy',
      'add_liquidity_by_strategy2',
      'add_liquidity_by_strategy_one_side',
      'add_liquidity_one_side',
      'add_liquidity_one_side_precise',
      'add_liquidity_one_side_precise2',
    ],
    remove: [
      'remove_liquidity',
      'remove_liquidity2',
      'remove_liquidity_by_range',
      'remove_liquidity_by_range2',
      'remove_all_liquidity',
    ],
  },
  {
    // amm_v3 IDL (raydium-io/raydium-idl).
    program: RAYDIUM_CLMM_PROGRAM,
    add: [
      'open_position',
      'open_position_v2',
      'open_position_with_token22_nft',
      'increase_liquidity',
      'increase_liquidity_v2',
    ],
    remove: ['decrease_liquidity', 'decrease_liquidity_v2'],
  },
  {
    // raydium_cp_swap IDL.
    program: RAYDIUM_CPMM_PROGRAM,
    add: ['initialize', 'initialize_with_permission', 'deposit'],
    remove: ['withdraw'],
  },
  {
    // pump_amm IDL (pump-fun/pump-public-docs): its trades are `buy` and `sell`.
    program: PUMP_SWAP_PROGRAM,
    add: ['create_pool', 'deposit'],
    remove: ['withdraw'],
  },
  {
    // whirlpool IDL (orca-so/whirlpools): opening a position moves no token.
    program: ORCA_WHIRLPOOL_PROGRAM,
    add: ['increase_liquidity', 'increase_liquidity_v2'],
    remove: ['decrease_liquidity', 'decrease_liquidity_v2'],
  },
];

/** Tag-byte programs: Raydium AMM v4 and the SPL token-swap layout (FluxBeam). */
const TAG_VENUES: ReadonlyMap<string, { add: readonly number[]; remove: readonly number[] }> =
  new Map([
    [RAYDIUM_AMM_V4_PROGRAM, { add: [0, 1, 3], remove: [4] }],
    [FLUXBEAM_PROGRAM, { add: [0, 2, 4], remove: [3, 5] }],
  ]);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** `${program} ${discriminator}` → action. */
const BY_DISCRIMINATOR: ReadonlyMap<string, LiquidityAction> = new Map(
  ANCHOR_VENUES.flatMap((v) => [
    ...v.add.map((name) => [`${v.program} ${hex(anchor(name))}`, 'add'] as const),
    ...v.remove.map((name) => [`${v.program} ${hex(anchor(name))}`, 'remove'] as const),
  ]),
);

/** The action of one instruction, `null` when it is none of the above. */
export function liquidityActionOf(programId: string, data: Uint8Array): LiquidityAction | null {
  const tags = TAG_VENUES.get(programId);
  if (tags) {
    const tag = data[0];
    if (tag === undefined) return null;
    if (tags.add.includes(tag)) return 'add';
    if (tags.remove.includes(tag)) return 'remove';
    return null;
  }
  if (data.length < 8) return null;
  return BY_DISCRIMINATOR.get(`${programId} ${hex(data.subarray(0, 8))}`) ?? null;
}

/**
 * What the transaction did to a pool's liquidity, at any depth (a router or
 * a launchpad can call the pool). `null` when no instruction added or removed
 * any; when both appear (a position moved from one range to another), the
 * first one met.
 */
export function liquidityAction(tx: SolanaTransaction): LiquidityAction | null {
  const keys = transactionKeys(tx);
  const all = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  for (const ix of all) {
    const programId = keys[ix.programIdIndex] ?? '';
    if (!TAG_VENUES.has(programId) && !ANCHOR_VENUES.some((v) => v.program === programId)) continue;
    let data: Uint8Array;
    try {
      data = decodeBase58(ix.data);
    } catch {
      continue;
    }
    const action = liquidityActionOf(programId, data);
    if (action) return action;
  }
  return null;
}
