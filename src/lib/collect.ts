import { isAddress, type Address } from 'viem';
import {
  createRpcClient,
  fetchCreatorHistory,
  fetchDeployerHistory,
  fetchGraduationStatus,
  findFirstMintLog,
  findLaunchOf,
  listCreatorLaunches,
  readLaunchReplay,
  traceTokenOrigin,
  DIRECT_DEPLOYS,
  mergeListings,
  type CreatorListing,
  type IndexedListing,
  type RawLog,
  type RpcClient,
  type TokenOrigin,
} from './chain';
import { combineCompleteness, type Completeness, type CreatorOrigin } from './contracts';
import type {
  CreatorHistory,
  HolderDistribution,
  SetAsideRole,
  LaunchedToken,
  MarketState,
  TokenReport,
} from './contracts';
import { IncompleteDataError, NotFoundError, RateLimitError, SealError } from './errors';
import { createBudget, type RequestBudget } from './http';
import { fetchHolderDistribution } from './holders';
import {
  fetchHoldersFromChain,
  findFirstMint,
  readPoolsShare,
  recheckContracts,
} from './holders/chain';
import {
  checkLiquidity,
  fetchPairs,
  toMarketState,
  venuesOf,
  type DexScreenerPair,
} from './market';
import { POOL_MANAGER } from './chain/pools';
import { log } from './logger';
import { TtlCache } from './cache';
import { indexer } from './indexer/client';
import { indexedListing, withIndexedLaunches, withPoolActivity } from './indexer/merge';

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
/** One batch of balances: what the token's pools hold today. */
const POOLS_BUDGET = 2;
/** One batch of codes: the largest holders Blockscout calls contracts, re-read. */
const RECHECK_BUDGET = 2;
/**
 * The launch replay: the log read and the supply, then block times, codes and
 * balances in batches of 20 — up to 42 blocks and 160 addresses (the moves
 * drawn, the first buyers, the addresses one transaction served), so 19 at
 * most, plus three batches of receipts and the halvings of a launch too busy
 * to read at once. Retries on a busy public node count too: room is left.
 */
export const LAUNCH_BUDGET = 50;
/** The pause before the replay is asked again of a node that turned it away. */
const REPLAY_RETRY_MS = 4_000;

/** A pons launch names its creator in its own launch record. */
function ponsOrigin(factory: string): CreatorOrigin {
  return {
    source: 'pons',
    role: 'launcher',
    launchpad: { id: 'pons', name: 'pons', address: factory.toLowerCase() },
    creatorFrom: 'launch-record',
    launchesListed: true,
    transactionCount: null,
  };
}

/**
 * A pons creator's launches on the other launchpads: listed from their own
 * events, added as undetermined (graduation is read on pons only), their
 * sales not checked. The history says where it looked.
 */
export function withOtherLaunchpads(
  history: CreatorHistory,
  listing: CreatorListing | undefined,
): CreatorHistory {
  if (!listing || history.completeness === 'unavailable') return history;
  const origin = history.data.origin;
  const known = new Set(history.data.tokens.map((t) => t.address.toLowerCase()));
  const added: LaunchedToken[] = listing.launches
    .filter((l) => !known.has(l.token))
    .map((l) => ({
      address: l.token,
      pool: '0x',
      launchedAtBlock: l.blockNumber,
      launchedAt: null,
      outcome: 'undetermined',
      graduationProgress: 0,
      liquidityPulled: null,
      creatorDumped: null,
      ...(l.launchpad ? { launchpad: l.launchpad.name } : {}),
    }));
  const withCoverage = origin
    ? {
        ...origin,
        launchpadsRead: ['pons', ...listing.read],
        launchpadsNotRead: [...listing.unread, DIRECT_DEPLOYS],
      }
    : origin;
  return {
    ...history,
    completeness: added.length > 0 || listing.truncated ? 'partial' : history.completeness,
    sources:
      added.length > 0 || listing.truncated
        ? [
            ...history.sources,
            {
              name: 'robinhood-rpc',
              fetchedAt: history.sources[0]?.fetchedAt ?? new Date().toISOString(),
              note: listing.truncated
                ? 'launches on other launchpads: some windows could not be read'
                : `${added.length} launch${added.length === 1 ? '' : 'es'} on other launchpads; graduation is read on pons only, and their sales were not checked`,
            },
          ]
        : history.sources,
    data: {
      ...history.data,
      ...(withCoverage ? { origin: withCoverage } : {}),
      tokens: [...history.data.tokens, ...added],
      counts: {
        ...history.data.counts,
        launched: history.data.counts.launched + added.length,
        undetermined: history.data.counts.undetermined + added.length,
      },
    },
  };
}

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

