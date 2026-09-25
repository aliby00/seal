import type { Address } from 'viem';
import type { CreatorHistory, LaunchedToken, TokenOutcome } from '../contracts';
import type { RequestBudget } from '../http';
import { discoverActiveFactories, decodeTokenLaunched, TOKEN_LAUNCHED_TOPIC } from './factory';
import { getLogsChunked } from './logs';
import { fetchGraduationStatus, type GraduationStatus } from './graduation';
import { createRpcClient, DEFAULT_RPC_URL, type RpcClient } from './rpc';

export * from './rpc';
export * from './logs';
export * from './factory';
export * from './graduation';

/** Sans activité depuis ~30 jours et sous le seuil : on parle d'abandon. */
export const ABANDON_AFTER_BLOCKS = 26_000_000;

export function classifyOutcome(
  status: GraduationStatus | null,
  blocksSinceLaunch: number,
): TokenOutcome {
  if (status?.graduated) return 'graduated';
  if (blocksSinceLaunch > ABANDON_AFTER_BLOCKS) return 'abandoned';
  return 'active';
}

/** `deployer` est le topic2 : une adresse est padée à 32 octets pour servir de filtre. */
export function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

export type FetchCreatorHistoryOptions = {
  rpcUrl?: string;
  budget?: RequestBudget;
  client?: RpcClient;
  /** Fenêtre scannée par le MVP. L'historique complet est le sujet de feat/creator-history. */
  lookbackBlocks?: number;
  now?: () => Date;
};

export async function fetchCreatorHistory(
  creator: Address,
  options: FetchCreatorHistoryOptions = {},
): Promise<CreatorHistory> {
  const rpc = options.client ?? createRpcClient(options.rpcUrl ?? DEFAULT_RPC_URL, options.budget);
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const lookback = options.lookbackBlocks ?? 5_000_000;

  const latestHex = await rpc.call<string>('eth_blockNumber', []);
  const latest = Number(latestHex);

  // L'adresse du factory se découvre, elle ne se copie pas d'une documentation.
  // La découverte confirme que le launchpad est bien actif sur la fenêtre observée.
  await discoverActiveFactories(rpc, latest, lookback);

  const { logs, truncated, scanned } = await getLogsChunked(
    rpc,
    { topics: [TOKEN_LAUNCHED_TOPIC, null, addressTopic(creator)] },
    { fromBlock: Math.max(0, latest - lookback), toBlock: latest },
  );

  const launches = logs.map(decodeTokenLaunched);
  const tokens: LaunchedToken[] = [];

  for (const launch of launches) {
    // Le factory qui a émis le log est forcément celui qui connaît ce token :
    // interroger un autre reverterait, comme le fait celui de la documentation.
    const status = await fetchGraduationStatus(rpc, launch.factory, launch.token);
    tokens.push({
      address: launch.token,
      pool: launch.pool,
      launchedAtBlock: launch.blockNumber,
      launchedAt: null,
      outcome: classifyOutcome(status, latest - launch.blockNumber),
      graduationProgress: status?.progress ?? 0,
      // Indéterminables sans analyse des transferts : `feat/creator-history`.
      liquidityPulled: null,
      creatorDumped: null,
    });
  }

  const counts = {
    launched: tokens.length,
    graduated: tokens.filter((t) => t.outcome === 'graduated').length,
    abandoned: tokens.filter((t) => t.outcome === 'abandoned').length,
    liquidityPulled: tokens.filter((t) => t.liquidityPulled === true).length,
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
              note: `fenêtre scannée : blocs ${scanned.fromBlock} à ${scanned.toBlock} — historique antérieur non couvert`,
            }
          : {}),
      },
    ],
    data: { creator, tokens, counts, scannedRange: scanned },
  };
}
