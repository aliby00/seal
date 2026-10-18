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
  FailedRead,
  HolderDistribution,
  SetAsideRole,
  FeePayer,
  LaunchedToken,
  ListedPool,
  MarketState,
  TokenReport,
} from './contracts';
import { IncompleteDataError, NotFoundError, RateLimitError, SealError } from './errors';
import {
  failedReadsOfSources,
  mergeFailedReads,
  noteFailed,
  SALE_SEEN,
  UNREAD,
} from './failed-reads';
import { LAUNCH_HOOKS } from './chain/launchpads';
import { OWN_SALES_MAX_BLOCKS, TRANSFER_TOPIC, topicFor } from './chain/behavior';
import { getLogsBatched } from './chain/logs';
import { createBudget, type RequestBudget } from './http';
import { fetchHolderDistribution, setAsideRoles } from './holders';
import {
  fetchHoldersFromChain,
  findFirstMint,
  readPoolsShare,
  recheckContracts,
} from './holders/chain';
import {
  checkLiquidity,
  fetchPairs,
  listedPools,
  mainPool,
  meaningfulPools,
  pickPrimaryPair,
  toMarketState,
  venuesOf,
  type DexScreenerPair,
} from './market';
import { findMarketsById, POOL_MANAGER, type V4Market } from './chain/pools';
import { isContractCode } from './chain/code';
import { linkCreatorToHolders, withLinks } from './holders/links';
import { log } from './logger';
import { TtlCache } from './cache';
import {
  indexer,
  type IndexerAnswer,
  type IndexerClient,
  type IndexerMarkets,
} from './indexer/client';
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
  keep: (history) => !history.sources.some((s) => noteFailed(s.note)),
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
 * balances in batches of 20 — up to 42 blocks, 60 codes and 100 balances
 * (the moves drawn, the addresses one transaction served, the first buyers),
 * so 11 at most, plus three batches of receipts and the halvings of a launch
 * too busy to read at once. Retries on a busy public node count too.
 */
export const LAUNCH_BUDGET = 40;
/** The pause before the replay is asked again of a node that turned it away. */
const REPLAY_RETRY_MS = 4_000;

/**
 * The pauses before a rate-limited read on the critical path (the creator
 * lookup, the creator's history) is asked again. GNRG on 18/10/2026: one
 * refusal of the public node lost the whole creator for that report.
 */
export const RATE_LIMIT_RETRY_MS: readonly number[] = [1_500, 3_000];
/** No retry starts after this much of the collection: 30 s in all, the rest still has to run. */
const RETRY_DEADLINE_MS = 15_000;

/** A refusal that a pause may cure: a rate limit, or a read the node cut short. */
function worthRetrying(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof IncompleteDataError) return error.source === 'robinhood-rpc';
  return (
    error instanceof SealError && /request limit|rate limit|too many requests/i.test(error.message)
  );
}

/** `fn`, asked again after each pause while the node rate-limits it and time remains. */
export async function retryRateLimited<T>(
  fn: () => Promise<T>,
  options: {
    delaysMs?: readonly number[];
    startedAt?: number;
    deadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<T> {
  const delays = options.delaysMs ?? RATE_LIMIT_RETRY_MS;
  const clock = options.now ?? Date.now;
  const startedAt = options.startedAt ?? clock();
  const deadline = options.deadlineMs ?? RETRY_DEADLINE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const delay = delays[attempt];
      if (!worthRetrying(error) || delay === undefined) throw error;
      if (clock() - startedAt + delay > deadline) throw error;
      log.warn('lecture limitée, nouvelle tentative', { attempt: attempt + 1, delayMs: delay });
      await sleep(delay);
    }
  }
}

/** The indexer's answer and whether it failed, from a client that may predate `*Answer`. */
function answerOf<T>(
  withFailure: (() => Promise<IndexerAnswer<T>>) | undefined,
  plain: () => Promise<T | undefined>,
): Promise<IndexerAnswer<T>> {
  return withFailure ? withFailure() : plain().then((value) => ({ value, failed: false }));
}

