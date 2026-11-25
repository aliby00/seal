import type { SolanaSourceName, SourceRef, Sourced } from '../contracts';
import { NotFoundError, SealError, TimeoutError, UpstreamError } from '../errors';
import { BudgetExhaustedError, requestJson, type RequestBudget } from '../http';
import { isSolanaAddress } from '../solana/address';
import { NATIVE_MINT } from '../solana/programs';
import { readSolanaGraduation } from '../solana/graduation';
import { findLaunchAccount, readSolanaLaunch, type LaunchAccount } from '../solana/launchpads';
import { readSolanaLiquidity } from '../solana/liquidity';
import { abortable, eitherSignal, type SolanaRpc } from '../solana/rpc';
import { solanaTokenPairsUrl, type DexScreenerPair } from './dexscreener';
import { MAX_LISTED_POOLS, MEANINGFUL_POOL_USD, pickPrimaryPair, quietFor } from './index';
import type {
  ListedToken,
  SolanaGraduation,
  SolanaLaunch,
  SolanaLiquidity,
  SolanaListedPool,
  SolanaMarketRead,
  SolanaMarketState,
  SolanaMarketStateData,
} from './solana-types';

/**
 * The market of a Solana token, as DexScreener lists it: price, liquidity,
 * 24 h volume, buys and sells, FDV, and the pools with their venue.
 *
 * Same reading as on Robinhood Chain (index.ts), with three differences:
 * addresses keep their case (base58 is case-sensitive: never lowercased);
 * there is no ETH graduation threshold (a Solana curve is read on chain, by
 * solana/graduation.ts); and the source is cited as `dexscreener-solana`.
 *
 * A pump.fun or Meteora DBC token still on its curve is listed with its curve
 * as the pair (dexId `pumpfun`, `meteoradbc`, `bags`…) and no liquidity
 * figure: DexScreener gives none for a curve (read 24/11/2026).
 */

export type FetchSolanaMarketOptions = {
  budget?: RequestBudget;
  baseUrl?: string;
  now?: () => Date;
  signal?: AbortSignal;
};

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function token(side: DexScreenerPair['baseToken']): ListedToken | null {
  return side?.address ? { address: side.address, symbol: side.symbol ?? null } : null;
}

/** The token's pools, the most liquid first, each with its venue. Exact address match. */
export function solanaListedPools(
  mint: string,
  pairs: readonly DexScreenerPair[],
): SolanaListedPool[] {
  const seen = new Set<string>();
  const pools: SolanaListedPool[] = [];
  for (const pair of pairs) {
    const id = pair.pairAddress ?? '';
    if (!id || seen.has(id)) continue;
    const base = pair.baseToken?.address === mint;
    if (!base && pair.quoteToken?.address !== mint) continue;
    seen.add(id);
    pools.push({
      id,
      version: null,
      base,
      liquidityUsd: num(pair.liquidity?.usd),
      volume24hUsd: num(pair.volume?.h24),
      createdAt: num(pair.pairCreatedAt),
      dex: pair.dexId ?? 'unknown',
      labels: [...(pair.labels ?? [])],
      pairedWith: token(base ? pair.quoteToken : pair.baseToken),
    });
  }
  return pools
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, MAX_LISTED_POOLS);
}

/**
 * Quote assets whose pairs give the main price: wrapped SOL and the two
 * dollar stablecoins. Checked on mainnet on 25/11/2026 (mint account and
 * Metaplex metadata): USDC EPjFWdd5… "USD Coin" / USDC, USDT Es9vMFrz… "USDT"
 * / USDT, both SPL Token, 6 decimals.
 *
 * DexScreener prices a pair through its quote token. Against a thin or
 * mispriced quote token, a pair can show a liquidity and a price far from the
 * token's market: B34nXKzC… (FIONA) had a $4.5M "liquidity" pair against
 * Milk Money (MM, Ax8PSfCX…) pricing it at $35.05 (FDV $34.6B) while its
 * $195k PumpSwap pool against SOL and every other pair priced it near $0.0033
 * (read 25/11/2026). The main pair is taken among the pairs against these
 * assets first.
 */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const REFERENCE_QUOTES: ReadonlySet<string> = new Set([NATIVE_MINT, USDC_MINT, USDT_MINT]);

