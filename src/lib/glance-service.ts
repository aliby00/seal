import { analysisCache, sourcesFailed, type CachedAnalysis } from './analysis-cache';
import { collect } from './collect';
import type { TokenReport } from './contracts';
import { launchView, toFacts, toTimeline, type ReportFacts, type TimelineLaunch } from './facts';
import { buildGlance, type Glance } from './glance';
import { requestJson } from './http';
import { log } from './logger';
import { solanaPairsUrl } from './market/dexscreener';
import { isSolanaAddress } from './solana/address';
import { SharedCache } from './shared-cache';
import { TtlCache } from './cache';
import { answerAll } from './specialists/brief';
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

/**
 * The prefixes name the chain: `sol1` entries hold Solana readings only, so
 * a reading of the chain read before, cached under the old prefixes, is
 * never served.
 */
export const glanceCache = new SharedCache<CachedGlance>({
  prefix: 'seal:glance:sol1',
  ttlMs: GLANCE_TTL_MS,
});

/**
 * What a shared reading's card shows (/api/card): the last summary served for
 * a token, partial or not. The page the sharer saw is what the card repeats;
 * a partial report is never reused as an answer, only as this picture of it.
 */
export const CARD_TTL_MS = 30 * 60_000;

export const cardCache = new SharedCache<CachedGlance>({
  prefix: 'seal:card:sol1',
  ttlMs: CARD_TTL_MS,
});

/** Keeps the summary of an analysis just served, for its share card. Never throws. */
export async function rememberCard(analysis: CachedAnalysis): Promise<void> {
  try {
    const card = fromAnalysis(analysis);
    if (card) await cardCache.set(analysis.token, card);
  } catch (error) {
    log.warn('carte non gardée', { error: String(error) });
  }
}

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

/** Name and symbol as the mint's metadata states them: read with the mint, no extra call. */
export function namesOf(report: TokenReport): { name: string | null; symbol: string | null } {
  const meta = report.mint.data?.metadata;
  // A token can name itself anything: cleaned, cut, and withheld when it reads as a verdict.
  return { name: displayName(meta?.name), symbol: displayName(meta?.symbol) };
}

export class GlanceUnavailableError extends Error {
  constructor() {
    super('too little could be represented');
    this.name = 'GlanceUnavailableError';
  }
}

async function compute(token: string): Promise<CachedGlance> {
  const giveUp = AbortSignal.timeout(GLANCE_COLLECT_TIMEOUT_MS);
  const report = await Promise.race([
    collect(token, { signal: giveUp }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout global')), GLANCE_COLLECT_TIMEOUT_MS),
    ),
  ]);
  const meta = namesOf(report);
  const launch = launchView(report.launch);
  // The questions read the report alone and call no model: their measures
  // (the mint's powers, the creator's part, launch groups, the curve) feed
  // the summary's first lines here as on the report page.
  const specialists = answerAll({ token, report, creator: report.creator.data.creator });
  const glance = buildGlance({
    facts: facts(report),
    timeline: timeline(report),
    ...(launch ? { launch } : {}),
    specialists,
  });
  if (!glance) throw new GlanceUnavailableError();
  const body: CachedGlance = {
    token: report.token,
    name: meta.name,
    symbol: meta.symbol,
    glance,
    collectedAt: report.collectedAt,
  };
  await cardCache.set(token, body).catch(() => undefined);
  const sources = [
    ...report.mint.sources,
    ...report.creator.sources,
    ...report.holders.sources,
    ...report.market.sources,
  ];
  // A read cut short is worth retrying on the next hover, not repeating for minutes.
  if (!sourcesFailed(sources) && (report.failedReads?.length ?? 0) === 0) {
    await glanceCache.set(token, body);
  }
  return body;
}

/**
 * The glance of a token: from the glance cache, then from a cached full
 * analysis, then collected. Throws what `collect` throws.
 */
export async function glanceOf(token: string): Promise<CachedGlance & { cached: boolean }> {
  // Solana addresses are case-sensitive: the key is the address as given.
  const key = token;
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

/** A DexScreener page names a pair (a pool account), not the token: a Solana address too. */
export function isPairAddress(pair: string): boolean {
  return isSolanaAddress(pair);
}

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
  if (!isPairAddress(pair)) return null;
  const { value } = await pairCache.resolve(pair, async () => {
    const answer = await requestJson<PairsAnswer>(solanaPairsUrl([pair]), {
      source: 'dexscreener-solana',
      timeoutMs: 6_000,
      retries: 1,
    });
    const address = answer.pairs?.[0]?.baseToken?.address;
    return address && isSolanaAddress(address) ? address : null;
  });
  return value;
}

export function resetGlanceState(): void {
  glanceCache.clear();
  cardCache.clear();
  pairCache.clear();
  inflight.clear();
}
