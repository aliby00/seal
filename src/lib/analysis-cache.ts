import { resolveProvider } from './agent/providers';
import type { LaunchReplayData } from './contracts';
import type { ReportFacts, TimelineLaunch } from './facts';
import type { SpecialistAnswer } from './specialists/brief';
import { SharedCache } from './shared-cache';

/** The body of a served analysis, as /api/analyze returns it. */
export type CachedAnalysis = {
  token: string;
  explanation: string;
  completeness: string;
  sources: { name: string; note?: string }[];
  costUsd: number;
  collectedAt: string;
  /** Vrai si la restitution vient du mode hors-ligne, sans appel au modèle. */
  offline: boolean;
  /** The measured numbers, for the report's charts. Absent from older responses. */
  facts?: ReportFacts;
  /** True when served from the shared cache: this request spent nothing (costUsd 0). */
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
};

/**
 * A finished analysis is served again for three minutes: the same token asked
 * twice — a shared link, a refresh — costs one model call, not two. Short,
 * because prices and holders move.
 */
const ANALYSIS_TTL_MS = 3 * 60_000;

/**
 * Only a complete answer is kept: a read the node cut short, or a text that
 * fell back offline while a model is configured (a provider hiccup), is worth
 * retrying on the next request rather than repeating for three minutes.
 */
export function keepAnalysis(body: CachedAnalysis, modelConfigured: boolean): boolean {
  if (sourcesFailed(body.sources)) return false;
  return !(body.offline && modelConfigured);
}

/**
 * A source that failed (its note starts with the error kind, see collect.ts)
 * is retried by the next request rather than repeated from a cache.
 */
export function sourcesFailed(sources: readonly { note?: string }[]): boolean {
  const failed =
    /could not be read|rate-limit|busy|timed out|budget|unknown failure|^(?:timeout|incomplete|upstream) : /i;
  return sources.some((s) => failed.test(s.note ?? ''));
}

export const analysisCache = new SharedCache<CachedAnalysis>({
  prefix: 'seal:analysis:v2',
  ttlMs: ANALYSIS_TTL_MS,
  keep: (body) => keepAnalysis(body, resolveProvider() !== undefined),
});
