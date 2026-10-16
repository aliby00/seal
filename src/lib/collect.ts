import { isAddress, type Address } from 'viem';
import {
  createRpcClient,
  fetchCreatorHistory,
  fetchDeployerHistory,
  fetchGraduationStatus,
  findFirstMintLog,
  findLaunchOf,
  traceTokenOrigin,
  type RawLog,
  type TokenOrigin,
} from './chain';
import { combineCompleteness, type Completeness, type CreatorOrigin } from './contracts';
import type { CreatorHistory, HolderDistribution, MarketState, TokenReport } from './contracts';
import { IncompleteDataError, NotFoundError, SealError } from './errors';
import { createBudget, type RequestBudget } from './http';
import { fetchHolderDistribution } from './holders';
import { fetchHoldersFromChain, findFirstMint } from './holders/chain';
import { fetchMarketState } from './market';
import { log } from './logger';
import { TtlCache } from './cache';

/**
 * L'historique d'un créateur est la partie chère de l'analyse — 30 M blocs
 * scannés — et la plus lente à changer. Le marché, lui, bouge à la minute et
 * n'est jamais mis en cache.
 *
 * Cinq minutes : assez pour que plusieurs tokens du même créateur analysés
 * d'affilée ne rescannent pas, assez court pour qu'un nouveau lancement
 * apparaisse vite.
 */
const CREATOR_HISTORY_TTL_MS = 5 * 60_000;

export const creatorHistoryCache = new TtlCache<CreatorHistory>({
  ttlMs: CREATOR_HISTORY_TTL_MS,
  maxEntries: 200,
  // A history cut short (a window the node refused) would be served as is for
  // five minutes: only a read that covered what it meant to cover is kept.
  keep: (history) => !(history.sources[0]?.note ?? '').includes('could not be read'),
});

/**
 * Orchestrateur du pipeline de données.
 *
 * Les trois modules tournent en parallèle et **aucun ne peut faire échouer les
 * autres** : un échec est converti en bloc `unavailable` porteur de son motif.
 * Deux sources sur trois restent une analyse, à condition de le dire — c'est
 * l'agent qui le dira, à partir des `completeness` qu'on lui remet.
 */

/** Per-source request ceilings for one analysis. */
export const RPC_BUDGET = 40;
/** Blockscout pages, or RPC requests when holders are rebuilt from transfers. */
export const HOLDERS_BUDGET = 20;
export const MARKET_BUDGET = 4;

/** A pons launch names its creator in its own launch record. */
const PONS_ORIGIN: CreatorOrigin = {
  source: 'pons',
  role: 'launcher',
  launchesListed: true,
  transactionCount: null,
};