/**
 * The main pair, where the token is the base: the most liquid one against
 * SOL, USDC or USDT holding at least MEANINGFUL_POOL_USD (a dust pool anyone
 * can open is not the market); when there is none, the most liquid one
 * against any token. A curve has no liquidity figure; when no pair has one,
 * the first listed is taken (DexScreener lists a curve token's curve first).
 */
export function pickSolanaPair(
  mint: string,
  pairs: readonly DexScreenerPair[],
): DexScreenerPair | undefined {
  const own = pairs.filter((p) => p.baseToken?.address === mint && p.pairAddress);
  const liquid = own.filter((p) => num(p.liquidity?.usd) !== null);
  const reference = liquid.filter(
    (p) =>
      REFERENCE_QUOTES.has(p.quoteToken?.address ?? '') &&
      (num(p.liquidity?.usd) ?? 0) >= MEANINGFUL_POOL_USD,
  );
  if (reference.length > 0) return pickPrimaryPair(reference);
  return pickPrimaryPair(liquid.length > 0 ? liquid : own.slice(0, 1));
}

function txns(source: DexScreenerPair['txns'], window: string) {
  const entry = source?.[window];
  return { buys: entry?.buys ?? 0, sells: entry?.sells ?? 0 };
}

export function toSolanaMarketState(
  mint: string,
  pairs: readonly DexScreenerPair[],
  options: Pick<FetchSolanaMarketOptions, 'now'> = {},
): SolanaMarketState {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const pair = pickSolanaPair(mint, pairs);
  const pools = solanaListedPools(mint, pairs);

  if (!pair) {
    return {
      completeness: 'unavailable',
      sources: [
        {
          name: 'dexscreener-solana',
          fetchedAt,
          note:
            pools.length > 0
              ? 'listed only in pairs where the token is the quote side: no price of its own'
              : 'no pair indexed by DexScreener for this token',
        },
      ],
      data: {
        chain: 'solana',
        token: mint,
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
        pools,
      },
    };
  }

  const liquidityBase = num(pair.liquidity?.base);
  const data: SolanaMarketStateData = {
    chain: 'solana',
    token: mint,
    pair: pair.pairAddress ?? null,
    dex: pair.dexId ?? null,
    pairedWith: token(pair.quoteToken),
    priceUsd: num(pair.priceUsd),
    priceNative: num(pair.priceNative),
    liquidityUsd: num(pair.liquidity?.usd),
    ...(liquidityBase !== null ? { liquidityBase } : {}),
    volumeUsd: pair.volume
      ? {
          m5: pair.volume.m5 ?? 0,
          h1: pair.volume.h1 ?? 0,
          h6: pair.volume.h6 ?? 0,
          h24: pair.volume.h24 ?? 0,
        }
      : null,
    txns: pair.txns ? { h1: txns(pair.txns, 'h1'), h24: txns(pair.txns, 'h24') } : null,
    fdvUsd: num(pair.fdv),
    marketCapUsd: num(pair.marketCap),
    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
    ...(pair.txns ? { quiet: quietFor(pair.txns) } : {}),
    pools,
  };

  const missing = [
    data.priceUsd === null ? 'price' : null,
    data.liquidityUsd === null ? 'liquidity' : null,
  ].filter((x): x is string => x !== null);
  const quote = pair.quoteToken?.address;
  const notes = [
    missing.length === 0
      ? null
      : missing.length === 1 && missing[0] === 'liquidity'
        ? `DexScreener gives no liquidity figure for the main pair (${data.dex ?? 'unknown venue'})`
        : `${missing.join(' and ')} missing from the response`,
    quote && !REFERENCE_QUOTES.has(quote)
      ? `the main pair trades against ${pair.quoteToken?.symbol ?? quote}, not SOL, USDC or USDT: its USD figures go through that token's price`
      : null,
  ].filter((n): n is string => n !== null);
  return {
    completeness: missing.length === 0 ? 'full' : 'partial',
    sources: [
      {
        name: 'dexscreener-solana',
        fetchedAt,
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      },
    ],
    data,
  };
}

