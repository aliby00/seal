import type { Address } from 'viem';
import type { CreatorHistory, LaunchedToken, TokenOutcome } from '../contracts';
import type { RequestBudget } from '../http';
import { decodeTokenLaunched, TOKEN_LAUNCHED_TOPIC, type TokenLaunch } from './factory';
import { getLogsChunked } from './logs';
import {
  fetchBlockTimestamps,
  fetchGraduationStatusBatch,
  type GraduationStatus,
} from './graduation';
import { detectCreatorSales, detectLiquidityRemovals } from './behavior';
import { createRpcClient, DEFAULT_RPC_URL, type RpcClient } from './rpc';

export * from './rpc';
export * from './logs';
export * from './factory';
export * from './graduation';
export * from './behavior';

/** Sans activité depuis ~30 jours et sous le seuil : on parle d'abandon. */
export const ABANDON_AFTER_BLOCKS = 26_000_000;

/**
 * Profondeur scannée par défaut : un peu plus que le seuil d'abandon, pour que
 * la classification puisse réellement trancher. À 0,101 s par bloc, c'est
 * environ 35 jours.
 *
 * C'était impossible avant le batch JSON-RPC : lire l'état de graduation de
 * chaque token coûtait un aller-retour, et le RPC public coupe à 403 bien
 * avant. Un appel groupé par lot de 20 change l'ordre de grandeur.
 */
export const DEFAULT_LOOKBACK_BLOCKS = 30_000_000;

/**
 * Détermine le sort d'un token.
 *
 * `observedBlocks` est la profondeur réellement scannée. Si elle est plus
 * courte que le seuil d'abandon, aucun token trouvé ne peut être assez vieux
 * pour être qualifié d'abandonné — et répondre « actif » serait affirmer
 * quelque chose qu'on n'a pas observé. On répond alors `undetermined`.
 *
 * C'était un bug réel : avec une fenêtre de 5 M blocs (5,8 jours) et un seuil
 * à 26 M (30 jours), la branche `abandoned` était mathématiquement morte et
 * tout ressortait « actif ».
 */
export function classifyOutcome(
  status: GraduationStatus | null,
  blocksSinceLaunch: number,
  observedBlocks = Number.POSITIVE_INFINITY,
): TokenOutcome {
  if (status?.graduated) return 'graduated';
  if (blocksSinceLaunch > ABANDON_AFTER_BLOCKS) return 'abandoned';
  if (observedBlocks < ABANDON_AFTER_BLOCKS) return 'undetermined';
  return 'active';
}

/** `deployer` est le topic2 : une adresse est padée à 32 octets pour servir de filtre. */
export function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/**
 * Retrouve le lancement d'un token donné.
 *
 * C'est le point d'entrée réel du pipeline : on ne connaît au départ que
 * l'adresse du token, pas celle de son créateur. Elle se lit dans le
 * `TokenLaunched` de ce token — topic1 est le token, topic2 le deployer.
 */
export async function findLaunchOf(
  rpc: RpcClient,
  token: Address,
  latestBlock: number,
  lookbackBlocks = 5_000_000,
): Promise<TokenLaunch | undefined> {
  const { logs } = await getLogsChunked(
    rpc,
    { topics: [TOKEN_LAUNCHED_TOPIC, addressTopic(token)] },
    { fromBlock: Math.max(0, latestBlock - lookbackBlocks), toBlock: latestBlock, maxLogs: 1 },
  );
  const first = logs[0];
  return first ? decodeTokenLaunched(first) : undefined;
}

export type FetchCreatorHistoryOptions = {
  rpcUrl?: string;
  budget?: RequestBudget;
  client?: RpcClient;
  /**
   * Profondeur scannée. Le défaut couvre le seuil d'abandon (30 jours), ce qui
   * rend la classification `abandoned` réellement atteignable — avec 5 M blocs
   * elle était mathématiquement morte.
   */
  lookbackBlocks?: number;
  now?: () => Date;
};

