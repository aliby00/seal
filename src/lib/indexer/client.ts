import type { FunderKind } from '../chain/funder-kind';
import { log } from '../logger';

/**
 * Client de l'indexeur SEAL (`indexer/` à la racine du dépôt).
 *
 * Optionnel par construction : sans `INDEXER_URL` et `INDEXER_TOKEN`, chaque
 * méthode renvoie `undefined` et l'application se comporte exactement comme
 * sans lui. Configuré, il ne lève jamais : un indexeur lent, absent ou en
 * erreur vaut « pas de réponse », journalisé, et l'analyse continue.
 */

export type IndexerWindow = {
  buys: number;
  sells: number;
  uniqueTraders: number;
  /** Volume côté token de paire, en wei. */
  volume: string;
  lastTradeAt: string | null;
};

export type IndexerLaunch = {
  token: string;
  pool: string;
  factory: string;
  /** Launchpad id (launchpads.ts). Absent from indexers that only read pons. */
  launchpad?: string;
  /** The launch transaction. Absent from indexers that only read pons. */
  txHash?: string;
  pairToken: string;
  block: number;
  timestamp: string | null;
};

export type IndexerFunding = {
  funder: string;
  txHash: string;
  block: number;
  kind: 'tx' | 'internal';
  /** Absent from indexers that do not profile funders. */
  funderKind?: FunderKind;
  funderName?: string | null;
  funderTxCount?: number | null;
  /** The sender behind a batch-sending tool. */
  origin?: string | null;
  originKind?: FunderKind | null;
  originTxCount?: number | null;
  /** The address the funding is grouped by. */
  effective?: string | null;
  effectiveKind?: FunderKind;
  effectiveTxCount?: number | null;
  /** Grouped by the effective funder; empty unless it is a wallet. */
  otherCreatorsFunded: string[];
};

export type IndexerPathStep = {
  level: number;
  address: string;
  kind: FunderKind;
  name: string | null;
  txCount: number | null;
  via?: { address: string; name: string | null };
  creatorsFunded: number;
};

export type IndexerNetwork = {
  creator: string;
  indexedTo: number;
  /** Absent when the indexer reads no funding. */
  network?: {
    creators: number;
    capped: boolean;
    launches: number;
    launchpads: Record<string, number>;
    firstLaunchAt: string | null;
    lastLaunchAt: string | null;
    depth: number;
    path: IndexerPathStep[];
    incomplete: boolean;
    reason?: string;
  };
};

export type IndexerCreator = {
  creator: string;
  indexedTo: number;
  launchCount: number;
  truncated: boolean;
  launches: IndexerLaunch[];
  /** Last block read for each launchpad id. Absent from indexers that only read pons. */
  launchpads?: Record<string, number>;
  /** `disabled` : l'indexeur n'a pas de clé Blockscout ; `pending` : pas encore lu. */
  fundingState: 'found' | 'none' | 'pending' | 'disabled';
  /** `null` = lu, aucun versement entrant trouvé. Absent tant que ce n'est pas lu. */
  funding?: IndexerFunding | null;
};

export type IndexerToken = {
  token: string;
  indexedTo: number;
  launch: {
    token: string;
    creator: string;
    pool: string;
    pairToken: string;
    block: number;
    timestamp: string | null;
  };
  /** Premier bloc couvert par la lecture des swaps : rien n'est compté avant. */
  coveredFrom: number | null;
  coveredFromAt: string | null;
  sinceLaunchComplete: boolean;
  stats: { h1: IndexerWindow; h24: IndexerWindow; d7: IndexerWindow; sinceLaunch: IndexerWindow };
  topTraders7d: {
    address: string;
    buys: number;
    sells: number;
    volume: string;
    netToken: string;
    isCreator: boolean;
  }[];
  creatorTraded: { traded: boolean; buys: number; sells: number };
};

