import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { base58 } from '@scure/base';

/**
 * Solana addresses: 32 bytes written in base58 (Bitcoin alphabet).
 *
 * Unlike EVM addresses, they are case-sensitive: an address must never be
 * lower-cased, and two addresses are equal only when their strings are.
 *
 * The derivation rules below follow the reference implementation
 * (solana-address crate, checked 24/11/2026):
 * https://docs.rs/solana-address/latest/src/solana_address/lib.rs.html
 * https://docs.rs/solana-address/latest/src/solana_address/syscalls.rs.html
 */

export const ADDRESS_BYTES = 32;
/** `MAX_SEEDS` in solana-address: seeds per derivation, the bump included. */
export const MAX_SEEDS = 16;
/** `MAX_SEED_LEN` in solana-address: bytes per seed. */
export const MAX_SEED_LEN = 32;
/** `PDA_MARKER` in solana-address. */
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

/** Bytes of a base58 string; throws on a character outside the alphabet. */
export function decodeBase58(value: string): Uint8Array {
  return base58.decode(value);
}

export function encodeBase58(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

/** A base58 string of exactly 32 bytes. Says nothing of whether an account exists. */
export function isSolanaAddress(value: unknown): value is string {
  // 32 bytes take 32 to 44 base58 characters (the system program is 32 "1").
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try {
    return decodeBase58(value).length === ADDRESS_BYTES;
  } catch {
    return false;
  }
}

/** `So11…1112`: the first and last four characters, as the explorers show them. */
export function shortAddress(address: string, keep = 4): string {
  if (address.length <= keep * 2 + 1) return address;
  return `${address.slice(0, keep)}…${address.slice(-keep)}`;
}

/** The 32 bytes of an address; throws when it is not one. */
export function addressBytes(address: string): Uint8Array {
  const bytes = decodeBase58(address);
  if (bytes.length !== ADDRESS_BYTES) {
    throw new Error(`not a Solana address: ${address.length} characters, ${bytes.length} bytes`);
  }
  return bytes;
}

type FromHex = (bytes: Uint8Array, zip215?: boolean) => unknown;

/**
 * Whether 32 bytes are a point of the ed25519 curve: a key a wallet can sign
 * for. Program-derived addresses are, by construction, off the curve.
 *
 * Solana asks curve25519-dalek's `CompressedEdwardsY::decompress`, which
 * accepts a non-canonical y (y ≥ p) and x = 0 with the sign bit set. noble's
 * `fromHex` matches that with `zip215 = true`; the default (RFC 8032) would
 * reject those encodings and call a few points off the curve that Solana
 * calls on it.
 */
export function isOnCurve(address: string | Uint8Array): boolean {
  const bytes = typeof address === 'string' ? decodeBase58(address) : address;
  if (bytes.length !== ADDRESS_BYTES) return false;
  try {
    (ed25519.ExtendedPoint.fromHex as FromHex)(bytes, true);
    return true;
  } catch {
    return false;
  }
}

export type Seed = Uint8Array | string;

/** A string seed is its UTF-8 bytes ("bonding-curve"); pass an address's bytes with `addressBytes`. */
function seedBytes(seed: Seed): Uint8Array {
  return typeof seed === 'string' ? new TextEncoder().encode(seed) : seed;
}

/**
 * `create_program_address`: sha256(seeds… ‖ program id ‖ "ProgramDerivedAddress"),
 * refused when the hash lands on the curve. `null` in that case.
 */
export function createProgramAddress(seeds: readonly Seed[], programId: string): string | null {
  if (seeds.length > MAX_SEEDS) throw new Error(`at most ${MAX_SEEDS} seeds`);
  const parts = seeds.map(seedBytes);
  for (const part of parts) {
    if (part.length > MAX_SEED_LEN) throw new Error(`a seed is at most ${MAX_SEED_LEN} bytes`);
  }
  const hasher = sha256.create();
  for (const part of parts) hasher.update(part);
  hasher.update(addressBytes(programId));
  hasher.update(PDA_MARKER);
  const hash = hasher.digest();
  return isOnCurve(hash) ? null : encodeBase58(hash);
}

/**
 * `find_program_address`: the bump is tried from 255 down, appended as the
 * last seed, and the first address off the curve is the one programs use.
 */
export function findProgramAddress(
  seeds: readonly Seed[],
  programId: string,
): { address: string; bump: number } {
  if (seeds.length > MAX_SEEDS - 1)
    throw new Error(`at most ${MAX_SEEDS - 1} seeds besides the bump`);
  for (let bump = 255; bump >= 0; bump -= 1) {
    const address = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (address) return { address, bump };
  }
  throw new Error('no viable bump seed');
}