/** A pons creator's launches elsewhere; `undefined` when they could not be read. */
async function otherLaunchpads(
  rpc: RpcClient,
  creator: string,
  latest: number,
  indexed: IndexedListing | undefined,
): Promise<CreatorListing | undefined> {
  const skip = (l: { id: string }) => l.id === 'pons' || Boolean(indexed?.covered.has(l.id));
  const listing = await listCreatorLaunches(rpc, creator, latest, { skip }).catch(() => undefined);
  if (!listing) return undefined;
  if (!indexed) return listing;
  const merged = mergeListings(listing, {
    covered: new Set([...indexed.covered].filter((id) => id !== 'pons')),
    launches: indexed.launches.filter((l) => l.launchpad?.id !== 'pons'),
  });
  return merged;
}

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
  // The listed pairs say where the token trades now, beyond the markets its
  // launch created: started at once, read by the history and the market.
  const pairsRead: Promise<{ pairs: DexScreenerPair[] } | { error: unknown }> = fetchPairs(
    address,
    { budget: marketBudget },
  ).then(
    (pairs) => ({ pairs }),
    (error: unknown) => ({ error }),
  );

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

  // The indexer knows pons launches (their pool's trades too) and the other
  // launchpads' launches: asked for in parallel, it never blocks the rest.
  const ix = indexer();
  const indexedToken = launch && ix ? ix.token(address) : Promise.resolve(undefined);

  // Not a pons launch: the creator is traced from the transaction of the
  // token's first mint — the launch event of a known launchpad when there is
  // one — and their other launches from every launchpad's own record. Only
  // when the node answered: a failed lookup is not "not pons".
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
  const creatorAddress = launch?.deployer ?? origin?.creator;
  const [indexed, coverage] =
    ix && creatorAddress
      ? await Promise.all([ix.creator(creatorAddress), ix.coverage()])
      : [undefined, undefined];
  // Launchpads the indexer has read to the head are not asked of the node.
  const listedByIndexer = latest > 0 ? indexedListing(indexed, coverage, latest) : undefined;
  const pairs = await pairsRead;
  const listedVenues = 'pairs' in pairs ? venuesOf(address, pairs.pairs) : undefined;
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

  const chainRead: CreatorHistory = launch
    ? await settled(
        creatorHistoryCache
          .resolve(cacheKey, async () => {
            const history = await fetchCreatorHistory(launch.deployer, {
              focus: address,
              rpcUrl: options.rpcUrl,
              budget,
              lookbackBlocks: options.lookbackBlocks,
              now,
            });
            // After the pons read, not alongside it: both are log queries
            // on a node that paces them.
            const others = await otherLaunchpads(rpc, launch.deployer, latest, listedByIndexer);
            return withOtherLaunchpads(
              {
                ...history,
                data: {
                  ...history.data,
                  origin: history.data.origin ?? ponsOrigin(launch.factory),
                },
              },
              others,
            );
          })
          .then(({ value, cached }) => {
            historyFromCache = cached;
            return value;
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
              fetchDeployerHistory(rpc, origin, {
                latestBlock: latest,
                ...(listedByIndexer ? { indexed: listedByIndexer } : {}),
                ...(listedVenues ? { venues: listedVenues } : {}),
                now,
              }),
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
                ? 'no launch record found, and the transaction of its first mint could not be read — creator not available'
                : 'no launch record found, and the token’s first mint was not found — creator not available',
            ),
          emptyHistory('0x'),
        ) as CreatorHistory);

  const chain = withIndexedLaunches(chainRead, indexed, collectedAt);

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
  // Every address that holds the token for trading or for its launch, and
  // why: none of them is a holder. The launch pool alone was passed before,
  // and a launchpad's curve (99.9 % of a flap.sh token), the pairs listed
  // since, the launchpad's own contracts and its lock contract all read as
  // the largest holders.
  const setAside: { address: string; role: SetAsideRole }[] = [
    ...(launch?.pool && launch.pool !== '0x'
      ? [{ address: launch.pool, role: 'pool' as const }]
      : []),
    ...(origin?.venues.pools ?? []).map((address) => ({ address, role: 'pool' as const })),
    ...(listedVenues?.pools ?? []).map((address) => ({ address, role: 'pool' as const })),
    ...(origin?.venues.curves ?? []).map((address) => ({ address, role: 'curve' as const })),
    ...(origin?.launchContract
      ? [{ address: origin.launchContract, role: 'launchpad' as const }]
      : []),
  ];
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
          setAside,
          now,
        });
      })();
    }
    return fetchHolderDistribution(address, {
      apiKey: options.blockscoutApiKey,
      budget: holdersBudget,
      setAside,
      now,
    }).then(async (distribution) =>
      distribution.completeness === 'unavailable' || latest === 0
        ? distribution
        : {
            ...distribution,
            // Blockscout calls a wallet delegating under EIP-7702 a contract.
            data: await recheckContracts(
              createRpcClient(options.rpcUrl, createBudget(RECHECK_BUDGET)),
              distribution.data,
            ).catch(() => distribution.data),
          },
    );
  }

  // The first minutes, read on their own budget: they never cost the three blocks anything.
  const launchFrom = launchBlock ?? (mintLog ? Number(mintLog.blockNumber) : undefined);
  const replayOptions = {
    launchBlock: launchFrom ?? 0,
    latestBlock: latest,
    // Every place the token's supply sits for trading: the launch pool,
    // the pairs created at launch and since, a launchpad's curve.
    pools: [
      launch?.pool,
      ...(origin?.venues.pools ?? []),
      ...(origin?.venues.curves ?? []),
      ...(listedVenues?.pools ?? []),
    ].filter((pool): pool is string => Boolean(pool) && pool !== '0x'),
    creator: chain.data.creator,
    now,
  };
  // The replay runs alongside the holders' rebuild, the busiest read of all:
  // a node that turned it away is asked once more, after a pause.
  const readReplay = async () => {
    try {
      return await readLaunchReplay(
        createRpcClient(options.rpcUrl, createBudget(LAUNCH_BUDGET)),
        address,
        replayOptions,
      );
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, REPLAY_RETRY_MS));
      return readLaunchReplay(
        createRpcClient(options.rpcUrl, createBudget(LAUNCH_BUDGET)),
        address,
        replayOptions,
      );
    }
  };
  const replay =
    launchFrom !== undefined && latest > 0
      ? settled(readReplay(), (error) => {
          log.warn('replay du lancement indisponible', { token: address, error: String(error) });
          return undefined;
        })
      : Promise.resolve(undefined);

  // What the token's pools hold today, against what DexScreener lists: a
  // removal is on chain at once, the listed liquidity can lag it by hours.
  const poolsShare =
    latest > 0
      ? settled(
          readPoolsShare(
            createRpcClient(options.rpcUrl, createBudget(POOLS_BUDGET)),
            address,
            // Every market the token trades on: its pairs, its curve, the v4 PoolManager.
            [
              ...setAside
                .filter((s) => s.role === 'pool' || s.role === 'curve')
                .map((s) => s.address),
              POOL_MANAGER,
            ],
          ),
          () => null,
        )
      : Promise.resolve(null);

  const [holders, marketRead, launchReplay, pooledNow] = await Promise.all([
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
      (async () => {
        if ('error' in pairs) throw pairs.error;
        return toMarketState(address, pairs.pairs, { graduation, now });
      })(),
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
    replay,
    poolsShare,
  ]);

  // No listed pair: the launch pool's own trades, counted by the indexer.
  const market = checkLiquidity(
    withPoolActivity(marketRead, await indexedToken, collectedAt, now),
    pooledNow,
  );

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

  return {
    token: address,
    collectedAt,
    creator: chain,
    holders,
    market,
    ...(launchReplay ? { launch: launchReplay } : {}),
    completeness,
  };
}