/** The token's pairs on Solana as DexScreener lists them. Throws only when the source is plainly broken. */
export async function fetchSolanaPairs(
  mint: string,
  options: Pick<FetchSolanaMarketOptions, 'budget' | 'baseUrl' | 'signal'> = {},
): Promise<DexScreenerPair[]> {
  if (!isSolanaAddress(mint)) {
    throw new UpstreamError('dexscreener-solana', 'not a Solana address');
  }
  const body = await requestJson<unknown>(solanaTokenPairsUrl(mint, options.baseUrl), {
    source: 'dexscreener-solana',
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.signal ? { init: { signal: options.signal } } : {}),
  });
  if (body === null) throw new NotFoundError('dexscreener-solana', `token ${mint}`);
  if (!Array.isArray(body)) {
    throw new UpstreamError('dexscreener-solana', 'unexpected response: expected an array');
  }
  // Pairs of another chain would carry another chain's prices.
  return (body as DexScreenerPair[]).filter((p) => !p.chainId || p.chainId === 'solana');
}

export async function fetchSolanaMarketState(
  mint: string,
  options: FetchSolanaMarketOptions = {},
): Promise<SolanaMarketState> {
  return toSolanaMarketState(mint, await fetchSolanaPairs(mint, options), options);
}

// ── The whole zone ──────────────────────────────────────────────────────────

/** Time the zone may take, all reads included: one analysis must stay near 30 s across zones. */
export const SOLANA_MARKET_DEADLINE_MS = 12_000;

/**
 * Solana calls the zone needs at most: 1 for the launch accounts, 2 program
 * scans when none is found, 1 to 3 for the graduation, then the pools, their
 * LP mints and lock accounts, and per pool its positions or largest holders.
 * The recorded reads took 2 to 8. Give the zone's client this allowance
 * (createSolanaRpc({ maxCalls })).
 */
export const SOLANA_MARKET_MAX_CALLS = 14;

/** Rejects once `ms` have passed: the reads still running are then reported unavailable. */
function withDeadline<T>(
  work: Promise<T>,
  deadline: number,
  source: SolanaSourceName = 'solana-rpc',
): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) {
    // Already late: its calls are cut too, and its failure is not waited for.
    work.catch(() => undefined);
    return Promise.reject(new TimeoutError(source, 0));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(source, left)), left);
    }),
  ]).finally(() => clearTimeout(timer));
}

function failed<T>(
  name: SourceRef['name'],
  fetchedAt: string,
  error: unknown,
  data: T,
  note?: string,
): Sourced<T> {
  const reason =
    note ??
    (error instanceof SealError || error instanceof BudgetExhaustedError
      ? error.message
      : 'unexpected error');
  return { completeness: 'unavailable', sources: [{ name, fetchedAt, note: reason }], data };
}

export type ReadSolanaMarketOptions = {
  /** The read's Solana client: its call allowance caps the zone (createSolanaRpc({ maxCalls })). */
  rpc: SolanaRpc;
  /** DexScreener's allowance. */
  budget?: RequestBudget;
  baseUrl?: string;
  now?: () => Date;
  /** Milliseconds the zone may take; SOLANA_MARKET_DEADLINE_MS when omitted. */
  deadlineMs?: number;
  /** Pools whose liquidity is read; MAX_LIQUIDITY_POOLS when omitted. */
  maxPools?: number;
  /** Cuts the whole zone (the analysis running out of time). */
  signal?: AbortSignal;
};

/**
 * The market zone of a Solana token: DexScreener's listing, then on chain
 * the launchpad, its graduation, and the liquidity of the main pools (the
 * pool the token graduated to first). A part that fails or runs out of time
 * is reported unavailable with the reason; the others stand.
 */