export async function fetchCreatorHistory(
  creator: Address,
  options: FetchCreatorHistoryOptions = {},
): Promise<CreatorHistory> {
  const rpc = options.client ?? createRpcClient(options.rpcUrl ?? DEFAULT_RPC_URL, options.budget);
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const lookback = options.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;

  const latestHex = await rpc.call<string>('eth_blockNumber', []);
  const latest = Number(latestHex);

  // L'adresse du factory se découvre, elle ne se copie pas d'une documentation.
  // Note : `discoverActiveFactories` n'est pas appelée ici. Le factory qui a
  // émis chaque log est porté par le log lui-même, et c'est forcément celui
  // qui connaît le token. La découverte reste exportée pour l'énumération des
  // générations de factory (#13) — l'appeler ici coûtait un eth_getLogs
  // chunké sur toute la fenêtre pour un résultat qu'on jetait.

  const { logs, truncated, scanned } = await getLogsChunked(
    rpc,
    { topics: [TOKEN_LAUNCHED_TOPIC, null, addressTopic(creator)] },
    { fromBlock: Math.max(0, latest - lookback), toBlock: latest },
  );

  const launches = logs.map(decodeTokenLaunched);

  // Un seul aller-retour par lot de 20, au lieu d'un par token.
  const factory = launches[0]?.factory;
  const [statuses, timestamps] = await Promise.all([
    factory
      ? fetchGraduationStatusBatch(
          rpc,
          factory,
          launches.map((l) => l.token),
        )
      : Promise.resolve<(GraduationStatus | null)[]>([]),
    fetchBlockTimestamps(
      rpc,
      launches.map((l) => l.blockNumber),
    ),
  ]);

  // Deux requêtes pour tous les tokens à la fois, pas deux par token :
  // eth_getLogs accepte une liste d'adresses.
  const pairs = launches.map((l) => ({ token: l.token, pool: l.pool }));
  // Rien ne peut arriver à un token avant son lancement : la fenêtre part du
  // plus ancien lancement observé, pas du début de la plage scannée. Sur un
  // créateur récent, ça divise le coût par plus de dix.
  const earliestLaunch = launches.reduce(
    (min, l) => Math.min(min, l.blockNumber),
    Number.POSITIVE_INFINITY,
  );
  const window = {
    fromBlock: Number.isFinite(earliestLaunch) ? earliestLaunch : scanned.fromBlock,
    toBlock: scanned.toBlock,
  };
  const [sold, pulled] = await Promise.all([
    detectCreatorSales(rpc, creator, pairs, window).catch(() => new Map<string, boolean>()),
    detectLiquidityRemovals(rpc, pairs, window).catch(() => new Map<string, boolean>()),
  ]);

  const tokens: LaunchedToken[] = launches.map((launch, i) => {
    const status = statuses[i] ?? null;
    const key = launch.token.toLowerCase();
    return {
      address: launch.token,
      pool: launch.pool,
      launchedAtBlock: launch.blockNumber,
      launchedAt: timestamps[i] ?? null,
      outcome: classifyOutcome(status, latest - launch.blockNumber, lookback),
      graduationProgress: status?.progress ?? 0,
      // `false` signifie « rien observé sur la fenêtre », pas « certainement
      // pas arrivé ». La complétude du bloc porte déjà cette nuance.
      liquidityPulled: pulled.get(key) ?? null,
      creatorDumped: sold.get(key) ?? null,
    };
  });

  const counts = {
    launched: tokens.length,
    graduated: tokens.filter((t) => t.outcome === 'graduated').length,
    abandoned: tokens.filter((t) => t.outcome === 'abandoned').length,
    undetermined: tokens.filter((t) => t.outcome === 'undetermined').length,
    liquidityPulled: tokens.filter((t) => t.liquidityPulled === true).length,
    creatorDumped: tokens.filter((t) => t.creatorDumped === true).length,
  };

  const partial = truncated || scanned.fromBlock > 0;

  return {
    completeness: partial ? 'partial' : 'full',
    sources: [
      {
        name: 'robinhood-rpc',
        fetchedAt,
        ...(partial
          ? {
              note: `scanned range: blocks ${scanned.fromBlock} to ${scanned.toBlock} — earlier history not covered`,
            }
          : {}),
      },
    ],
    data: { creator, tokens, counts, scannedRange: scanned },
  };
}