export type CollectOptions = {
  rpcUrl?: string;
  blockscoutApiKey?: string;
  /**
   * Request ceiling for the chain, per analysis. Each source has its own
   * budget: with a shared one, a slow launch lookup spent all 150 requests and
   * left DexScreener with none, on every token older than five days.
   *
   * Measured with batched reads: 4 to 8 HTTP requests for a creator with a
   * few launches, sales and liquidity included.
   */
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
        : 'unknown failure';
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
    throw new NotFoundError('robinhood-rpc', `invalid address: ${token}`);
  }

  const address = token as Address;
  const now = options.now ?? (() => new Date());
  const collectedAt = now().toISOString();
  const budget: RequestBudget = createBudget(options.maxRequests ?? RPC_BUDGET);
  const rpc = createRpcClient(options.rpcUrl, budget);
  const holdersBudget = createBudget(HOLDERS_BUDGET);
  const marketBudget = createBudget(MARKET_BUDGET);

  // La chaîne d'abord : elle donne le créateur, le pool et l'état de graduation,
  // dont le module marché a besoin pour calculer la progression.
  //
  // On ne connaît au départ que l'adresse du token. Le créateur se lit dans le
  // `TokenLaunched` de ce token — il faut donc le retrouver AVANT de pouvoir
  // interroger l'historique du créateur. Filtrer les lancements sur l'adresse
  // du token au lieu de celle du deployer ne renvoie évidemment jamais rien.
  // An unreachable node and a token that is not a pons launch both leave no
  // launch, but they do not mean the same thing and must not be reported alike.
  let lookupError: unknown;
  let latest = 0;
  const launch = await settled(
    (async () => {
      latest = Number(await rpc.call<string>('eth_blockNumber', []));
      return findLaunchOf(rpc, address, latest, options.lookbackBlocks);
    })(),
    (error) => {
      lookupError = error;
      return undefined;
    },
  );

  // Not a pons launch: the creator is traced from the transaction of the
  // token's first mint, and their other launches from the launch contract's
  // own record. Only when the node answered: a failed lookup is not "not pons".
  let mintLog: RawLog | undefined;
  const origin: TokenOrigin | undefined =
    !launch && lookupError === undefined && latest > 0
      ? await settled(
          (async () => {
            mintLog = await findFirstMintLog(rpc, address, latest);
            return mintLog ? traceTokenOrigin(rpc, address, mintLog) : undefined;
          })(),
          () => undefined,
        )
      : undefined;

  // La clé porte la profondeur : deux analyses avec des fenêtres différentes
  // ne décrivent pas le même historique et ne doivent pas se partager une entrée.
  // The analysed token is always checked for sales and liquidity, so it is part
  // of the key: another token of the same creator may not have been.
  const cacheKey = launch
    ? `${launch.deployer.toLowerCase()}:${address.toLowerCase()}:${options.lookbackBlocks ?? 'default'}`
    : `deployer:${origin?.creator}:${address.toLowerCase()}`;
  let historyFromCache = false;

  const emptyHistory = (creator: string) => ({
    creator,
    tokens: [],
    counts: {
      launched: 0,
      graduated: 0,
      abandoned: 0,
      undetermined: 0,
      liquidityPulled: 0,
      creatorDumped: 0,
    },
    scannedRange: { fromBlock: 0, toBlock: 0 },
  });

  const chain: CreatorHistory = launch
    ? await settled(
        creatorHistoryCache
          .resolve(cacheKey, () =>
            fetchCreatorHistory(launch.deployer, {
              focus: address,
              rpcUrl: options.rpcUrl,
              budget,
              lookbackBlocks: options.lookbackBlocks,
              now,
            }),
          )
          .then(({ value, cached }) => {
            historyFromCache = cached;
            return {
              ...value,
              data: { ...value.data, origin: value.data.origin ?? PONS_ORIGIN },
            };
          }),
        (error) =>
          failed(
            'robinhood-rpc',
            collectedAt,
            error,
            emptyHistory(launch.deployer),
          ) as CreatorHistory,
      )
    : origin
      ? await settled(
          creatorHistoryCache
            .resolve(cacheKey, () =>
              fetchDeployerHistory(rpc, origin, { latestBlock: latest, now }),
            )
            .then(({ value, cached }) => {
              historyFromCache = cached;
              return value;
            }),
          (error) =>
            failed(
              'robinhood-rpc',
              collectedAt,
              error,
              emptyHistory(origin.creator),
            ) as CreatorHistory,
        )
      : (failed(
          'robinhood-rpc',
          collectedAt,
          lookupError ??
            new Error(
              mintLog
                ? 'not a pons launch, and the transaction of its first mint could not be read — creator not available'
                : 'not a pons launch, and the token’s first mint was not found — creator not available',
            ),
          emptyHistory('0x'),
        ) as CreatorHistory);

  const graduation = await settled(
    (async () => {
      if (!launch) return undefined;
      const status = await fetchGraduationStatus(rpc, launch.factory, address);
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

  // Without a Blockscout key, a pons token's holders are rebuilt from its
  // transfers since launch — free, and exact when the whole history is read.
  const launchBlock = chain.data.tokens.find(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  )?.launchedAtBlock;
  function readHolders(): Promise<HolderDistribution> {
    if (!options.blockscoutApiKey && latest > 0) {
      return (async () => {
        const holdersRpc = createRpcClient(options.rpcUrl, holdersBudget);
        // Not a pons launch: start from the token's first mint instead.
        const from =
          launchBlock ??
          (mintLog
            ? Number(mintLog.blockNumber)
            : await findFirstMint(holdersRpc, address, latest));
        if (from === undefined) {
          throw new IncompleteDataError(
            'robinhood-rpc',
            'the start of this token’s history could not be found',
          );
        }
        return fetchHoldersFromChain(holdersRpc, address, {
          fromBlock: from,
          toBlock: latest,
          poolAddress: launch?.pool ?? origin?.venues.pools[0],
          now,
        });
      })();
    }
    return fetchHolderDistribution(address, {
      apiKey: options.blockscoutApiKey,
      budget: holdersBudget,
      poolAddress: launch?.pool ?? origin?.venues.pools[0],
      now,
    });
  }

  const [holders, market] = await Promise.all([
    settled<HolderDistribution>(
      readHolders(),
      (error) =>
        failed(options.blockscoutApiKey ? 'blockscout' : 'robinhood-rpc', collectedAt, error, {
          token: address,
          countedSupply: '0',
          holderCount: null,
          top: [],
          concentration: { top1: 0, top10: 0 },
          distinctTraders: null,
        }) as HolderDistribution,
    ),
    settled<MarketState>(
      fetchMarketState(address, { budget: marketBudget, graduation, now }),
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
    requests: { rpc: budget.spent, holders: holdersBudget.spent, market: marketBudget.spent },
    creatorHistoryCached: historyFromCache,
  });

  return { token: address, collectedAt, creator: chain, holders, market, completeness };
}
