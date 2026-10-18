/**
 * What the code at an address says about it.
 *
 * Since EIP-7702, a wallet can delegate to a contract: its code then reads
 * `0xef0100` followed by the delegate's address. It is still a person's
 * wallet, with a key and a transaction count, so it is never taken for a
 * contract. Every place that tells wallets from contracts by their code goes
 * through this one helper.
 */

/** The prefix of an EIP-7702 delegation designator. */
export const DELEGATION_PREFIX = '0xef0100';

/** True when the code is an EIP-7702 delegation: a wallet, whatever it delegates to. */
export function isDelegatedWallet(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.toLowerCase().startsWith(DELEGATION_PREFIX);
}

/** Code at an address, read as a contract. A wallet delegating under EIP-7702 stays a wallet. */
export function isContractCode(code: string | null | undefined): boolean {
  if (!code || code === '0x') return false;
  return !isDelegatedWallet(code);
}
