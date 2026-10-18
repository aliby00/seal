import { getAddress, isAddress } from 'viem';
import { analysisCache, sourcesFailed, type CachedAnalysis } from './analysis-cache';
import { createRpcClient } from './chain';
import { readTokenMetas } from './chain/facts';
import { collect } from './collect';
import type { TokenReport } from './contracts';
import { toFacts, toTimeline, type ReportFacts, type TimelineLaunch } from './facts';
import { buildGlance, type Glance } from './glance';
import { createBudget, requestJson } from './http';
import { log } from './logger';
import { DEXSCREENER_BASE, ROBINHOOD_SLUG } from './market/dexscreener';
import { SharedCache } from './shared-cache';
import { TtlCache } from './cache';
import { displayName } from './specialists/names';

/**
 * The "In short" of a token, without the written reading: the same collection
 * as a full analysis, summed up by `buildGlance`, and no model call at all.
 * It serves the browser extension's overlay, which asks often and briefly.
 */

export type GlanceResponse = {
  token: string;
  name: string | null;
  symbol: string | null;
  glance: Glance;
  collectedAt: string;
  /** Where the full reading of this token opens on the site. */
  url: string;
  /** True when served from a cache: this request read nothing upstream. */
  cached?: boolean;
};

/** What is cached: everything but the link, which depends on the host that answers. */
export type CachedGlance = Omit<GlanceResponse, 'url' | 'cached'>;

/** Four minutes: the overlay is glanced at, then left; holders and prices move. */
export const GLANCE_TTL_MS = 4 * 60_000;

export const glanceCache = new SharedCache<CachedGlance>({
  prefix: 'seal:glance:v1',
  ttlMs: GLANCE_TTL_MS,
});

/** Collecting gets the same allowance as in /api/analyze. */
export const GLANCE_COLLECT_TIMEOUT_MS = 30_000;

/** A token asked by many overlays at once is collected once. */
const inflight = new Map<string, Promise<CachedGlance>>();

export function deepLink(base: string | URL, token: string): string {
  const url = new URL('/', base);
  url.searchParams.set('token', token);
  url.hash = 'analysis';
  return url.toString();
}

/** From a full analysis already served: no upstream request at all. */
export function fromAnalysis(analysis: CachedAnalysis): CachedGlance | null {
  const glance = buildGlance({
    facts: analysis.facts,
    timeline: analysis.timeline,
    launch: analysis.launch,
    specialists: analysis.specialists,
  });
  if (!glance) return null;
  return {
    token: analysis.token,
    name: analysis.name ?? null,
    symbol: analysis.symbol ?? null,
    glance,
    collectedAt: analysis.collectedAt,
  };
}

function facts(report: TokenReport): ReportFacts | undefined {
  try {
    return toFacts(report);
  } catch (error) {
    log.warn('faits non représentables', { error: String(error) });
    return undefined;
  }
}

function timeline(report: TokenReport): TimelineLaunch[] | undefined {
  try {
    const launches = toTimeline(report);
    return launches.length > 0 ? launches : undefined;
  } catch {
    return undefined;
  }
}

/** Name and symbol as the token states them: two calls, never a failure. */
async function names(token: string): Promise<{ name: string | null; symbol: string | null }> {
  try {
    const rpc = createRpcClient(process.env.RPC_URL || undefined, createBudget(4));
    const meta = (await readTokenMetas(rpc, [token])).get(token.toLowerCase());
    // A token can name itself anything: cleaned, cut, and withheld when it reads as a verdict.
    return { name: displayName(meta?.name), symbol: displayName(meta?.symbol) };
  } catch {
    return { name: null, symbol: null };
  }
}

export class GlanceUnavailableError extends Error {
  constructor() {
    super('too little could be represented');
    this.name = 'GlanceUnavailableError';
  }
}

async function compute(token: string): Promise<CachedGlance> {
  const [report, meta] = await Promise.all([
    Promise.race([
      collect(token, {
        rpcUrl: process.env.RPC_URL || undefined,
        blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY || undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout global')), GLANCE_COLLECT_TIMEOUT_MS),
      ),
    ]),
    names(token),
  ]);
  const glance = buildGlance({
    facts: facts(report),
    timeline: timeline(report),
    launch: report.launch?.data,
  });
  if (!glance) throw new GlanceUnavailableError();
  const body: CachedGlance = {
    token: report.token,
    name: meta.name,
    symbol: meta.symbol,
    glance,
    collectedAt: report.collectedAt,
  };
  const sources = [...report.creator.sources, ...report.holders.sources, ...report.market.sources];
  // A read cut short is worth retrying on the next hover, not repeating for minutes.
  if (!sourcesFailed(sources) && (report.failedReads?.length ?? 0) === 0) {
    await glanceCache.set(token.toLowerCase(), body);
  }
  return body;
}

/**
 * The glance of a token: from the glance cache, then from a cached full
 * analysis, then collected. Throws what `collect` throws.
 */
export async function glanceOf(token: string): Promise<CachedGlance & { cached: boolean }> {
  const key = token.toLowerCase();
  const hit = await glanceCache.get(key);
  if (hit) return { ...hit, cached: true };
  const analysis = await analysisCache.get(key);
  const derived = analysis ? fromAnalysis(analysis) : null;
  if (derived) return { ...derived, cached: true };

  let pending = inflight.get(key);
  if (!pending) {
    pending = compute(token).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return { ...(await pending), cached: false };
}

/** A DexScreener page names a pair (a v2/v3 pool or a v4 pool id), not the token. */
export const PAIR_PATTERN = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

type PairsAnswer = {
  pairs?: { baseToken?: { address?: string } }[] | null;
};

/** Pairs do not change token: an hour is safe, and it spares DexScreener. */
const pairCache = new TtlCache<string | null>({ ttlMs: 60 * 60_000, maxEntries: 500 });

/**
 * The token a DexScreener pair trades, or `null` when the pair is unknown
 * there. A DexScreener URL may also carry the token address itself: the
 * caller falls back to it.
 */
export async function tokenOfPair(pair: string): Promise<string | null> {
  // Checked here too, not only by the route: this value ends up in a URL.
  if (!PAIR_PATTERN.test(pair)) return null;
  const id = pair.toLowerCase();
  const { value } = await pairCache.resolve(id, async () => {
    const answer = await requestJson<PairsAnswer>(
      `${DEXSCREENER_BASE}/latest/dex/pairs/${ROBINHOOD_SLUG}/${encodeURIComponent(id)}`,
      { source: 'dexscreener', timeoutMs: 6_000, retries: 1 },
    );
    const address = answer.pairs?.[0]?.baseToken?.address;
    return address && isAddress(address) ? getAddress(address) : null;
  });
  return value;
}

export function resetGlanceState(): void {
  glanceCache.clear();
  pairCache.clear();
  inflight.clear();
}
