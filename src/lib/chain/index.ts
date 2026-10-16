import type { Address } from 'viem';
import type { CreatorHistory, LaunchedToken, TokenOutcome } from '../contracts';
import type { RequestBudget } from '../http';
import {
  decodeGetLaunchedToken,
  decodeTokenLaunched,
  encodeGetLaunchedToken,
  LIQUIDITY_POOL_SELECTOR,
  PONS_FACTORIES,
  wordToAddress,
  type FactoryRange,
  TOKEN_LAUNCHED_TOPIC,
  type TokenLaunch,
} from './factory';
import { getLogsBatched, type LogSource } from './logs';
import { fetchBlockTimestamps, fetchGraduationStatusOf, type GraduationStatus } from './graduation';
import { detectCreatorSales, detectLiquidityRemovals } from './behavior';
import { createRpcClient, DEFAULT_RPC_URL, type RpcClient } from './rpc';

export * from './rpc';
export * from './logs';
export * from './factory';
export * from './graduation';
export * from './behavior';
export * from './deployer';
export * from './launch';

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

/** Launches read in detail (graduation, launch date) for one creator. */
export const MAX_DETAILED_LAUNCHES = 40;

/** Launches whose sales and liquidity removals are checked. */
export const MAX_BEHAVIOR_TOKENS = 10;

/**
 * Sales and liquidity removals are looked for in the first 10 M blocks after
 * a launch: about 11.5 days at 0.101 s per block, one query per token.
 */
export const BEHAVIOR_WINDOW_BLOCKS = 10_000_000;

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
  // Graduation could not be read (a revert, or a factory with another layout):
  // calling an old token "abandoned" would state something nobody observed.
  if (!status && blocksSinceLaunch > ABANDON_AFTER_BLOCKS) return 'undetermined';
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
 * l'adresse du token, pas celle de son créateur.
 *
 * First, the cheap way: the pons factories answer `getLaunchedToken(token)`,
 * so one batch of `eth_call` settles it for them — `eth_getLogs` is what the
 * public node rate-limits (a burst of ~20, then ~4 per second). Only the
 * factories that do not expose that getter are searched through their logs.
 */
export async function findLaunchOf(
  rpc: RpcClient,
  token: Address,
  latestBlock: number,
  lookbackBlocks = latestBlock,
  factories: readonly FactoryRange[] = PONS_FACTORIES,
): Promise<TokenLaunch | undefined> {
  const readable = factories.filter((f) => f.getter);
  if (readable.length > 0) {
    const outcomes = await rpc.callBatch<string>([
      ...readable.map((f) => ({
        method: 'eth_call',
        params: [{ to: f.address, data: encodeGetLaunchedToken(token) }, 'latest'],
      })),
      { method: 'eth_call', params: [{ to: token, data: LIQUIDITY_POOL_SELECTOR }, 'latest'] },
    ]);
    const pool = outcomes[readable.length];
    for (const [i, factory] of readable.entries()) {
      const outcome = outcomes[i];
      const launched = outcome?.ok ? decodeGetLaunchedToken(outcome.value) : null;
      if (launched?.exists) {
        return {
          token,
          deployer: launched.deployer,
          dexFactory: '0x' as Address,
          pairToken: launched.pairedToken,
          pool: pool?.ok ? (wordToAddress(pool.value) ?? ('0x' as Address)) : ('0x' as Address),
          initialBuyAmount: launched.initialBuyAmount,
          // Not given by the getter; the creator history carries the real block.
          blockNumber: 0,
          factory: factory.address,
          transactionHash: '',
        };
      }
    }
  }

  const others = factories.filter((f) => !f.getter);
  if (others.length === 0) return undefined;
  const { logs } = await getLogsBatched(
    rpc,
    { addresses: others, topics: [TOKEN_LAUNCHED_TOPIC, addressTopic(token)] },
    { fromBlock: Math.max(0, latestBlock - lookbackBlocks), toBlock: latestBlock },
  );
  const first = logs[0];
  return first ? decodeTokenLaunched(first) : undefined;
}

