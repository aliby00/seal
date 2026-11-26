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

/**
 * Token-2022 extensions in plain words: "metadataPointer" and
 * "tokenMetadata" read as code on the mint card (CAT, 26/11/2026). Harmless
 * ones are named for what they hold; the ones that act on holders say so.
 */
const EXTENSION_WORDS: Record<string, string> = {
  metadataPointer: 'Points to its metadata',
  tokenMetadata: 'Name and image stored in the mint',
  transferFeeConfig: 'Transfer fee',
  transferHook: 'Transfer hook (a program runs on every transfer)',
  permanentDelegate: 'Permanent delegate (can move anyone’s tokens)',
  pausableConfig: 'Transfers can be paused',
  defaultAccountState: 'New accounts can start frozen',
  nonTransferable: 'Cannot be transferred',
  mintCloseAuthority: 'Mint can be closed',
  interestBearingConfig: 'Interest-bearing display',
  scaledUiAmountConfig: 'Scaled display amount',
  confidentialTransferMint: 'Confidential transfers',
  confidentialTransferFeeConfig: 'Confidential transfer fees',
  confidentialMintBurn: 'Confidential mint and burn',
  groupPointer: 'Points to a token group',
  groupMemberPointer: 'Points to a group membership',
  tokenGroup: 'Token group',
  tokenGroupMember: 'Member of a token group',
  permissionedBurnConfig: 'Burns need permission',
  unknown: 'An extension SEAL does not decode',
};

export const extensionWords = (name: string) => EXTENSION_WORDS[name] ?? name;