/** A history whose source says that one of its reads could not be completed this time. */
function withUnreadNote(history: CreatorHistory, note: string): CreatorHistory {
  if (history.completeness === 'unavailable') return history;
  if (history.sources.some((s) => s.note === note)) return history;
  return {
    ...history,
    completeness: 'partial',
    sources: [
      ...history.sources,
      {
        name: 'robinhood-rpc',
        fetchedAt: history.sources[0]?.fetchedAt ?? new Date().toISOString(),
        note,
      },
    ],
  };
}

/** A pons launch names its creator in its own launch record. */
function ponsOrigin(factory: string, transactionCount: number | null = null): CreatorOrigin {
  return {
    source: 'pons',
    role: 'launcher',
    launchpad: { id: 'pons', name: 'pons', address: factory.toLowerCase() },
    creatorFrom: 'launch-record',
    launchesListed: true,
    transactionCount,
  };
}

/**
 * Transactions a creator's wallet has sent; `null` for a contract or when
 * unread. A wallet delegating under EIP-7702 has code and is still a wallet.
 * Read for pons creators too, so the facts and the wallet-age question
 * quote the same count (Mike: "1088 transactions" in the text, none in the facts).
 */
async function walletTransactionCount(rpc: RpcClient, creator: string): Promise<number | null> {
  const [code, count] = await rpc
    .callBatch<string>([
      { method: 'eth_getCode', params: [creator, 'latest'] },
      { method: 'eth_getTransactionCount', params: [creator, 'latest'] },
    ])
    .catch(() => []);
  if (!code?.ok || !count?.ok || isContractCode(code.value)) return null;
  const n = Number(count.value);
  return Number.isFinite(n) ? n : null;
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
  /** The pauses before a rate-limited critical read is retried (tests pass zeros). */
  retryDelaysMs?: readonly number[];
  /**
   * After this long (ms from the start), a creator history still being read
   * is reported as a read that did not finish: a partial report, served,
   * instead of the route's 504. It keeps going and is cached for the next ask.
   */
  historyDeadlineMs?: number;
  /** After this long (ms), a creator's other launches are listed but not checked. */
  checkOthersWithinMs?: number;
};

/**
 * The route cuts collection at 30 s. The history gets 26, its other
 * launches' checks start within 14: what is read after that (the holders'
 * links, the fees) still fits (AI: 80 launches, cut at 30.2 s on staging).
 */
export const HISTORY_DEADLINE_MS = 26_000;
export const CHECK_OTHERS_WITHIN_MS = 14_000;

/** A pons creator's launches elsewhere; `undefined` when they could not be read. */
async function otherLaunchpads(
  rpc: RpcClient,
  creator: string,
  latest: number,
  indexed: IndexedListing | undefined,
): Promise<CreatorListing | undefined> {
  const skip = (l: { id: string }) => l.id === 'pons' || Boolean(indexed?.covered.has(l.id));
  const listing = await listCreatorLaunches(rpc, creator, latest, { skip }).catch(() => undefined);
  // Not read is not "none": the history says so, and is not cached (GNRG).
  if (!listing) return { launches: [], truncated: true, read: [], unread: [] };
  if (!indexed) return listing;
  const merged = mergeListings(listing, {
    covered: new Set([...indexed.covered].filter((id) => id !== 'pons')),
    launches: indexed.launches.filter((l) => l.launchpad?.id !== 'pons'),
  });
  return merged;
}

/** Requests for the creator's links to its holders: a supply, a batch of codes, two log reads. */
const LINKS_BUDGET = 6;

/** The analysed token marked as sold by its creator. */
function withOwnSale(history: CreatorHistory, own: (t: LaunchedToken) => boolean): CreatorHistory {
  const tokens = history.data.tokens.map((t) => (own(t) ? { ...t, creatorDumped: true } : t));
  return {
    ...history,
    data: {
      ...history.data,
      tokens,
      counts: {
        ...history.data.counts,
        creatorDumped: tokens.filter((t) => t.creatorDumped === true).length,
      },
    },
  };
}

