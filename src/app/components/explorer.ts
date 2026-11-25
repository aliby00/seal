/**
 * Where an address or a transaction can be checked by anyone: the Solana
 * Explorer, and DexScreener for the token's market. Addresses go into the
 * links exactly as given: base58 is case-sensitive, and a lower-cased
 * address is another address (or none).
 */

export const EXPLORER = 'https://explorer.solana.com';
const DEXSCREENER = 'https://dexscreener.com/solana';

/** An account, a wallet or a mint on the Solana Explorer. */
export function addressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}

/** A transaction, by its signature, on the Solana Explorer. */
export function txUrl(signature: string): string {
  return `${EXPLORER}/tx/${signature}`;
}

/** The token's market on DexScreener: the mint, which DexScreener resolves to its pairs. */
export function marketUrl(token: string): string {
  return `${DEXSCREENER}/${token}`;
}

/**
 * `So11…1112`: the first and last four characters, as the explorers show
 * them, case kept. A string too short to shorten is returned whole.
 */
export function short(address: string, keep = 4): string {
  if (address.length <= keep * 2 + 1) return address;
  return `${address.slice(0, keep)}…${address.slice(-keep)}`;
}
