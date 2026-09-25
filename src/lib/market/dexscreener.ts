/**
 * Types de la réponse DexScreener, tels qu'observés en direct.
 * Tout est optionnel : l'API omet les champs plutôt que de renvoyer null,
 * et un token fraîchement lancé n'a ni volume ni prix.
 */
export type DexScreenerPair = {
  chainId?: string;
  dexId?: string;
  labels?: string[];
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
};

/** Slug de chaîne DexScreener pour Robinhood Chain. Vérifié : ni `robinhoodchain`, ni `4663`. */
export const ROBINHOOD_SLUG = 'robinhood';

export const DEXSCREENER_BASE = 'https://api.dexscreener.com';

export function tokenPairsUrl(token: string, base = DEXSCREENER_BASE): string {
  return `${base}/token-pairs/v1/${ROBINHOOD_SLUG}/${token}`;
}
