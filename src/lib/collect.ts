import { combineCompleteness, type Completeness, type SourceRef, type Sourced } from './contracts';
import type { FailedRead, ReadId, TokenReport } from './contracts/report';
import { NotFoundError, NotFungibleError, SealError, TimeoutError } from './errors';
import { failedReadOf, mergeFailedReads } from './failed-reads';
import { BudgetExhaustedError, createBudget, requestJson } from './http';
import { log } from './logger';
import { readSolanaMarket, SOLANA_MARKET_DEADLINE_MS } from './market/solana';
import type { SolanaMarketRead } from './market/solana-types';
import { isSolanaAddress } from './solana/address';
import {
  creatorHistory,
  creatorOnToken,
  findCreator,
  withLaunchCreation,
  type DexFetch,
} from './solana/creator';
import type {
  SolanaCreator,
  SolanaCreatorHistory,
  SolanaCreatorOnToken,
  SolanaLinkedWallets,
} from './solana/creator-types';
import { linkedWallets } from './solana/funding';
import { readHolders, type SolanaHolders } from './solana/holders';
import { replayLaunch } from './solana/launch';
import type { SolanaLaunchReplay } from './solana/launch-types';
import { abortable, createSolanaRpc, type SolanaRpc, type SolanaRpcClient } from './solana/rpc';
import { readToken, tokenPowers, TOKEN_READ_TIMEOUT_MS } from './solana/token';
import type { TokenRead } from './solana/token-types';

/**
 * Orchestrator of the data pipeline, for a Solana token.
 *
 * 1. At once, in parallel: the mint (readToken), the market zone (DexScreener,
 *    then the launchpad, its graduation and the pools' liquidity), and the
 *    creator (findCreator, which needs nothing from the other two).
 * 2. Once the creator and the mint are known, in parallel: the holders (with
 *    the creator's own balance), the launch replay (with the creator, its
 *    creation transaction and time), the creator's other tokens, what it did
 *    with this one, and the wallets linked to it by SOL transfers.
 *
 * No block can make another fail: a reader that fails, runs out of calls or
 * of time leaves its block `unavailable` or `partial` with the reason, and
 * the reads that failed are listed in `failedReads`. One Solana client serves
 * the whole analysis, with a global ceiling of calls; each reader adds its
 * own cap and time limit, and every limit aborts the requests in flight
 * (rpc.ts, `withSignal`). The whole collection aims at about 30 s.
 */

/** Calls one analysis may spend on the Solana node, every reader together. */
export const SOLANA_MAX_CALLS = 300;
/** DexScreener requests of one analysis: the token's pairs, and the creator's other tokens. */
export const DEX_BUDGET = 8;
/** From the start, the collection is cut here: the route answers at 30 s. */
export const COLLECT_DEADLINE_MS = 27_000;
/** The creator lookup. */
export const CREATOR_CALLS = 30;
export const CREATOR_TIMEOUT_MS = 10_000;
/** Each of the creator's three later reads (its other tokens, this token, linked wallets). */
export const CREATOR_READ_CALLS = 50;
export const CREATOR_READ_TIMEOUT_MS = 12_000;
/** The holders. */
export const HOLDERS_CALLS = 20;
export const HOLDERS_TIMEOUT_MS = 12_000;
/** The launch replay. */
export const LAUNCH_CALLS = 90;
export const LAUNCH_TIMEOUT_MS = 20_000;
/** Kept before the collection's deadline, for the reads to wind up and the report to be built. */
const WIND_UP_MS = 1_000;

/** Each reader's time limit, in ms; every one is also cut at the collection's deadline. */
export type CollectTimeouts = {
  mint: number;
  market: number;
  creator: number;
  creatorReads: number;
  holders: number;
  launch: number;
};

export const COLLECT_TIMEOUTS: CollectTimeouts = {
  mint: TOKEN_READ_TIMEOUT_MS,
  market: SOLANA_MARKET_DEADLINE_MS,
  creator: CREATOR_TIMEOUT_MS,
  creatorReads: CREATOR_READ_TIMEOUT_MS,
  holders: HOLDERS_TIMEOUT_MS,
  launch: LAUNCH_TIMEOUT_MS,
};

