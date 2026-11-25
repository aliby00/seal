/**
 * Types de la réponse DexScreener, tels qu'observés en direct.
 * Tout est optionnel : l'API omet les champs plutôt que de renvoyer null,
 * et un token fraîchement lancé n'a ni volume ni prix.
 */

import { isSolanaAddress } from '../solana/address';

export type DexScreenerPair = {
  chainId?: string;
  dexId?: string;
  labels?: string[];
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
};

export const DEXSCREENER_BASE = 'https://api.dexscreener.com';

/**
 * DexScreener's chain id for Solana. "Get the pools of a given token
 * address": GET /token-pairs/v1/{chainId}/{tokenAddress}, 300 requests a
 * minute (https://docs.dexscreener.com/api/reference). Answered on
 * 24/11/2026 for pump.fun, Meteora DBC, Raydium and Orca tokens.
 */
export const SOLANA_SLUG = 'solana';

/**
 * A path segment for DexScreener: each address is checked as a Solana address
 * (base58, 32 bytes) and percent-encoded, so nothing from a request can change
 * the host or the path. Case is kept: Solana addresses are case-sensitive.
 */
export function addressSegment(addresses: readonly string[]): string {
  for (const address of addresses) {
    if (!isSolanaAddress(address)) throw new Error('not a Solana address');
  }
  return addresses.map((address) => encodeURIComponent(address)).join(',');
}

export function solanaTokenPairsUrl(mint: string, base = DEXSCREENER_BASE): string {
  return `${base}/token-pairs/v1/${SOLANA_SLUG}/${addressSegment([mint])}`;
}

/** One or more pairs by their address: GET /latest/dex/pairs/{chainId}/{pairAddresses}. */
export function solanaPairsUrl(pairs: readonly string[], base = DEXSCREENER_BASE): string {
  return `${base}/latest/dex/pairs/${SOLANA_SLUG}/${addressSegment(pairs)}`;
}
