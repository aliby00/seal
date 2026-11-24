import { sha256 } from '@noble/hashes/sha2';
import { encodeBase58, findProgramAddress, isOnCurve } from './address';
import {
  INCINERATOR,
  isTokenProgram,
  JUPITER_LOCK_PROGRAM,
  knownProgram,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DBC_PROGRAM,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_FUN_PROGRAM,
  PUMP_SWAP_PROGRAM,
  pumpBondingCurveAddress,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_LAUNCHLAB_PROGRAM,
  STREAMFLOW_PROGRAM,
} from './programs';

/**
 * What the owner of a token account is, read on chain.
 *
 * A token account holds tokens for its `owner`. When the owner is a point of
 * the ed25519 curve, a private key can sign for it: a wallet. When it is off
 * the curve, it is a program-derived address and only a program can move what
 * it holds: a bonding curve, a pool, a lock, or something else. The role is
 * said only when the chain shows it (the account's owning program and its
 * Anchor discriminator, or an authority address derived from the program's
 * own seeds); otherwise the owner is a "program account", never guessed.
 *
 * Every rule below was checked on mainnet on 24/11/2026 against real pools,
 * curves and locks; each says where.
 */

export type OwnerRoleKind = 'wallet' | 'curve' | 'pool' | 'lock' | 'burn' | 'program-account';

export type OwnerRole = {
  kind: OwnerRoleKind;
  /** How a report names it: "pump.fun bonding curve", "PumpSwap pool", "Jupiter Lock escrow". */
  name: string;
  /** The program behind the role, when one is known. */
  program?: string;
  /** What was read to say so, for a reader to check. */
  evidence: string;
};

/** The first 8 bytes of an Anchor account: sha256("account:<Name>")[0..8]. */
export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`account:${name}`)).subarray(0, 8);
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Accounts that own token accounts as a pool, a curve or a lock: the program
 * that owns the account, and the Anchor account type its first 8 bytes name.
 * Each pair was read on a real account holding the vault of a real token
 * (24/11/2026, pools DexScreener lists under the venue):
 *  - pump.fun `BondingCurve` (17b7f837…): curve 8j8apXSG… of ANDLpP3C…pump;
 *  - PumpSwap `Pool` (f19a6d04…): pool DjbLtX1H… owns vault 33J8AEXc…;
 *  - Raydium CLMM `PoolState` (f7ede3f5…): GtKKKs3y… owns BONK vault 2wzaFLYb…;
 *  - Orca Whirlpool `Whirlpool` (3f95d10c…): 5zpyutJu… owns BONK vault 4dmvFGeQ…;
 *  - Meteora DLMM `LbPair` (210b3162…): 31p1hptj… owns BONK vault GdRr8u8c…;
 *  - Jupiter Lock `VestingEscrow` (f477b704…): escrows 7b5uNn86…, 9bNpHSun…
 *    and five others own the locked tokens of their escrow.
 */
const OWNED_ROLES: readonly {
  program: string;
  account: string;
  kind: 'curve' | 'pool' | 'lock';
  name: string;
}[] = [
  {
    program: PUMP_FUN_PROGRAM,
    account: 'BondingCurve',
    kind: 'curve',
    name: 'pump.fun bonding curve',
  },
  { program: PUMP_SWAP_PROGRAM, account: 'Pool', kind: 'pool', name: 'PumpSwap pool' },
  { program: RAYDIUM_CLMM_PROGRAM, account: 'PoolState', kind: 'pool', name: 'Raydium CLMM pool' },
  {
    program: ORCA_WHIRLPOOL_PROGRAM,
    account: 'Whirlpool',
    kind: 'pool',
    name: 'Orca Whirlpool pool',
  },
  { program: METEORA_DLMM_PROGRAM, account: 'LbPair', kind: 'pool', name: 'Meteora DLMM pool' },
  {
    program: JUPITER_LOCK_PROGRAM,
    account: 'VestingEscrow',
    kind: 'lock',
    name: 'Jupiter Lock escrow',
  },
];

const ownedRoles = new Map(
  OWNED_ROLES.map((r) => [`${r.program}:${hex(anchorDiscriminator(r.account))}`, r]),
);

/**
 * Venues whose vaults are owned by one authority address shared by all their
 * pools, derived from the program's own seed. Each was checked on a real
 * pool: the pool account holds the vault's address, and the vault's owner is
 * the derived authority (24/11/2026):
 *  - Raydium AMM v4, seed "amm authority" → 5Q544fKr…: pool G7mw1d83… (BONK)
 *    holds vault B4kvik9y… at byte 336; AVs9TA4n… (RAY) holds Em6rHi68…;
 *  - Raydium CPMM, "vault_and_lp_mint_auth_seed" → GpMZbSM2…: pool 5hinZuqb…
 *    (BONK) holds vault A3xbHH2X… at byte 104;
 *  - Raydium LaunchLab, "vault_auth_seed" → WLHv2UAZ…: pool E4C8zuDz… holds
 *    vault 3YEHEbG2… of 8tLjXE3M…oat at byte 269;
 *  - Meteora DAMM v2, "pool_authority" → HLnpSz9h…: pool EyQ8psey… holds
 *    vault HYahpco3… at byte 264;
 *  - Meteora Dynamic Bonding Curve, "pool_authority" → FhVo3mqL…: pool
 *    DbdgjtiiR… holds vault FDygJSer… at byte 168.
 * The chain is the source here: each seed is kept because the address it
 * gives is the owner of a real pool's vault, not because a document says so.
 */