export type FetchCreatorHistoryOptions = {
  rpcUrl?: string;
  budget?: RequestBudget;
  client?: RpcClient;
  /** The token being analysed: its sales and liquidity are always checked. */
  focus?: Address;
  /** Factories to read launches from. Defaults to the known pons generations. */
  factories?: readonly LogSource[];
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
  const latestHex = await rpc.call<string>('eth_blockNumber', []);
  const latest = Number(latestHex);
  // Reading the whole chain now costs one batch, so it is the default: an
  // older launch is no longer invisible because it fell outside a window.
  const lookback = options.lookbackBlocks ?? latest;

  // L'adresse du factory se découvre, elle ne se copie pas d'une documentation.
  // Note : `discoverActiveFactories` n'est pas appelée ici. Le factory qui a
  // émis chaque log est porté par le log lui-même, et c'est forcément celui
  // qui connaît le token. La découverte reste exportée pour l'énumération des
  // générations de factory (#13) — l'appeler ici coûtait un eth_getLogs
  // chunké sur toute la fenêtre pour un résultat qu'on jetait.

  // One query per (factory, 10 M-block window), batched. A topic-only filter
  // is capped at 30,000 blocks per query: 1,000 queries for 30 M blocks, which
  // the request budget cut short every time.
  const scanned = { fromBlock: Math.max(0, latest - lookback), toBlock: latest };
  const { logs, truncated } = await getLogsBatched(
    rpc,
    {
      addresses: options.factories ?? PONS_FACTORIES,
      topics: [TOKEN_LAUNCHED_TOPIC, null, addressTopic(creator)],
    },
    scanned,
  );

  const all = logs.map(decodeTokenLaunched);
  // A serial launcher can have hundreds of tokens. The most recent ones are
  // read in detail; the rest would only spend the request budget, so the
  // history says it was capped instead of pretending to be complete.
  const launches = all.slice(-MAX_DETAILED_LAUNCHES);
  const capped = all.length > launches.length;

  // Un seul aller-retour par lot de 20, au lieu d'un par token.
  const [statuses, timestamps] = await Promise.all([
    fetchGraduationStatusOf(rpc, launches),
    fetchBlockTimestamps(
      rpc,
      launches.map((l) => l.blockNumber),
    ),
  ]);

  // Sales and liquidity are read for the most recent launches (and always for
  // the token being analysed), each over its first BEHAVIOR_WINDOW_BLOCKS: one
  // query per token and per signal. Reading every launch over its whole life
  // cost 400 queries for a creator with 76 tokens — 100 s on the public node.
  const watched = launches
    .filter(
      (l, i) =>
        i >= launches.length - MAX_BEHAVIOR_TOKENS ||
        l.token.toLowerCase() === options.focus?.toLowerCase(),
    )
    .map((l) => ({
      token: l.token,
      pool: l.pool,
      fromBlock: l.blockNumber,
      toBlock: Math.min(latest, l.blockNumber + BEHAVIOR_WINDOW_BLOCKS - 1),
    }));
  const window = { fromBlock: scanned.fromBlock, toBlock: scanned.toBlock };
  // Un échec ici donne une Map vide, donc `null` par token plus bas : on ne
  // prétend pas avoir observé une absence de vente alors qu'on n'a pas regardé.
  const [sold, pulled] = await Promise.all([
    detectCreatorSales(rpc, creator, watched, window).catch(() => new Map<string, boolean>()),
    detectLiquidityRemovals(rpc, watched, window).catch(() => new Map<string, boolean>()),
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
    launched: all.length,
    graduated: tokens.filter((t) => t.outcome === 'graduated').length,
    abandoned: tokens.filter((t) => t.outcome === 'abandoned').length,
    undetermined: tokens.filter((t) => t.outcome === 'undetermined').length,
    liquidityPulled: tokens.filter((t) => t.liquidityPulled === true).length,
    creatorDumped: tokens.filter((t) => t.creatorDumped === true).length,
  };

  // `truncated` couvre désormais aussi l'arrêt sur rate limit : la fenêtre
  // réellement couverte est dans scannedRange, et elle peut être bien plus
  // courte que demandée.
  const partial = truncated || capped || scanned.fromBlock > 0;

  return {
    completeness: partial ? 'partial' : 'full',
    sources: [
      {
        name: 'robinhood-rpc',
        fetchedAt,
        ...(partial
          ? {
              note: capped
                ? `${launches.length} most recent of ${all.length} launches read in detail`
                : truncated
                  ? 'some launch windows could not be read — history may be incomplete'
                  : `scanned range: blocks ${scanned.fromBlock} to ${scanned.toBlock} — earlier history not covered`,
            }
          : {}),
      },
    ],
    data: { creator, tokens, counts, scannedRange: scanned },
  };
}
