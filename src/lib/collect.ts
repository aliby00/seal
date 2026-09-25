import { isAddress, type Address } from 'viem';
import { fetchCreatorHistory, fetchGraduationStatus, createRpcClient } from './chain';
import { combineCompleteness, type Completeness } from './contracts';
import type { CreatorHistory, HolderDistribution, MarketState, TokenReport } from './contracts';
import { NotFoundError, SealError } from './errors';
import { createBudget, type RequestBudget } from './http';
import { fetchHolderDistribution } from './holders';
import { fetchMarketState } from './market';
import { log } from './logger';

/**
 * Orchestrateur du pipeline de données.
 *
 * Les trois modules tournent en parallèle et **aucun ne peut faire échouer les
 * autres** : un échec est converti en bloc `unavailable` porteur de son motif.
 * Deux sources sur trois restent une analyse, à condition de le dire — c'est
 * l'agent qui le dira, à partir des `completeness` qu'on lui remet.
 */

export type CollectOptions = {
  rpcUrl?: string;
  blockscoutApiKey?: string;
  /** Plafond de requêtes externes pour une analyse, toutes sources confondues. */
  maxRequests?: number;
  lookbackBlocks?: number;
  now?: () => Date;
};

function failed<T>(
  name: 'robinhood-rpc' | 'blockscout' | 'dexscreener',
  fetchedAt: string,
  error: unknown,
  data: T,
): {
  completeness: Completeness;
  sources: { name: typeof name; fetchedAt: string; note: string }[];
  data: T;
} {
  const note =
    error instanceof SealError
      ? `${error.kind} : ${error.message}`
      : error instanceof Error
        ? error.message
        : 'échec inconnu';
  log.warn('source indisponible', { source: name, note });
  return { completeness: 'unavailable', sources: [{ name, fetchedAt, note }], data };
}

async function settled<T>(promise: Promise<T>, fallback: (error: unknown) => T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    return fallback(error);
  }
}

/**
 * Rassemble les trois familles de signaux pour un token.
 * Ne produit aucun agrégat : c'est l'agent qui croise.
 */
export async function collect(token: string, options: CollectOptions = {}): Promise<TokenReport> {
  if (!isAddress(token)) {
    throw new NotFoundError('robinhood-rpc', `adresse invalide : ${token}`);
  }

  const address = token as Address;
  const now = options.now ?? (() => new Date());
  const collectedAt = now().toISOString();
  const budget: RequestBudget = createBudget(options.maxRequests ?? 60);
  const rpc = createRpcClient(options.rpcUrl, budget);

  // La chaîne d'abord : elle donne le créateur, le pool et l'état de graduation,
  // dont le module marché a besoin pour calculer la progression.
  const chain = await settled(
    fetchCreatorHistoryForToken(address, { ...options, budget, rpcUrl: options.rpcUrl }),
    (error) =>
      failed('robinhood-rpc', collectedAt, error, {
        creator: '0x',
        tokens: [],
        counts: { launched: 0, graduated: 0, abandoned: 0, liquidityPulled: 0 },
        scannedRange: { fromBlock: 0, toBlock: 0 },
      }) as CreatorHistory,
  );

  const launch = chain.data.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
  const graduation = await settled(
    (async () => {
      if (!launch) return undefined;
      const status = await fetchGraduationStatus(rpc, address, address);
      return status
        ? {
            thresholdEth: status.thresholdEth,
            pairedEth: status.pairedEth,
            graduated: status.graduated,
          }
        : undefined;
    })(),
    () => undefined,
  );

  const [holders, market] = await Promise.all([
    settled<HolderDistribution>(
      fetchHolderDistribution(address, {
        apiKey: options.blockscoutApiKey,
        budget,
        poolAddress: launch?.pool,
        now,
      }),
      (error) =>
        failed('blockscout', collectedAt, error, {
          token: address,
          totalSupply: '0',
          holderCount: null,
          top: [],
          concentration: { top1: 0, top10: 0 },
          distinctTraders: null,
        }) as HolderDistribution,
    ),
    settled<MarketState>(
      fetchMarketState(address, { budget, graduation, now }),
      (error) =>
        failed('dexscreener', collectedAt, error, {
          token: address,
          pair: null,
          priceUsd: null,
          liquidityUsd: null,
          pairedEth: null,
          graduation: null,
          volumeUsd: null,
          txns: null,
          fdvUsd: null,
          pairCreatedAt: null,
        }) as MarketState,
    ),
  ]);

  const completeness = combineCompleteness([
    chain.completeness,
    holders.completeness,
    market.completeness,
  ]);

  log.info('analyse collectée', {
    token: address,
    completeness,
    requests: budget.spent,
  });

  return { token: address, collectedAt, creator: chain, holders, market, completeness };
}

/** Le créateur d'un token se lit dans son propre `TokenLaunched`. */
async function fetchCreatorHistoryForToken(
  token: Address,
  options: CollectOptions & { budget: RequestBudget },
): Promise<CreatorHistory> {
  return fetchCreatorHistory(token, {
    rpcUrl: options.rpcUrl,
    budget: options.budget,
    lookbackBlocks: options.lookbackBlocks,
    now: options.now,
  });
}