export async function readSolanaMarket(
  mint: string,
  options: ReadSolanaMarketOptions,
): Promise<SolanaMarketRead> {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const deadline = started + (options.deadlineMs ?? SOLANA_MARKET_DEADLINE_MS);
  const at = () => now().toISOString();

  if (!isSolanaAddress(mint)) {
    // Nothing to ask anyone: no request, no call.
    const note = 'not a Solana address';
    return {
      market: failed(
        'dexscreener-solana',
        at(),
        null,
        toSolanaMarketState(mint, [], { now }).data,
        note,
      ),
      launch: failed(
        'solana-rpc',
        at(),
        null,
        { mint, launchpad: null, account: null, foundBy: null },
        note,
      ),
      graduation: null,
      liquidity: failed('solana-rpc', at(), null, { mint, pools: [] }, note),
    };
  }

  // At the zone's deadline its requests in flight are aborted, DexScreener's
  // and the node's, not only left behind.
  const cut = new AbortController();
  const timer = setTimeout(
    () => cut.abort(new TimeoutError('solana-rpc', deadline - started)),
    Math.max(0, deadline - Date.now()),
  );
  const signal = eitherSignal(cut.signal, options.signal) as AbortSignal;
  const rpc = abortable(options.rpc, signal);
  try {
    return await readZone(mint, { ...options, rpc, signal }, deadline, at, now);
  } finally {
    clearTimeout(timer);
  }
}

async function readZone(
  mint: string,
  options: ReadSolanaMarketOptions & { signal: AbortSignal },
  deadline: number,
  at: () => string,
  now: () => Date,
): Promise<SolanaMarketRead> {
  const { rpc } = options;
  let market: SolanaMarketState;
  try {
    const pairs = await withDeadline(
      fetchSolanaPairs(mint, {
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        signal: options.signal,
      }),
      deadline,
      'dexscreener-solana',
    );
    market = toSolanaMarketState(mint, pairs, { now });
  } catch (error) {
    market = failed('dexscreener-solana', at(), error, toSolanaMarketState(mint, [], { now }).data);
  }
  const pools = market.data.pools;

  let found: LaunchAccount | null = null;
  let launch: SolanaLaunch;
  try {
    found = await withDeadline(
      findLaunchAccount(rpc, mint, { hints: pools.map((p) => p.id) }),
      deadline,
    );
    launch = await readSolanaLaunch(rpc, mint, { found, now });
  } catch (error) {
    launch = failed('solana-rpc', at(), error, {
      mint,
      launchpad: null,
      account: null,
      foundBy: null,
    });
  }

  let graduation: SolanaGraduation | null = null;
  if (found) {
    try {
      graduation = await withDeadline(
        readSolanaGraduation(rpc, mint, { launch: found, now }),
        deadline,
      );
    } catch (error) {
      graduation = failed('solana-rpc', at(), error, {
        mint,
        launchpad: found.launchpad,
        account: found.address,
        graduated: null,
        progress: null,
        progressBasis: null,
        raised: null,
        target: null,
        destination: null,
        creator: null,
      });
    }
  }

  // The pool the token graduated to first, then the most liquid listed pools
  // where it is the base; the launch curve is not a pool, and a pair where the
  // token is only the quote (another token's launch, as FIONA's PumpSwap
  // pairs of other pump.fun coins) says nothing of this token's liquidity.
  const listed = pools.filter((p) => p.base && p.id !== found?.address).map((p) => p.id);
  const destination = graduation?.data.destination?.pool;
  const wanted = [...new Set([...(destination ? [destination] : []), ...listed])];
  let liquidity: SolanaLiquidity;
  try {
    liquidity = await withDeadline(
      readSolanaLiquidity(rpc, mint, wanted, {
        now,
        ...(options.maxPools !== undefined ? { maxPools: options.maxPools } : {}),
      }),
      deadline,
    );
  } catch (error) {
    liquidity = failed('solana-rpc', at(), error, { mint, pools: [] });
  }

  return { market, launch, graduation, liquidity };
}