export type CollectOptions = {
  /**
   * The Solana client. Created here otherwise: one per analysis, capped at
   * `maxCalls` (SOLANA_MAX_CALLS). The tests hand the fake node.
   */
  rpc?: SolanaRpc;
  /** The global ceiling of Solana calls, when the client is created here. */
  maxCalls?: number;
  /** DexScreener's base URL (tests). */
  dexBaseUrl?: string;
  now?: () => Date;
  /** Cuts the whole collection: the route giving up. */
  signal?: AbortSignal;
  /** From the start, when every read still running is cut (COLLECT_DEADLINE_MS). */
  deadlineMs?: number;
  /**
   * The readers' own time limits (COLLECT_TIMEOUTS). Recording fixtures and
   * replaying them set them long, so that only the call caps, which do not
   * depend on the node's speed, end a read.
   */
  timeouts?: Partial<CollectTimeouts>;
  /**
   * Filled as the collection goes: the stages reached, in ms since the
   * start. The route logs it when it cuts a collection at 30 s.
   */
  progress?: { stages: Record<string, number>; reads?: Record<string, number> };
};

/** `promise`; a failure it did not absorb itself becomes `fallback(error)`. */
async function settled<T>(promise: Promise<T>, fallback: (error: unknown) => T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    return fallback(error);
  }
}

/** An error, as a source note: its kind first, so `noteFailed` tells a failure. */
function reasonOf(error: unknown): string {
  if (error instanceof SealError) return `${error.kind} : ${error.message}`;
  if (error instanceof BudgetExhaustedError) return error.message;
  return 'unexpected error';
}

function unavailable<T>(
  name: SourceRef['name'],
  fetchedAt: string,
  error: unknown,
  data: T,
): Sourced<T> {
  const note = reasonOf(error);
  log.warn('lecture Solana en échec', { source: name, note, error: String(error) });
  return { completeness: 'unavailable', sources: [{ name, fetchedAt, note }], data };
}

