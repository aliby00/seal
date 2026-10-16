import { resolveProvider } from './agent/providers';
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
  if (body.sources.some((s) => /could not be read|rate-limit|busy|timed out/i.test(s.note ?? ''))) {
    return false;
  }
  return !(body.offline && modelConfigured);
}

export const analysisCache = new SharedCache<CachedAnalysis>({
  prefix: 'seal:analysis:v2',
  ttlMs: ANALYSIS_TTL_MS,
  keep: (body) => keepAnalysis(body, resolveProvider() !== undefined),
});
