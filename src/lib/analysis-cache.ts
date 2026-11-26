import type { FlagInputs } from './flags';
import { resolveProvider } from './agent/providers';
import type { LaunchReplayData } from './contracts';
import type { ReportFacts, TimelineLaunch } from './facts';
import type { SpecialistAnswer } from './specialists/brief';
import { SharedCache } from './shared-cache';
import { QUESTION_FAILED, QUESTION_TIMED_OUT, sourcesFailed } from './failed-reads';

export { sourcesFailed };

/** The body of a served analysis, as /api/analyze returns it. */
export type CachedAnalysis = {
  token: string;
  explanation: string;
  completeness: string;
  sources: { name: string; note?: string }[];
  collectedAt: string;
  /** Vrai si la restitution vient du mode hors-ligne, sans appel au modèle. */
  offline: boolean;
  /** The measured numbers, for the report's charts. Absent from older responses. */
  facts?: ReportFacts;
  /** True when served from the shared cache: this request spent nothing. */
  cached?: boolean;
  /** The token's name and symbol as read on chain; absent or null when unreadable. */
  name?: string | null;
  symbol?: string | null;
  /** The creator's launches in time order, when the history was read. */
  timeline?: TimelineLaunch[];
  /** The ten specialists' answers, in catalogue order. Each stands on its own. */
  specialists?: SpecialistAnswer[];
  /** The first minutes after the launch, move by move, when they could be read. */
  launch?: LaunchReplayData;
  /**
   * The numbers SEAL's flags are drawn from (flags.ts): the page draws them
   * again with its live market and holders. Absent from older answers.
   */
  flagInputs?: FlagInputs;
};

/**
 * A finished analysis is served again for three minutes: the same token asked
 * twice — a shared link, a refresh — costs one model call, not two. Short,
 * because prices and holders move.
 */
export const ANALYSIS_TTL_MS = 3 * 60_000;
/**
 * A token past its first day moves slowly enough to be served again for
 * longer: the blue chips most people will ask about are read, and paid for,
 * a few times an hour instead of every three minutes.
 */
export const SETTLED_ANALYSIS_TTL_MS = 12 * 60_000;
/** Age past which a token counts as settled. */
export const SETTLED_AGE_MS = 24 * 60 * 60_000;

/**
 * How long an analysis is served again: three minutes for a young token, or
 * one whose launch time could not be read; twelve past its first day.
 */
export function analysisTtlMs(launchedAt: string | null | undefined, now = Date.now()): number {
  const at = launchedAt ? Date.parse(launchedAt) : Number.NaN;
  if (!Number.isFinite(at)) return ANALYSIS_TTL_MS;
  return now - at > SETTLED_AGE_MS ? SETTLED_ANALYSIS_TTL_MS : ANALYSIS_TTL_MS;
}

/**
 * Only a complete answer is kept: a read the node cut short, or a text that
 * fell back offline while a model is configured (a provider hiccup), is worth
 * retrying on the next request rather than repeating for three minutes.
 */
export function keepAnalysis(body: CachedAnalysis, modelConfigured: boolean): boolean {
  if (sourcesFailed(body.sources)) return false;
  // A read that failed without a source note saying so (the launch replay,
  // the creator's other launches) is a degraded report too.
  if ((body.facts?.failed?.length ?? 0) > 0) return false;
  // A question that ran out of time is a read that failed too (AI: six of ten).
  if (
    body.specialists?.some(
      (a) => a.limits.includes(QUESTION_TIMED_OUT) || a.limits.includes(QUESTION_FAILED),
    )
  )
    return false;
  return !(body.offline && modelConfigured);
}

/** `sol1`: Solana readings only; a Robinhood Chain reading cached before is never served. */
export const analysisCache = new SharedCache<CachedAnalysis>({
  prefix: 'seal:analysis:sol1',
  ttlMs: ANALYSIS_TTL_MS,
  keep: (body) => keepAnalysis(body, resolveProvider() !== undefined),
});

/**
 * The last answer served for a token, whatever its completeness, for 45
 * seconds. Read only by the requests that waited on another one reading the
 * same token (`analysis-lock`): a partial answer is not repeated to the next
 * visitor, but the ones who asked at the same moment get it instead of each
 * starting their own collection and model call.
 */
export const JUST_SERVED_TTL_MS = 45_000;
export const justServed = new SharedCache<CachedAnalysis>({
  prefix: 'seal:analysis:served:sol1',
  ttlMs: JUST_SERVED_TTL_MS,
});