/** Unix seconds of an ISO date or of milliseconds; `null` when there is none. */
function seconds(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * When the token was created, by DexScreener: its earliest listed pool (a
 * pump.fun token's first pool is its curve, created with it). The replay
 * checks it on chain; it only says where to look.
 */
function listedSince(read: SolanaMarketRead): number | null {
  const times = read.market.data.pools
    .map((p) => p.createdAt)
    .filter((t): t is number => typeof t === 'number' && t > 0);
  if (times.length > 0) return seconds(Math.min(...times));
  return seconds(read.market.data.pairCreatedAt);
}

/** An NFT's mint: no decimals and a supply of exactly one unit. */
export function isNftMint(
  data: { decimals: number | null; supply: string | null } | null | undefined,
): boolean {
  return data?.decimals === 0 && data.supply === '1';
}

/** Collects every block of facts for a Solana token. No aggregate: the agent crosses them. */
export async function collect(token: string, options: CollectOptions = {}): Promise<TokenReport> {
  if (!isSolanaAddress(token)) {
    throw new NotFoundError('solana-rpc', `invalid address: ${String(token).slice(0, 64)}`);
  }
  const now = options.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const collectedAt = now().toISOString();
  const startedAt = Date.now();
  const deadline = startedAt + (options.deadlineMs ?? COLLECT_DEADLINE_MS);
  const timeouts = { ...COLLECT_TIMEOUTS, ...options.timeouts };
  const left = (cap: number) => Math.max(0, Math.min(cap, deadline - WIND_UP_MS - Date.now()));
  const stages: Record<string, number> = options.progress?.stages ?? {};
  const stage = (name: string) => {
    stages[name] = Date.now() - startedAt;
  };

  // The whole collection's own cut: at its deadline, or when the caller gives up.
  const cut = new AbortController();
  const timer = setTimeout(
    () => cut.abort(new TimeoutError('solana-rpc', deadline - startedAt)),
    Math.max(0, deadline - Date.now()),
  );
  const onCallerAbort = () => cut.abort(new TimeoutError('solana-rpc', Date.now() - startedAt));
  if (options.signal?.aborted) onCallerAbort();
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const client: SolanaRpc =
      options.rpc ??
      createSolanaRpc({ maxCalls: options.maxCalls ?? SOLANA_MAX_CALLS, signal: cut.signal });
    const rpc = abortable(client, cut.signal);
    const dexBudget = createBudget(DEX_BUDGET);
    const dex: DexFetch = (url) =>
      requestJson<unknown>(url, {
        source: 'dexscreener-solana',
        timeoutMs: 6_000,
        retries: 1,
        budget: dexBudget,
        init: { signal: cut.signal },
      });

    // ── 1. Mint, market zone and creator, at once ─────────────────────────
    const mintRead: Promise<TokenRead> = settled(
      readToken(token, rpc, { now, timeoutMs: left(timeouts.mint) }),
      (error) => unavailable('solana-rpc', collectedAt, error, null),
    ).finally(() => stage('mint'));

    const marketRead: Promise<SolanaMarketRead> = settled(
      readSolanaMarket(token, {
        rpc,
        budget: dexBudget,
        now,
        deadlineMs: left(timeouts.market),
        signal: cut.signal,
        ...(options.dexBaseUrl ? { baseUrl: options.dexBaseUrl } : {}),
      }),
      (error) => ({
        market: unavailable('dexscreener-solana', collectedAt, error, emptyMarket(token)),
        launch: unavailable('solana-rpc', collectedAt, error, {
          mint: token,
          launchpad: null,
          account: null,
          foundBy: null,
        }),
        graduation: null,
        liquidity: unavailable('solana-rpc', collectedAt, error, { mint: token, pools: [] }),
      }),
    ).finally(() => stage('market'));

    const creatorRead: Promise<SolanaCreator> = settled(
      findCreator(token, rpc, {
        maxCalls: CREATOR_CALLS,
        timeoutMs: left(timeouts.creator),
        now: nowMs,
      }),
      (error) =>
        unavailable('solana-rpc', collectedAt, error, {
          mint: token,
          creator: null,
          from: null,
          account: null,
          creation: null,
          pumpCurve: null,
        }),
    ).finally(() => stage('creator'));

    const mint = await mintRead;
    // An address that holds no mint is not a token: nothing else is worth reading.
    if (mint.completeness === 'full' && mint.data === null) {
      cut.abort(new NotFoundError('solana-rpc', 'token mint'));
      throw new NotFoundError('solana-rpc', `token mint at ${token}`);
    }
    // An NFT is a mint too, of one indivisible unit: read as a token, its one
    // holder "holds 100%" (FCXErX…, prod audit 26/11/2026). Refused before any
    // other read, and before any model call.
    if (isNftMint(mint.data)) {
      cut.abort(new NotFungibleError('solana-rpc', token));
      throw new NotFungibleError('solana-rpc', token);
    }
    const creator = await creatorRead;
    const creatorAddress = creator.data.creator;
    const creation = creator.data.creation;

    // ── 2. What needs the creator ─────────────────────────────────────────
    const holdersRead: Promise<SolanaHolders> = settled(
      readHolders(token, rpc, {
        ...(mint.data
          ? {
              mint: {
                program: mint.data.program,
                decimals: mint.data.decimals,
                supply: mint.data.supply,
              },
            }
          : {}),
        ...(creatorAddress ? { creator: creatorAddress } : {}),
        maxCalls: HOLDERS_CALLS,
        timeoutMs: left(timeouts.holders),
        now,
      }),
      (error) => unavailable('solana-rpc', collectedAt, error, emptyHolders(token)),
    ).finally(() => stage('holders'));

    const launchRead: Promise<SolanaLaunchReplay> = (async () => {
      // The creation time says where to look when the creation itself was
      // not reached: the creator's read gives it, else DexScreener's pools.
      const createdAt = creation?.blockTime ?? listedSince(await marketRead);
      return replayLaunch(token, rpc, {
        creator: creatorAddress,
        ...(creation ? { creationSignature: creation.signature } : {}),
        ...(createdAt !== null ? { createdAt } : {}),
        maxCalls: LAUNCH_CALLS,
        deadlineMs: left(timeouts.launch),
        now: nowMs,
      });
    })();
    const launch = settled(launchRead, (error) =>
      unavailable('solana-rpc', collectedAt, error, emptyLaunch(token)),
    ).finally(() => stage('launch'));

    const limits = () => ({
      maxCalls: CREATOR_READ_CALLS,
      timeoutMs: left(timeouts.creatorReads),
      now: nowMs,
    });
    const historyRead: Promise<SolanaCreatorHistory | null> = creatorAddress
      ? settled(
          creatorHistory(creatorAddress, rpc, { ...limits(), exclude: token, dex }),
          (error) => unavailable('solana-rpc', collectedAt, error, emptyHistory(creatorAddress)),
        ).finally(() => stage('creator-history'))
      : Promise.resolve(null);
    const onTokenRead: Promise<SolanaCreatorOnToken | null> = creatorAddress
      ? settled(creatorOnToken(creatorAddress, token, rpc, limits()), (error) =>
          unavailable('solana-rpc', collectedAt, error, emptyOnToken(creatorAddress, token)),
        ).finally(() => stage('creator-on-token'))
      : Promise.resolve(null);
    const linkedRead: Promise<SolanaLinkedWallets | null> = creatorAddress
      ? settled(
          linkedWallets(creatorAddress, token, rpc, {
            ...limits(),
            // The creator's read gives the launch time, else the creation the
            // launch replay finds: its own read of the mint stopped where the
            // creator's did. BONK on prod (25/11/2026) said "launch time
            // unknown: … its creation was not reached" in the linked wallets
            // and their question, beside the creation the replay showed.
            launchTime:
              creation?.blockTime || launch.then((r) => unixTime(r.data.creation?.launchedAt)),
          }),
          (error) =>
            unavailable('solana-rpc', collectedAt, error, {
              creator: creatorAddress,
              mint: token,
              firstFunding: null,
              funding: 'not-reached' as const,
              window: null,
              funded: [],
            }),
        ).finally(() => stage('linked-wallets'))
      : Promise.resolve(null);

    const [market, holders, launchReplay, history, onToken, linked] = await Promise.all([
      marketRead,
      holdersRead,
      launch,
      historyRead,
      onTokenRead,
      linkedRead,
    ]);
    // The creation the launch replay found, when the creator's read did not
    // reach it: the creator block says so wherever it is read (the facts,
    // "Sources & limitations", the questions), no longer "not reached".
    const creatorFound = withLaunchCreation(creator, launchReplay.data.creation);

    const failedReads = mergeFailedReads(
      (
        [
          ['token', mint],
          ['creator', creatorFound],
          ['creator-launches', history],
          ['creator-sales', onToken],
          ['linked-wallets', linked],
          ['holders', holders],
          ['market', market.market],
          ['graduation', market.launch],
          ['graduation', market.graduation],
          ['liquidity', market.liquidity],
          ['launch-replay', launchReplay],
        ] as [ReadId, Parameters<typeof failedReadOf>[1]][]
      )
        .map(([read, block]) => failedReadOf(read, block))
        .filter((f): f is FailedRead => f !== null),
    );

    const completeness: Completeness = combineCompleteness([
      mint.completeness,
      creatorFound.completeness,
      holders.completeness,
      marketCompleteness(market),
    ]);

    log.info('analyse collectée', {
      token,
      completeness,
      ms: Date.now() - startedAt,
      stages,
      calls: (client as Partial<SolanaRpcClient>).usage?.(),
      dex: dexBudget.spent,
      failed: failedReads.map((f) => f.read),
    });

    return {
      chain: 'solana',
      token,
      collectedAt,
      mint,
      powers: mint.data ? tokenPowers(mint.data) : [],
      creator: creatorFound,
      creatorHistory: history,
      creatorOnToken: onToken,
      linkedWallets: linked,
      holders,
      market: market.market,
      launchpad: market.launch,
      graduation: market.graduation,
      liquidity: market.liquidity,
      launch: launchReplay,
      completeness,
      ...(failedReads.length > 0 ? { failedReads } : {}),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
    // Every block is settled: a request a reader left behind when its own cap
    // fired is no longer wanted. Clearing the deadline's timer alone left it
    // running (until fetch's own 15 s timeout) once the report was out.
    if (!cut.signal.aborted) {
      cut.abort(new TimeoutError('solana-rpc', Date.now() - startedAt));
    }
  }
}

/** Unix seconds of an ISO time; `null` when there is none. */
export function unixTime(iso: string | null | undefined): number | null {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The market's part in the report's completeness. DexScreener never gives a
 * liquidity figure for a pair that is still a launchpad curve (pump.fun,
 * Meteora DBC, LaunchLab): every young token would be partial for it. When
 * the main pair is the very curve SEAL read on chain, still on it, with what
 * it holds, the liquidity is known and that gap alone does not make the
 * market partial. Any other gap still does.
 */
export function marketCompleteness(
  read: Pick<SolanaMarketRead, 'market' | 'launch' | 'graduation'>,
): Completeness {
  const { market, launch, graduation } = read;
  if (market.completeness !== 'partial') return market.completeness;
  const onlyLiquidityMissing = market.data.priceUsd !== null && market.data.liquidityUsd === null;
  const pair = market.data.pair;
  const curveRead =
    pair !== null &&
    launch.data.account === pair &&
    graduation !== null &&
    graduation.completeness === 'full' &&
    graduation.data.account === pair &&
    graduation.data.graduated === false &&
    graduation.data.raised !== null;
  return onlyLiquidityMissing && curveRead ? 'full' : 'partial';
}

// ── Empty blocks, for a reader that failed outright ─────────────────────────

function emptyMarket(token: string): SolanaMarketRead['market']['data'] {
  return {
    chain: 'solana',
    token,
    pair: null,
    dex: null,
    pairedWith: null,
    priceUsd: null,
    priceNative: null,
    liquidityUsd: null,
    volumeUsd: null,
    txns: null,
    fdvUsd: null,
    marketCapUsd: null,
    pairCreatedAt: null,
    pools: [],
  };
}

function emptyHolders(token: string): SolanaHolders['data'] {
  return {
    token,
    chain: 'solana',
    program: null,
    decimals: 0,
    supply: '0',
    method: 'none',
    accountsRead: 0,
    countedSupply: '0',
    holderCount: null,
    holdersAtLeast: 0,
    top: [],
    concentration: { top1: 0, top10: 0 },
    pooledShare: null,
    setAside: [],
    distinctTraders: null,
    ofSupply: {
      largestWallet: null,
      top10Wallets: null,
      pools: null,
      curves: null,
      burned: null,
      locked: null,
    },
  };
}

function emptyLaunch(token: string): SolanaLaunchReplay['data'] {
  return {
    chain: 'solana',
    token,
    tokenProgram: null,
    decimals: null,
    supply: null,
    creation: null,
    launchBlock: null,
    launchedAt: null,
    windowSeconds: 0,
    windowSlots: 0,
    moves: [],
    movesInWindow: 0,
    summary: null,
    sameSlot: null,
    payerGroup: null,
    roundTrips: [],
    transactions: {
      wanted: 0,
      read: 0,
      failed: 0,
      withoutChange: 0,
      beyond: 0,
      wholeHistory: false,
    },
    calls: 0,
    story: [],
  };
}

function emptyHistory(creator: string): SolanaCreatorHistory['data'] {
  return {
    creator,
    tokens: [],
    counts: { launched: 0, graduated: 0, dead: 0, active: 0, unknown: 0 },
    scanned: {
      pumpCurvesListed: false,
      curvesWithoutMint: 0,
      signatures: 0,
      signaturesComplete: false,
      transactionsListed: 0,
      transactionsRead: 0,
      readSince: null,
    },
  };
}

function emptyOnToken(creator: string, mint: string): SolanaCreatorOnToken['data'] {
  return {
    wallet: creator,
    mint,
    bought: '0',
    sold: '0',
    received: '0',
    burned: '0',
    locked: '0',
    unlocked: '0',
    solSpent: '0',
    solReceived: '0',
    holdsNow: null,
    holdsNowShare: null,
    moves: [],
    accountsRead: [],
    transactions: { listed: 0, read: 0 },
    supply: null,
    decimals: null,
    sends: { recipients: [], distinct: 0, burned: '0', total: '0' },
  };
}