export type IndexerFunder = {
  funder: string;
  indexedTo: number;
  /** Absent from indexers that do not profile funders; `null` while not profiled. */
  profile?: {
    kind: FunderKind;
    name: string | null;
    isContract: boolean;
    txCount: number | null;
    checkedAt: string;
  } | null;
  /** Creators grouped under this address (funded by it, or sent by it through a tool). */
  creators: { creator: string; txHash: string; block: number; kind: string }[];
};

export type IndexerMarkets = {
  token: string;
  indexedTo: number;
  markets: {
    id: string;
    currency0: string;
    currency1: string;
    fee: number;
    tickSpacing: number;
    hook: string;
    block: number;
    timestamp: string | null;
    txHash: string;
  }[];
};

/** How far the indexer has read each launchpad's launches, by launchpad id. */
export type IndexerCoverage = { head: number; launchpads: Record<string, number> };

export type IndexerClient = {
  creator(address: string): Promise<IndexerCreator | undefined>;
  /** `undefined` from an indexer that reads pons only, or does not answer. */
  coverage(): Promise<IndexerCoverage | undefined>;
  token(address: string): Promise<IndexerToken | undefined>;
  funder(address: string): Promise<IndexerFunder | undefined>;
  markets(token: string): Promise<IndexerMarkets | undefined>;
  /** Creators linked through the wallets that funded this one. */
  network(creator: string): Promise<IndexerNetwork | undefined>;
};

export const INDEXER_TIMEOUT_MS = 2_000;
/** Une analyse lit le même créateur deux fois (historique, puis financement) : une seule requête. */
const MEMO_MS = 30_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function indexerConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.INDEXER_URL?.trim() && env.INDEXER_TOKEN?.trim());
}

export function createIndexerClient(
  options: {
    url?: string;
    token?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): IndexerClient {
  const url = (options.url ?? process.env.INDEXER_URL)?.trim().replace(/\/+$/, '');
  const token = (options.token ?? process.env.INDEXER_TOKEN)?.trim();
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? INDEXER_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const memo = new Map<string, { at: number; value: Promise<unknown> }>();

  async function read<T>(path: string): Promise<T | undefined> {
    const started = now();
    try {
      const response = await doFetch(`${url}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      // 404: the indexer knows nothing of this address — an answer, not a failure.
      if (response.status === 404) return undefined;
      if (!response.ok) {
        log.warn('indexeur en erreur', { path, status: response.status });
        return undefined;
      }
      return (await response.json()) as T;
    } catch (error) {
      log.warn('indexeur injoignable', {
        path,
        ms: now() - started,
        error: error instanceof Error ? error.name : String(error),
      });
      return undefined;
    }
  }

  function get<T>(kind: string, address: string): Promise<T | undefined> {
    if (!url || !token || !ADDRESS.test(address)) return Promise.resolve(undefined);
    const path = `/v1/${kind}/${address.toLowerCase()}`;
    const hit = memo.get(path);
    if (hit && now() - hit.at < MEMO_MS) return hit.value as Promise<T | undefined>;
    const value = read<T>(path);
    if (memo.size > 500) memo.clear();
    memo.set(path, { at: now(), value });
    return value;
  }

  function coverage(): Promise<IndexerCoverage | undefined> {
    if (!url || !token) return Promise.resolve(undefined);
    const path = '/v1/coverage';
    const hit = memo.get(path);
    if (hit && now() - hit.at < MEMO_MS) return hit.value as Promise<IndexerCoverage | undefined>;
    const value = read<IndexerCoverage>(path);
    memo.set(path, { at: now(), value });
    return value;
  }

  return {
    coverage,
    creator: (address) => get<IndexerCreator>('creator', address),
    token: (address) => get<IndexerToken>('token', address),
    funder: (address) => get<IndexerFunder>('funder', address),
    markets: (token) => get<IndexerMarkets>('markets', token),
    network: (creator) => get<IndexerNetwork>('network', creator),
  };
}

let shared: IndexerClient | undefined;

/** Le client de l'instance, ou `undefined` quand l'indexeur n'est pas configuré. */
export function indexer(): IndexerClient | undefined {
  if (!indexerConfigured()) return undefined;
  shared ??= createIndexerClient();
  return shared;
}
