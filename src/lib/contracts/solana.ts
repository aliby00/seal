/**
 * Facts read on Solana. The EVM blocks (creator, holders, market) keep their
 * shapes; what only Solana has starts here.
 */

/** The chain a report reads: Solana only since the Robinhood Chain reads were retired. */
export type Chain = 'solana';

/** The sources a Solana read cites (`SourceRef.name`). */
export type SolanaSourceName = 'solana-rpc' | 'dexscreener-solana';

/** Which token program owns the mint: the original SPL Token, or Token-2022. */
export type SolanaTokenProgram = 'spl-token' | 'token-2022';

/**
 * Token-2022 extensions seen on mainnet mints, by the name the node's
 * jsonParsed encoding gives them (read 24/11/2026: PYUSD carries the first
 * eight, a pump.fun mint the last two). Another name can appear: it is kept
 * as the node wrote it, never dropped.
 */
export const OBSERVED_MINT_EXTENSIONS = [
  'mintCloseAuthority',
  'permanentDelegate',
  'transferFeeConfig',
  'confidentialTransferMint',
  'confidentialTransferFeeConfig',
  'transferHook',
  'metadataPointer',
  'tokenMetadata',
] as const;

/** One extension of a Token-2022 mint, its state as the node parsed it. */
export type MintExtension = {
  extension: string;
  /**
   * Beware: the node writes u64 fields as JSON numbers, and those above 2^53
   * lose precision once parsed (BERN's `maximumFee`, 3906250000000000000).
   */
  state: Record<string, unknown>;
};

/** What a mint account says, read with `getAccountInfo` (jsonParsed). */
export type SolanaMint = {
  mint: string;
  program: SolanaTokenProgram;
  decimals: number;
  /** Raw units, as a decimal string. */
  supply: string;
  /** Who can still create tokens; `null` when nobody can. */
  mintAuthority: string | null;
  /** Who can freeze any holder's tokens; `null` when nobody can. */
  freezeAuthority: string | null;
  /** Empty for an SPL Token mint. */
  extensions: MintExtension[];
};