const AUTHORITIES: readonly {
  program: string;
  seed: string;
  kind: 'curve' | 'pool';
  name: string;
}[] = [
  {
    program: RAYDIUM_AMM_V4_PROGRAM,
    seed: 'amm authority',
    kind: 'pool',
    name: 'Raydium AMM v4 pool',
  },
  {
    program: RAYDIUM_CPMM_PROGRAM,
    seed: 'vault_and_lp_mint_auth_seed',
    kind: 'pool',
    name: 'Raydium CPMM pool',
  },
  {
    program: RAYDIUM_LAUNCHLAB_PROGRAM,
    seed: 'vault_auth_seed',
    kind: 'curve',
    name: 'Raydium LaunchLab bonding curve',
  },
  {
    program: METEORA_DAMM_V2_PROGRAM,
    seed: 'pool_authority',
    kind: 'pool',
    name: 'Meteora DAMM v2 pool',
  },
  {
    program: METEORA_DBC_PROGRAM,
    seed: 'pool_authority',
    kind: 'curve',
    name: 'Meteora Dynamic Bonding Curve',
  },
];

let authorityCache: Map<string, (typeof AUTHORITIES)[number]> | undefined;

/** Authority address → venue. Derived once: each is a find_program_address. */
export function poolAuthorities(): ReadonlyMap<string, (typeof AUTHORITIES)[number]> {
  authorityCache ??= new Map(
    AUTHORITIES.map((a) => [findProgramAddress([a.seed], a.program).address, a]),
  );
  return authorityCache;
}

/**
 * Streamflow escrows. The tokens of a Streamflow contract sit in a token
 * account whose owner is itself; the contract (an account of the Streamflow
 * program, 1104 bytes) holds that escrow's address at byte 209 and the mint at
 * byte 177. Read on three contracts on 24/11/2026 (FRMRAHUo…, 7Q1hrYjs…,
 * BQkid3yN…, escrows hvJRymHF…, EhPi3FpP…, BezucJzr…). The derivation
 * ["strm", contract] matched only one of the three, so it is not relied on:
 * the contract is found by its content.
 */
export const STREAMFLOW_ESCROW_OFFSET = 209;
export const STREAMFLOW_MINT_OFFSET = 177;

/** What is known of an owner's own account: `null` when no account lives there. */
export type OwnerAccount = {
  /** The program that owns the account. */
  owner: string;
  /** Its first bytes, at least 64 when the account is that long (`dataSlice` 0..64). */
  head: Uint8Array;
} | null;

/** An owner whose own account is a token account of which it is the owner (Streamflow's escrows). */
export function isSelfOwnedTokenAccount(address: string, account: OwnerAccount): boolean {
  if (!account || !isTokenProgram(account.owner) || account.head.length < 64) return false;
  return encodeBase58(account.head.subarray(32, 64)) === address;
}

const WALLET: OwnerRole = {
  kind: 'wallet',
  name: 'wallet',
  evidence: 'on the ed25519 curve: a key can sign for it',
};

/** The incinerator and the curve test need no account: said without reading anything. */
export function roleWithoutAccount(address: string): OwnerRole | undefined {
  if (address === INCINERATOR) {
    return {
      kind: 'burn',
      name: 'incinerator',
      evidence: 'the incinerator address: what it holds cannot be moved again',
    };
  }
  if (isOnCurve(address)) return WALLET;
  const authority = poolAuthorities().get(address);
  if (authority) {
    return {
      kind: authority.kind,
      name: authority.name,
      program: authority.program,
      evidence: `authority of the venue's vaults, derived from seed "${authority.seed}" under ${authority.program}`,
    };
  }
  return undefined;
}

/**
 * The role of an off-curve owner from its own account. `streamflowMint` is
 * the mint the Streamflow contract holding this escrow names, when one was
 * found (`findStreamflowContract`); undefined when not looked up.
 */
export function roleFromAccount(
  address: string,
  mint: string,
  account: OwnerAccount,
  streamflowMint?: string | null,
): OwnerRole {
  const known = roleWithoutAccount(address);
  if (known) return known;
  if (!account) {
    return {
      kind: 'program-account',
      name: 'program account',
      evidence: 'off the ed25519 curve, and no account lives at the address',
    };
  }
  const programName = knownProgram(account.owner)?.name;
  const disc = account.head.length >= 8 ? hex(account.head.subarray(0, 8)) : '';
  const owned = ownedRoles.get(`${account.owner}:${disc}`);
  if (owned) {
    // A pump.fun curve holds the tokens of its own mint only.
    if (owned.program !== PUMP_FUN_PROGRAM || address === pumpBondingCurveAddress(mint)) {
      return {
        kind: owned.kind,
        name: owned.name,
        program: owned.program,
        evidence: `account owned by ${programName ?? owned.program}, of type ${owned.account}`,
      };
    }
  }
  if (streamflowMint === mint && isSelfOwnedTokenAccount(address, account)) {
    return {
      kind: 'lock',
      name: 'Streamflow escrow',
      program: STREAMFLOW_PROGRAM,
      evidence: `escrow of a Streamflow contract naming this mint (byte ${STREAMFLOW_MINT_OFFSET})`,
    };
  }
  return {
    kind: 'program-account',
    // A PDA the System Program owns (it only holds SOL) says nothing more than "program account".
    name:
      programName && knownProgram(account.owner)?.kind !== 'core'
        ? `${programName} program account`
        : 'program account',
    program: account.owner,
    evidence: `off the ed25519 curve, account owned by ${programName ?? account.owner}; no known role`,
  };
}
