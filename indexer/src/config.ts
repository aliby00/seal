/**
 * Configuration de l'indexeur, lue une fois au démarrage.
 *
 * Un env invalide fait échouer le boot : mieux vaut un conteneur qui redémarre
 * en boucle avec un message clair qu'un service qui répond sans authentification.
 */
export const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/** ~0,1 s par bloc, mesuré le 17/10/2026 (9,7 à 9,9 blocs/s sur 30 jours). */
export const BLOCKS_PER_DAY = 864_000;

export type Config = {
  rpcUrl: string;
  /** Requêtes `eth_getLogs` par seconde, en régime continu. */
  rpcRate: number;
  blockscoutApiKey: string | undefined;
  token: string;
  port: number;
  dbPath: string;
  backfillDays: number;
  /** Pause entre deux lectures de la tête de chaîne. */
  pollMs: number;
};

function positive(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const token = env.INDEXER_TOKEN?.trim();
  // Un jeton court se devine : 24 caractères au moins.
  if (!token || token.length < 24) {
    throw new Error('INDEXER_TOKEN is required (at least 24 characters)');
  }
  return {
    rpcUrl: env.RPC_URL?.trim() || DEFAULT_RPC_URL,
    rpcRate: positive('RPC_RATE', env.RPC_RATE, 4),
    blockscoutApiKey: env.BLOCKSCOUT_API_KEY?.trim() || undefined,
    token,
    port: positive('PORT', env.PORT, 8795),
    dbPath: env.DB_PATH?.trim() || '/data/seal-indexer.db',
    backfillDays: positive('BACKFILL_DAYS', env.BACKFILL_DAYS, 30),
    pollMs: positive('POLL_MS', env.POLL_MS, 5_000),
  };
}