/** An error as a source note: its kind first, so `noteFailed` can tell a failure. */
function noteOf(error: unknown): string {
  return error instanceof SealError
    ? `${error.kind} : ${error.message}`
    : error instanceof Error
      ? error.message
      : 'unknown failure';
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
  const note = noteOf(error);
  log.warn('source indisponible', { source: name, note });
  return { completeness: 'unavailable', sources: [{ name, fetchedAt, note }], data };
}

/** `promise`, or `late()` when it has not settled within `ms`. */
async function withinDeadline<T>(promise: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late()), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, cut]);
  } finally {
    clearTimeout(timer);
  }
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
  const startedAt = Date.now();
  const retry = <T>(fn: () => Promise<T>) =>
    retryRateLimited(fn, {
      startedAt,
      ...(options.retryDelaysMs ? { delaysMs: options.retryDelaysMs } : {}),
    });
  // Every read that failed this time: what it would have found is unknown.
  const failures: FailedRead[] = [];
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
    retry(async () => {
      latest = Number(await rpc.call<string>('eth_blockNumber', []));
      return findLaunchOf(rpc, address, latest, options.lookbackBlocks);
    }),
    (error) => {
      lookupError = error;
      return undefined;
    },
  );

  // The indexer knows pons launches (their pool's trades too) and the other
  // launchpads' launches: asked for in parallel, it never blocks the rest.
  const ix: IndexerClient | undefined = indexer();
  const indexedToken: Promise<IndexerAnswer<Awaited<ReturnType<IndexerClient['token']>>>> =
    launch && ix
      ? answerOf(ix.tokenAnswer ? () => ix.tokenAnswer!(address) : undefined, () =>
          ix.token(address),
        )
      : Promise.resolve({ value: undefined, failed: false });
  // The token's v4 markets as the indexer read them: their trading rules
  // (hooks) hold the token for the market, never for a person.
  const indexedMarkets: Promise<IndexerMarkets['markets']> = ix
    ? ix
        .markets(address)
        .then((answer) => answer?.markets ?? [])
        .catch(() => [])
    : Promise.resolve([]);
  const indexedHooks: Promise<string[]> = indexedMarkets.then((markets) =>
    markets
      .map((m) => m.hook.toLowerCase())
      .filter((h) => /^0x[0-9a-f]{40}$/.test(h) && !/^0x0{40}$/.test(h)),
  );

  // Not a pons launch: the creator is traced from the transaction of the
  // token's first mint — the launch event of a known launchpad when there is
  // one — and their other launches from every launchpad's own record. Only
  // when the node answered: a failed lookup is not "not pons".
  let mintLog: RawLog | undefined;
  // A mint that could not be read is not a mint that does not exist (MEME:
  // "first mint not found" on a rate-limited node, its creator lost).
  let originError: unknown;
  const origin: TokenOrigin | undefined =
    !launch && lookupError === undefined && latest > 0
      ? await settled(
          retry(async () => {
            mintLog = await findFirstMintLog(rpc, address, latest);
            if (!mintLog) return undefined;
            const traced = await traceTokenOrigin(rpc, address, mintLog);
            if (!traced) {
              throw new IncompleteDataError(
                'robinhood-rpc',
                'the transaction of the token’s first mint could not be read',
              );
            }
            return traced;
          }),
          (error) => {
            originError = error;
            return undefined;
          },
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
  const [indexedAnswer, coverageAnswer] =
    ix && creatorAddress
      ? await Promise.all([
          answerOf(ix.creatorAnswer ? () => ix.creatorAnswer!(creatorAddress) : undefined, () =>
            ix.creator(creatorAddress),
          ),
          answerOf(ix.coverageAnswer ? () => ix.coverageAnswer!() : undefined, () => ix.coverage()),
        ])
      : [undefined, undefined];
  const indexed = indexedAnswer?.value;
  const coverage = coverageAnswer?.value;
  // The indexer lists the launchpads the node cannot: its silence leaves them unread (AI).
  const indexerFailed = Boolean(indexedAnswer?.failed || coverageAnswer?.failed);
  const noteIndexer = (history: CreatorHistory) =>
    indexerFailed ? withUnreadNote(history, UNREAD.indexer) : history;
  // Launchpads the indexer has read to the head are not asked of the node.
  const listedByIndexer = latest > 0 ? indexedListing(indexed, coverage, latest) : undefined;
  const pairs = await pairsRead;
  const listedVenues = 'pairs' in pairs ? venuesOf(address, pairs.pairs) : undefined;
  // Every listed pool, and the trading rules (hook) of each v4 one: the
  // checks of a market's rules read the main pool and weigh the others.
  const poolsRead: Promise<ListedPool[] | undefined> =
    'pairs' in pairs
      ? settled(
          readPoolRules(
            createRpcClient(options.rpcUrl, createBudget(POOL_RULES_BUDGET)),
            listedPools(address, pairs.pairs),
            indexedMarkets,
            latest,
            pickPrimaryPair(
              pairs.pairs.filter(
                (p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase(),
              ),
            )?.pairAddress?.toLowerCase() ?? null,
          ),
          (error) => {
            log.warn('règles des pools illisibles', { token: address, error: String(error) });
            return undefined;
          },
        )
      : Promise.resolve(undefined);
  let historyFromCache = false;
  let historyError: unknown;

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

  const chainReading: Promise<CreatorHistory> = launch
    ? settled(
        creatorHistoryCache
          .resolve(cacheKey, async () => {
            const history = await retry(() =>
              fetchCreatorHistory(launch.deployer, {
                focus: address,
                rpcUrl: options.rpcUrl,
                budget,
                lookbackBlocks: options.lookbackBlocks,
                now,
              }),
            );
            // After the pons read, not alongside it: both are log queries
            // on a node that paces them.
            const [others, transactionCount] = await Promise.all([
              otherLaunchpads(rpc, launch.deployer, latest, listedByIndexer),
              walletTransactionCount(rpc, launch.deployer),
            ]);
            return noteIndexer(
              withOtherLaunchpads(
                {
                  ...history,
                  data: {
                    ...history.data,
                    origin: history.data.origin ?? ponsOrigin(launch.factory, transactionCount),
                  },
                },
                others,
              ),
            );
          })
          .then(({ value, cached }) => {
            historyFromCache = cached;
            return value;
          }),
        (error) => {
          historyError = error;
          return failed(
            'robinhood-rpc',
            collectedAt,
            error,
            emptyHistory(launch.deployer),
          ) as CreatorHistory;
        },
      )
    : origin
      ? settled(
          creatorHistoryCache
            .resolve(cacheKey, async () =>
              noteIndexer(
                await retry(() =>
                  fetchDeployerHistory(rpc, origin, {
                    latestBlock: latest,
                    checkOthersBy:
                      startedAt + (options.checkOthersWithinMs ?? CHECK_OTHERS_WITHIN_MS),
                    ...(listedByIndexer ? { indexed: listedByIndexer } : {}),
                    ...(listedVenues ? { venues: listedVenues } : {}),
                    now,
                  }),
                ),
              ),
            )
            .then(({ value, cached }) => {
              historyFromCache = cached;
              return value;
            }),
          (error) => {
            historyError = error;
            return failed(
              'robinhood-rpc',
              collectedAt,
              error,
              emptyHistory(origin.creator),
            ) as CreatorHistory;
          },
        )
      : Promise.resolve(
          failed(
            'robinhood-rpc',
            collectedAt,
            lookupError ??
              originError ??
              new Error(
                'no launch record found, and the token’s first mint was not found — creator not available',
              ),
            emptyHistory('0x'),
          ) as CreatorHistory,
        );

  /**
   * Holders, the launch replay and the pools' balances: they need only the
   * creator and the launch block. A token traced from its first mint knows
   * both before its creator's history is read, and reads them alongside it
   * (MEME: 24 s of history, then 10 s of these, one after the other).
   */
  async function readRest(chainCreator: string, launchBlock: number | undefined) {
    // Every address that holds the token for trading or for its launch, and
    // why: none of them is a holder. The launch pool alone was passed before,
    // and a launchpad's curve (99.9 % of a flap.sh token), the pairs listed
    // since, the launchpad's own contracts and its lock contract all read as
    // the largest holders.
    // The later entries win: a launch contract that is also the curve (the
    // flap.sh portal) is named for the curve.
    const setAside: { address: string; role: SetAsideRole }[] = [
      ...(origin?.launchContract
        ? [{ address: origin.launchContract, role: 'launchpad' as const }]
        : []),
      ...(launch?.pool && launch.pool !== '0x'
        ? [{ address: launch.pool, role: 'pool' as const }]
        : []),
      ...(origin?.venues.pools ?? []).map((address) => ({ address, role: 'pool' as const })),
      ...(listedVenues?.pools ?? []).map((address) => ({ address, role: 'pool' as const })),
      ...(origin?.venues.curves ?? []).map((address) => ({ address, role: 'curve' as const })),
      ...[...new Set([...(origin?.venues.hooks ?? []), ...(await indexedHooks)])].map(
        (address) => ({
          address,
          role: 'hook' as const,
        }),
      ),
    ];
    const hooks = setAside.filter((s) => s.role === 'hook').map((s) => s.address);
    // Without a Blockscout key, a pons token's holders are rebuilt from its
    // transfers since launch — free, and exact when the whole history is read.
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
      hooks,
      creator: chainCreator,
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
            failures.push({
              read: 'launch-replay',
              note: `the first minutes after the launch could not be read this time (${noteOf(error)})`,
            });
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

    const [holders, launchReplay, pooledNow] = await Promise.all([
      settled<HolderDistribution>(readHolders(), (error) => {
        failures.push({ read: 'holders', note: noteOf(error) });
        return failed(
          options.blockscoutApiKey ? 'blockscout' : 'robinhood-rpc',
          collectedAt,
          error,
          {
            token: address,
            countedSupply: '0',
            holderCount: null,
            top: [],
            concentration: { top1: 0, top10: 0 },
            distinctTraders: null,
          },
        ) as HolderDistribution;
      }),
      replay,
      poolsShare,
    ]);
    return { holders, launchReplay, pooledNow, setAside, launchFrom };
  }

  // Every transfer of the token to its creator over the window its sales are
  // read on: the fees a market's hook paid out. A token traced from its first
  // mint knows that window now, so it is read alongside the history rather
  // than after it (AI, 80 launches: 8 s more once the history was done).
  const incomingOf = (client: RpcClient, to: string, fromBlock: number, toBlock: number) =>
    getLogsBatched(
      client,
      {
        addresses: [{ address, fromBlock, toBlock }],
        topics: [TRANSFER_TOPIC, null, topicFor(to)],
      },
      { fromBlock, toBlock },
    );
  const earlyIncoming = (() => {
    const fromBlock = origin?.blockNumber ?? 0;
    const toBlock = Math.min(latest, fromBlock + OWN_SALES_MAX_BLOCKS - 1);
    return {
      creator: origin?.creator.toLowerCase(),
      fromBlock,
      toBlock,
      read:
        origin && latest > 0
          ? incomingOf(
              createRpcClient(options.rpcUrl, createBudget(FEES_BUDGET)),
              origin.creator,
              fromBlock,
              toBlock,
            ).catch(() => ({ logs: [] as RawLog[], truncated: true }))
          : Promise.resolve({ logs: [] as RawLog[], truncated: true }),
    };
  })();

  // Not a pons launch: started now, alongside the history.
  const early = launch ? undefined : readRest(origin?.creator ?? '0x', origin?.blockNumber);
  const chainRead = await withinDeadline(
    chainReading,
    startedAt + (options.historyDeadlineMs ?? HISTORY_DEADLINE_MS) - Date.now(),
    () => {
      historyError = new IncompleteDataError(
        'robinhood-rpc',
        'the creator’s history did not finish in time this time; try again in a minute',
      );
      return failed(
        'robinhood-rpc',
        collectedAt,
        historyError,
        emptyHistory(creatorAddress ?? '0x'),
      ) as CreatorHistory;
    },
  );
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

  const own = (t: LaunchedToken) => t.address.toLowerCase() === address.toLowerCase();
  const { holders, launchReplay, pooledNow, setAside, launchFrom } = await (early ??
    readRest(chain.data.creator, chain.data.tokens.find(own)?.launchedAtBlock));
  const marketRead = await settled<MarketState>(
    (async () => {
      if ('error' in pairs) throw pairs.error;
      return toMarketState(address, pairs.pairs, { graduation, now });
    })(),
    (error) => {
      failures.push({ read: 'market', note: noteOf(error) });
      return failed('dexscreener', collectedAt, error, {
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
      }) as MarketState;
    },
  );

  // A creator sale the launch replay saw confirmed by a trade is a sale in
  // the history too: the replay and the history must not disagree (AML).
  const sold =
    launchReplay?.data.summary?.creatorSaleConfirmed &&
    chain.data.tokens.some((t) => own(t) && t.creatorDumped !== true)
      ? withOwnSale(chain, own)
      : chain;

  // The supply, read once: from the replay, else from the token.
  let supplyRead: Promise<bigint> | undefined;
  const supplyOf = (client: RpcClient): Promise<bigint> =>
    (supplyRead ??= launchReplay
      ? Promise.resolve(BigInt(launchReplay.data.supply))
      : client
          .call<string>('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest'])
          .then((raw) => (raw && raw !== '0x' ? BigInt(raw) : 0n)));

  // Tokens the market's trading rules (hooks) paid out to the creator: its
  // fees, taken out of the market without removing its liquidity. Every such
  // transfer over the token's life, summed (MEME: 0.52 % over 28 transfers
  // from Doppler's hook; AML and KEL the same pattern).
  const ownToken = sold.data.tokens.find(own);
  const feeHooks = [
    ...new Set(
      [
        ...setAside.filter((s) => s.role === 'hook').map((s) => s.address),
        ...LAUNCH_HOOKS.map((h) => h.address),
      ].map((a) => a.toLowerCase()),
    ),
  ];
  // Read alongside the holders' links, not after them.
  const feesRead =
    ownToken && sold.completeness !== 'unavailable' && latest > 0 && launchFrom !== undefined
      ? settled(
          (async () => {
            const feesRpc = createRpcClient(options.rpcUrl, createBudget(FEES_BUDGET));
            const fromBlock = ownToken.salesWindow?.fromBlock ?? launchFrom;
            const toBlock = Math.min(latest, ownToken.salesWindow?.toBlock ?? latest);
            const same =
              early &&
              earlyIncoming.creator === sold.data.creator.toLowerCase() &&
              earlyIncoming.fromBlock === fromBlock &&
              earlyIncoming.toBlock === toBlock;
            const { logs, truncated } = await (same
              ? earlyIncoming.read
              : incomingOf(feesRpc, sold.data.creator, fromBlock, toBlock));
            if (truncated) return null;
            const supply = await supplyOf(feesRpc);
            return feesFromHooks(logs, feeHooks, launchFrom, supply);
          })(),
          () => null,
        )
      : Promise.resolve(null);

  // Which holders received from the creator: its own transfers, set against the list.
  const sends = sold.data.tokens.find(own)?.creatorSends;
  const linkedHolders =
    sends && holders.completeness !== 'unavailable' && latest > 0
      ? await settled(
          (async () => {
            const linksRpc = createRpcClient(options.rpcUrl, createBudget(LINKS_BUDGET));
            const supply = await supplyOf(linksRpc);
            if (supply === 0n) return holders;
            const links = await linkCreatorToHolders(linksRpc, {
              token: address.toLowerCase(),
              sends,
              holders: holders.data,
              supply,
              setAside: new Set(
                [...setAsideRoles({ setAside }).keys(), ...setAside.map((s) => s.address)].map(
                  (a) => a.toLowerCase(),
                ),
              ),
              fromBlock: launchFrom ?? 0,
              toBlock: latest,
            });
            return { ...holders, data: withLinks(holders.data, links) };
          })(),
          (error) => {
            log.warn('liens créateur illisibles', { token: address, error: String(error) });
            failures.push({
              read: 'holders',
              note: `which holders received tokens from the creator could not be read this time (${noteOf(error)})`,
            });
            return holders;
          },
        )
      : holders;

  const fees = await feesRead;
  const pools = await poolsRead;
  const creator: CreatorHistory =
    fees && fees.transfers > 0
      ? {
          ...sold,
          data: {
            ...sold.data,
            tokens: sold.data.tokens.map((t) =>
              own(t)
                ? {
                    ...t,
                    feesCollected: true,
                    feesTaken: {
                      ...fees,
                      payers: feePayers(fees.hooks, marketRead.data.pair, pools),
                    },
                  }
                : t,
            ),
          },
        }
      : sold;

  // No listed pair: the launch pool's own trades, counted by the indexer.
  const tokenAnswer = await indexedToken;
  const market = checkLiquidity(
    withPoolActivity(
      pools && pools.length > 0 && marketRead.data.pair !== null
        ? { ...marketRead, data: { ...marketRead.data, pools } }
        : marketRead,
      tokenAnswer.value,
      collectedAt,
      now,
    ),
    pooledNow,
  );
  // A pons token no pair lists trades only where the indexer counts it.
  if (tokenAnswer.failed && market.data.pair === null) {
    failures.push({
      read: 'market',
      note: 'the SEAL indexer did not answer: the launch pool’s trades could not be read this time',
    });
  }

  // The creator, its history and its sales: each read that failed is named.
  if (historyError !== undefined || lookupError !== undefined || originError !== undefined) {
    failures.push({
      read: 'creator',
      note: creator.sources.find((s) => s.note)?.note ?? noteOf(historyError),
    });
  }
  // Every source note that says its read failed is a failed read: the same
  // test the cache applies, so a failed source is never left out (Wheel Smith).
  failures.push(...failedReadsOfSources({ creator, holders: linkedHolders, market }));
  // Without the creator's history, the launch block of a pons token is not
  // known and its first minutes are not read either.
  if (!launchReplay && launchFrom === undefined && historyError !== undefined) {
    failures.push({
      read: 'launch-replay',
      note: 'the first minutes after the launch were not read: the launch block could not be read this time',
    });
  }
  // A sale confirmed anyway (by a trade in the launch's first minutes) stands:
  // the read is still said to be partial, and that the sale was seen.
  const saleSeen = creator.data.tokens.some((t) => own(t) && t.creatorDumped === true);
  const failedReads = mergeFailedReads(
    failures.map((f) =>
      f.read === 'creator-sales' && saleSeen ? { ...f, note: `${f.note}${SALE_SEEN}` } : f,
    ),
  );

  const completeness = combineCompleteness([
    creator.completeness,
    linkedHolders.completeness,
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
    creator,
    holders: linkedHolders,
    market,
    ...(launchReplay ? { launch: launchReplay } : {}),
    completeness,
    ...(failedReads.length > 0 ? { failedReads } : {}),
  };
}

/** One batch of `Initialize` queries, one per 10 M blocks, and a retry. */
const POOL_RULES_BUDGET = 3;

/**
 * The trading rules (hook) of each listed v4 pool: from the indexer's
 * markets first, then from the PoolManager's `Initialize`, by id, over the
 * whole chain. A pool whose `Initialize` could not be read keeps `v4: null`:
 * its rules are unknown, never "none".
 */
export async function readPoolRules(
  rpc: RpcClient,
  pools: readonly ListedPool[],
  indexed: Promise<IndexerMarkets['markets']>,
  latest: number,
  mainPair: string | null,
): Promise<ListedPool[]> {
  const known = new Map<string, NonNullable<ListedPool['v4']>>();
  for (const m of await indexed) {
    known.set(m.id.toLowerCase(), {
      hook: m.hook.toLowerCase(),
      currency0: m.currency0.toLowerCase(),
      currency1: m.currency1.toLowerCase(),
      fee: m.fee,
      tickSpacing: m.tickSpacing,
      blockNumber: m.block,
      transactionHash: m.txHash,
    });
  }
  // The main pool and the pools that weigh beside it; dust pools are not read.
  const listed = { pools: [...pools], pair: mainPair };
  const weighed = new Set(
    [mainPool(listed), ...meaningfulPools(listed)].filter(Boolean).map((p) => p!.id),
  );
  const missing = pools.filter((p) => p.version === 'v4' && weighed.has(p.id) && !known.has(p.id));
  if (missing.length > 0 && latest > 0) {
    // The main pool first: it alone is searched over the whole chain if needed.
    missing.sort((a, b) => Number(b.id === mainPair) - Number(a.id === mainPair));
    const { markets } = await findMarketsById(rpc, missing, latest, {
      fullScanFor: missing[0]?.id === mainPair ? 1 : 0,
    }).catch(() => ({ markets: [] as V4Market[] }));
    for (const m of markets) {
      known.set(m.id, {
        hook: m.hook,
        currency0: m.currency0,
        currency1: m.currency1,
        fee: m.fee,
        tickSpacing: m.tickSpacing,
        blockNumber: m.blockNumber,
        transactionHash: m.transactionHash,
      });
    }
  }
  // A dust pool not read is left without rules, not marked unread.
  return pools.map((p) =>
    p.version !== 'v4'
      ? p
      : known.has(p.id)
        ? { ...p, v4: known.get(p.id)! }
        : weighed.has(p.id)
          ? { ...p, v4: null }
          : p,
  );
}

/**
 * What each contract that paid the creator fees is to this token: the
 * trading rules (hook) of its main pool, of another of its pools, or a
 * launchpad's contract that is neither (MEME: Doppler's 0x4e34… paid fees
 * while its main pool runs no hook).
 */
export function feePayers(
  payers: readonly string[],
  mainPair: string | null,
  pools: readonly ListedPool[] | undefined,
): FeePayer[] {
  const main = mainPair ? pools?.find((p) => p.id === mainPair.toLowerCase())?.v4?.hook : undefined;
  const others = new Set(
    (pools ?? [])
      .filter((p) => p.id !== mainPair?.toLowerCase())
      .map((p) => p.v4?.hook)
      .filter((h): h is string => Boolean(h)),
  );
  return payers.map((address) => {
    const a = address.toLowerCase();
    const launch = LAUNCH_HOOKS.find((h) => h.address === a);
    const role: FeePayer['role'] =
      main === a ? 'main-hook' : launch ? 'launch' : others.has(a) ? 'pool-hook' : 'hook';
    return { address: a, role };
  });
}

/** Requests for the fees read: the creator's incoming transfers, in a few windows, and the supply. */
const FEES_BUDGET = 8;

/**
 * What the market's trading rules (hooks) sent the creator, outside the
 * launch block (where a launchpad hands out allocations): summed, with the
 * number of transfers and the hooks that paid.
 */
export function feesFromHooks(
  logs: readonly RawLog[],
  hooks: readonly string[],
  launchBlock: number,
  supply: bigint,
): { share: number; transfers: number; hooks: string[] } {
  const from = new Set(hooks.map((h) => topicFor(h)));
  let total = 0n;
  let transfers = 0;
  const paid = new Set<string>();
  for (const l of logs) {
    if (l.topics.length !== 3 || !from.has((l.topics[1] ?? '').toLowerCase())) continue;
    if (Number(l.blockNumber) <= launchBlock) continue;
    const raw = l.data.startsWith('0x') ? l.data.slice(2) : l.data;
    if (raw.length < 64) continue;
    const value = BigInt(`0x${raw.slice(0, 64)}`);
    if (value === 0n) continue;
    total += value;
    transfers += 1;
    paid.add(`0x${(l.topics[1] ?? '').slice(26)}`.toLowerCase());
  }
  const share = supply > 0n ? Number((total * 1_000_000n) / supply) / 1_000_000 : 0;
  return { share, transfers, hooks: [...paid] };
}
