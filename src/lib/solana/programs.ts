import { addressBytes, findProgramAddress } from './address';

/**
 * Solana programs and accounts SEAL reads.
 *
 * Every program below was read with `getAccountInfo` on mainnet on
 * 24/11/2026 and is executable (tests/fixtures/solana/programs/accounts.json,
 * checked by tests/solana/programs.test.ts). Its identity comes from the
 * source named beside it: the project's own documentation, or pools whose
 * account this program owns and that DexScreener lists under that venue.
 * Nothing here is assumed: a program that could not be checked is absent.
 */

/** Native system program. https://docs.rs/solana-sdk-ids/latest/src/solana_sdk_ids/lib.rs.html */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** SPL Token. Owner of the USDC, BONK, JUP and RAY mints (read 24/11/2026). */
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** SPL Token-2022. Owner of the PYUSD mint and of new pump.fun mints (read 24/11/2026). */
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/**
 * Associated Token Account program. Checked by derivation: the token
 * accounts of the creation-slot buyers of a pump.fun token are the
 * addresses `associatedTokenAddress` gives (tests/solana/address.test.ts).
 */
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/**
 * Metaplex Token Metadata. https://github.com/metaplex-foundation/mpl-token-metadata
 * Checked by derivation: the metadata accounts of USDC, BONK, JUP and RAY
 * are owned by it and name their mint.
 */
export const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

/** pump.fun bonding curve. https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md */
export const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** PumpSwap AMM. https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md */
export const PUMP_SWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** Raydium programs. https://docs.raydium.io/reference/program-addresses */
export const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
export const RAYDIUM_LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
/** Raydium's "Burn & Earn" liquidity lock. */
export const RAYDIUM_LP_LOCK_PROGRAM = 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE';

/** Meteora Dynamic Bonding Curve. https://docs.meteora.ag/developer-guides/dbc */
export const METEORA_DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
/** Meteora DAMM v2 (cp_amm). https://docs.meteora.ag/developer-guides/damm-v2 */
export const METEORA_DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
/**
 * Meteora DAMM v1 (dynamic AMM). Owner of the BONK/SOL and BONK/USDC pools
 * DexScreener lists as meteora "DYN" (278P6iwd…, N4xy6PT6…; read 24/11/2026).
 */
export const METEORA_DAMM_V1_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
/** Meteora DLMM (lb_clmm). https://docs.meteora.ag/developer-guides/dlmm */
export const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

/** Orca Whirlpool. https://github.com/orca-so/whirlpools (README, "official deployment"). */
export const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

/** Streamflow vesting and locks. https://developers.streamflow.finance/docs/resources/program-ids */
export const STREAMFLOW_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';
/** Jupiter Lock. https://developers.jup.ag/docs/lock */
export const JUPITER_LOCK_PROGRAM = 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn';

/**
 * The incinerator: tokens sent to its token accounts are out of reach for
 * good. Not a program, and no account lives at the address itself
 * (`getAccountInfo` → null, 24/11/2026).
 * https://docs.rs/solana-sdk-ids/latest/src/solana_sdk_ids/lib.rs.html (`incinerator`)
 */
export const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

/** Wrapped SOL mint (SPL Token, 9 decimals; read 24/11/2026). */
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export type ProgramKind = 'core' | 'token' | 'metadata' | 'launchpad' | 'amm' | 'lock';

export type KnownProgram = { address: string; name: string; kind: ProgramKind };

/** Every program above, by address. Names are those the projects use. */
export const KNOWN_PROGRAMS: readonly KnownProgram[] = [
  { address: SYSTEM_PROGRAM, name: 'System Program', kind: 'core' },
  { address: TOKEN_PROGRAM, name: 'SPL Token', kind: 'token' },
  { address: TOKEN_2022_PROGRAM, name: 'Token-2022', kind: 'token' },
  { address: ASSOCIATED_TOKEN_PROGRAM, name: 'Associated Token Account', kind: 'token' },
  { address: TOKEN_METADATA_PROGRAM, name: 'Metaplex Token Metadata', kind: 'metadata' },
  { address: PUMP_FUN_PROGRAM, name: 'pump.fun', kind: 'launchpad' },
  { address: PUMP_SWAP_PROGRAM, name: 'PumpSwap', kind: 'amm' },
  { address: RAYDIUM_AMM_V4_PROGRAM, name: 'Raydium AMM v4', kind: 'amm' },
  { address: RAYDIUM_CPMM_PROGRAM, name: 'Raydium CPMM', kind: 'amm' },
  { address: RAYDIUM_CLMM_PROGRAM, name: 'Raydium CLMM', kind: 'amm' },
  { address: RAYDIUM_LAUNCHLAB_PROGRAM, name: 'Raydium LaunchLab', kind: 'launchpad' },
  { address: RAYDIUM_LP_LOCK_PROGRAM, name: 'Raydium Burn & Earn', kind: 'lock' },
  { address: METEORA_DBC_PROGRAM, name: 'Meteora Dynamic Bonding Curve', kind: 'launchpad' },
  { address: METEORA_DAMM_V2_PROGRAM, name: 'Meteora DAMM v2', kind: 'amm' },
  { address: METEORA_DAMM_V1_PROGRAM, name: 'Meteora DAMM v1', kind: 'amm' },
  { address: METEORA_DLMM_PROGRAM, name: 'Meteora DLMM', kind: 'amm' },
  { address: ORCA_WHIRLPOOL_PROGRAM, name: 'Orca Whirlpool', kind: 'amm' },
  { address: STREAMFLOW_PROGRAM, name: 'Streamflow', kind: 'lock' },
  { address: JUPITER_LOCK_PROGRAM, name: 'Jupiter Lock', kind: 'lock' },
];

const byAddress = new Map(KNOWN_PROGRAMS.map((p) => [p.address, p]));

/** The program at `address`, when it is one of the above. Exact match: addresses are case-sensitive. */
export function knownProgram(address: string): KnownProgram | undefined {
  return byAddress.get(address);
}

/** Whether `programId` is one of the two token programs. */
export function isTokenProgram(programId: string): boolean {
  return programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM;
}

// ── Derived addresses, each checked against accounts read on mainnet ────────

/**
 * The associated token account of `owner` for `mint`: seeds
 * [owner, token program, mint] under the ATA program. The token program is
 * the mint's owner (SPL Token or Token-2022): the same owner and mint give a
 * different address under each.
 */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  return findProgramAddress(
    [addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM,
  ).address;
}

/** Metaplex metadata account of a mint: seeds ["metadata", program, mint]. */
export function metadataAddress(mint: string): string {
  return findProgramAddress(
    ['metadata', addressBytes(TOKEN_METADATA_PROGRAM), addressBytes(mint)],
    TOKEN_METADATA_PROGRAM,
  ).address;
}

/** pump.fun bonding curve of a mint: seeds ["bonding-curve", mint] (PUMP_PROGRAM_README). */
export function pumpBondingCurveAddress(mint: string): string {
  return findProgramAddress(['bonding-curve', addressBytes(mint)], PUMP_FUN_PROGRAM).address;
}
