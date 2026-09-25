/**
 * Accès Blockscout.
 *
 * Deux faits mesurés conditionnent tout ce module :
 *  - l'instance publique `robinhoodchain.blockscout.com` est derrière Cloudflare
 *    et renvoie 403 depuis un serveur ;
 *  - l'API PRO exige une clé même sur le tier gratuit (402 sinon), limité à
 *    5 req/s et 100 000 crédits par jour.
 */
export const BLOCKSCOUT_BASE = 'https://api.blockscout.com';
export const ROBINHOOD_CHAIN_ID = 4663;

export type BlockscoutHolder = {
  address?: { hash?: string; is_contract?: boolean };
  value?: string;
  token?: { decimals?: string; total_supply?: string };
};

export type BlockscoutHoldersPage = {
  items?: BlockscoutHolder[];
  next_page_params?: Record<string, string | number> | null;
};

export function holdersUrl(
  token: string,
  params: Record<string, string | number> = {},
  base = BLOCKSCOUT_BASE,
): string {
  const url = new URL(`${base}/${ROBINHOOD_CHAIN_ID}/api/v2/tokens/${token}/holders`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}
