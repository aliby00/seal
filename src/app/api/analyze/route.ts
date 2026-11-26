import { NextResponse } from 'next/server';
import { explain } from '@/lib/agent/reason';
import { collect, type CollectOptions } from '@/lib/collect';
import {
  launchView,
  toFacts,
  toTimeline,
  type ReportFacts,
  type TimelineLaunch,
} from '@/lib/facts';
import { isSolanaAddress } from '@/lib/solana/address';
import { toSolanaView, type SolanaView } from '@/app/components/solana-view';
import { failureStatus, NOT_FUNGIBLE_MESSAGE, SealError } from '@/lib/errors';
import { ANALYZE_LIMIT, COLLECT_LIMIT, guardedJson, overLimit } from '@/lib/guard';
import { log } from '@/lib/logger';
import { overBudget, recordSpend } from '@/lib/spend';
import { funderOf } from '@/lib/agent/prompt';
import { flagInputsOf } from '@/lib/agent/trader-text';
import {
  analysisCache,
  analysisTtlMs,
  justServed,
  type CachedAnalysis,
} from '@/lib/analysis-cache';
import { analysisHeld, claimAnalysis } from '@/lib/analysis-lock';
import { rememberCard } from '@/lib/glance-service';
import { mergeFailedReads, questionsFailed } from '@/lib/failed-reads';
import {
  briefSpecialists,
  SPECIALIST_TIMEOUT_MS,
  startSpecialists,
  type SpecialistBrief,
  type SpecialistStart,
} from '@/lib/specialists/brief';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The route has 60 s in all. Collecting gets 30; the wording then has the
 * provider's own 25 s timeout (ANTHROPIC_TIMEOUT_MS), and falls back to the
 * facts when it runs out — so the response always leaves before the platform
 * kills the function.
 */
const COLLECT_TIMEOUT_MS = 30_000;
const COLLECT_TIMEOUT_MESSAGE = 'timeout global';
/** What the whole request may take, under maxDuration with a margin. */
const REQUEST_BUDGET_MS = 54_000;
/**
 * The hard deadline: whatever is still running then, the route answers 504.
 * COVENANT on staging (18/10/2026) got no answer in 320 s; every outbound
 * read has its own timeout, and this one stands behind them all.
 */
const REQUEST_DEADLINE_MS = 57_000;
/** Kept for the model: the provider's own timeout. */
const MODEL_ALLOWANCE_MS = 25_000;
/** Below this, the model is not worth calling: the facts are worded offline. */
const MIN_MODEL_MS = 5_000;
/** The questions always get a short chance, even after a slow collection. */
const MIN_SPECIALIST_MS = 1_000;
/** A request waiting on another reading of the same token looks for its answer this often... */
const FOLLOW_POLL_MS = 1_000;
/** ...for this long at most, under the deadline with a margin. */
const FOLLOW_MAX_MS = 45_000;
/** Past this wait, there is no time left to read the token itself. */
const FOLLOW_READ_SELF_MS = 12_000;

/**
 * The response body. Its shape is kept with the cache, which stores it as is.
 * `solana`: what the report screen draws of the Solana blocks (mint, powers,
 * holders by role, liquidity by pool, launch, creator); absent from answers
 * cached before it existed.
 */
export type AnalyzeResponse = CachedAnalysis & { solana?: SolanaView };

const PUBLIC_MESSAGE: Record<string, string> = {
  'rate-limit': 'A data source is rate-limiting requests. Try again in a minute.',
  'not-found': 'Nothing was found for this address',
  'not-fungible': NOT_FUNGIBLE_MESSAGE,
  timeout: 'A data source did not answer in time',
};

/** A cached answer, as served: never its cost, which is ours to track. */
function fromCache(hit: CachedAnalysis): Response {
  // An entry written before the cost left the response loses it here.
  const served: AnalyzeResponse & { costUsd?: number } = { ...(hit as AnalyzeResponse) };
  delete served.costUsd;
  return NextResponse.json({ ...served, cached: true } satisfies AnalyzeResponse);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Another request is reading this token: its answer, once it is in the
 * cache. `null` when the other reading ended without one (an error) or took
 * too long.
 */
async function followReading(token: string, started: number): Promise<CachedAnalysis | null> {
  while (Date.now() - started < FOLLOW_MAX_MS) {
    await pause(FOLLOW_POLL_MS);
    const done = (await analysisCache.get(token)) ?? (await justServed.get(token));
    if (done) return done;
    if (!(await analysisHeld(token))) {
      // Released between the two reads: its answer may have just landed.
      return (await analysisCache.get(token)) ?? (await justServed.get(token)) ?? null;
    }
  }
  return null;
}

/** The charts are a bonus on top of the text: a malformed report must not fail the response. */
function chartable(
  report: Parameters<typeof toFacts>[0],
  funder: string | undefined,
): ReportFacts | undefined {
  try {
    return toFacts(report, funder ? { funder } : {});
  } catch (error) {
    log.warn('faits non représentables', { error: String(error) });
    return undefined;
  }
}

/** Drawn on top of the text, like the charts: a malformed report must not fail the response. */
function solanaView(report: Parameters<typeof toSolanaView>[0]): SolanaView | undefined {
  try {
    return toSolanaView(report);
  } catch (error) {
    log.warn('vue Solana non représentable', { error: String(error) });
    return undefined;
  }
}

function timeline(report: Parameters<typeof toTimeline>[0]): TimelineLaunch[] | undefined {
  try {
    const launches = toTimeline(report);
    return launches.length > 0 ? launches : undefined;
  } catch (error) {
    log.warn('chronologie non représentable', { error: String(error) });
    return undefined;
  }
}

/** When the token was launched, as the timeline dates it; `null` when unread. */
function launchedAt(report: Parameters<typeof toTimeline>[0]): string | null {
  try {
    const creation = report.creator.data.creation;
    return (
      report.launch.data.launchedAt ??
      (creation?.blockTime ? new Date(creation.blockTime * 1000).toISOString() : null)
    );
  } catch {
    return null;
  }
}

/** The specialists are part of the picture, not a condition of it: never fail on them. */
async function specialists(
  token: string,
  report: Parameters<typeof toFacts>[0],
  timeoutMs: number,
  started?: SpecialistStart,
): Promise<SpecialistBrief | undefined> {
  try {
    return await briefSpecialists(token, report, {
      timeoutMs,
      ...(started ? { started } : {}),
    });
  } catch (error) {
    log.warn('spécialistes indisponibles', { token, error: String(error) });
    return undefined;
  }
}

/** The flags' numbers: never a reason for the answer to fail. */
function flagInputsOrNothing(
  report: Parameters<typeof flagInputsOf>[0],
  answers: Parameters<typeof flagInputsOf>[1],
) {
  try {
    return { flagInputs: flagInputsOf(report, answers) };
  } catch (error) {
    log.warn('drapeaux non calculés', { error: String(error) });
    return {};
  }
}

function errorResponse(status: number, message: string, detail?: string) {
  return NextResponse.json({ error: message, ...(detail ? { detail } : {}) }, { status });
}

/** The answer, or a 504 when it is not ready by `REQUEST_DEADLINE_MS`. */
export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      log.error('analyse hors délai', { ms: Date.now() - started });
      resolve(errorResponse(504, 'The analysis took too long this time. Try again in a moment.'));
    }, REQUEST_DEADLINE_MS);
  });
  try {
    return await Promise.race([analyze(request, started), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function analyze(request: Request, started: number): Promise<Response> {
  // The rate limit is charged below, once the answer is known not to be in
  // the cache: an answer served from it spends nothing, and is not counted
  // (behind a mobile carrier, many readers share one address).
  const guarded = await guardedJson(request, null, 'analyze');
  if ('response' in guarded) return guarded.response;
  const token = (guarded.body as { token?: unknown } | null)?.token;

  // A Solana mint, base58, case kept: an EVM 0x address is not one.
  if (typeof token !== 'string' || !isSolanaAddress(token)) {
    return errorResponse(400, 'Invalid token address');
  }

  const hit = await analysisCache.get(token);
  if (hit) {
    log.info('analyse servie depuis le cache', { token, ms: Date.now() - started });
    return fromCache(hit);
  }

  // A reading to pay for: the address's analyses, and its collections on
  // every route together.
  const limited = await overLimit(request, [
    ['analyze', ANALYZE_LIMIT],
    ['collect', COLLECT_LIMIT],
  ]);
  if (limited) return limited;

  // Someone else is reading this token right now: its answer, not a second reading.
  let lock = await claimAnalysis(token);
  if (!lock) {
    const followed = await followReading(token, started);
    if (followed) {
      log.info('analyse servie après une lecture en cours', { token, ms: Date.now() - started });
      return fromCache(followed);
    }
    if (Date.now() - started > FOLLOW_READ_SELF_MS) {
      return errorResponse(503, 'This token is being read right now. Try again in a moment.');
    }
    lock = await claimAnalysis(token);
  }
  try {
    return await read(token, started);
  } finally {
    await lock?.release();
  }
}

/** Collects the token, has its questions answered and its text written, and serves it. */
async function read(token: string, started: number): Promise<Response> {
  const cacheKey = token;
  // Where the collection got to, logged if it is cut at 30 s.
  const progress: NonNullable<CollectOptions['progress']> = { stages: {} };
  try {
    // What the questions can read without the report starts now, alongside it.
    const questions = startSpecialists(token);
    const report = await Promise.race([
      collect(token, { progress, signal: AbortSignal.timeout(COLLECT_TIMEOUT_MS) }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(COLLECT_TIMEOUT_MESSAGE)), COLLECT_TIMEOUT_MS),
      ),
    ]);

    // The ten questions are answered before the text is written, so the text
    // can draw on them. Their time is what is left once the model's own
    // allowance is set aside, so the whole request stays under maxDuration.
    const collectedMs = Date.now() - started;
    const left = REQUEST_BUDGET_MS - (Date.now() - started) - MODEL_ALLOWANCE_MS;
    const brief = await specialists(
      token,
      report,
      Math.max(MIN_SPECIALIST_MS, Math.min(SPECIALIST_TIMEOUT_MS, left)),
      questions,
    );
    // Questions that ran out of time, or could not be answered, are a read
    // that failed: the report says it is partial and is cached nowhere.
    const unanswered = brief
      ? questionsFailed(brief.unanswered ?? [], brief.answers.length)
      : { read: 'questions' as const, note: 'the ten questions could not be answered this time' };
    const partial = [...(unanswered ? [unanswered] : []), ...(brief?.partial ?? [])];
    if (partial.length > 0) {
      report.failedReads = mergeFailedReads([...(report.failedReads ?? []), ...partial]);
    }
    // Whatever the model has left is cut at the budget's end, so the response
    // leaves before the platform kills the function and loses a paid answer.
    const answeredMs = Date.now() - started;
    const modelMs = REQUEST_BUDGET_MS - (Date.now() - started);
    const explanation = await explain(report, {
      specialists: brief?.answers,
      offline: modelMs < MIN_MODEL_MS || (await overBudget()),
      signal: AbortSignal.timeout(Math.max(1, Math.min(MODEL_ALLOWANCE_MS, modelMs))),
    });
    await recordSpend(explanation.cost.costUsd);

    // Une sortie non conforme ne doit pas atteindre l'utilisateur : c'est une
    // contrainte de conception du produit, pas une préférence de style.
    if (explanation.violations.length > 0) {
      log.error('sortie non conforme refusée', {
        token,
        violations: explanation.violations,
      });
      return errorResponse(
        502,
        'The generated analysis did not meet the wording requirements. Please try again.',
      );
    }

    const launch = launchView(report.launch);
    const solana = solanaView(report);
    const body: AnalyzeResponse = {
      token: report.token,
      explanation: explanation.text,
      completeness: report.completeness,
      sources: [
        ...report.mint.sources,
        ...report.creator.sources,
        ...report.holders.sources,
        ...report.market.sources,
      ].map(({ name, note }) => ({ name, ...(note ? { note } : {}) })),
      collectedAt: report.collectedAt,
      offline: explanation.offline,
      facts: chartable(report, funderOf(brief?.answers)),
      timeline: timeline(report),
      ...(launch ? { launch } : {}),
      ...(solana ? { solana } : {}),
      ...(brief ? { name: brief.name, symbol: brief.symbol, specialists: brief.answers } : {}),
      ...flagInputsOrNothing(report, brief?.answers),
    };

    // A report a failed read left partial is worth asking again, never repeating.
    // A token past its first day is kept longer: it moves slowly.
    if ((report.failedReads?.length ?? 0) === 0) {
      await analysisCache.set(cacheKey, body, analysisTtlMs(launchedAt(report)));
    }
    // Whatever it is, for the requests that waited on this one.
    await justServed.set(cacheKey, body);
    // The share card shows what was served, partial or not.
    await rememberCard(body);
    log.info('analyse servie', {
      token,
      ms: Date.now() - started,
      // Where the time went: the reads, then the ten questions, then the text.
      phases: {
        collect: collectedMs,
        questions: answeredMs - collectedMs,
        model: Date.now() - started - answeredMs,
      },
      costUsd: explanation.cost.costUsd,
      // Why a text came offline is in the lines above; these say that it did.
      offline: explanation.offline,
      ...(explanation.rejected ? { rejected: true } : {}),
    });
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof SealError) {
      const status = failureStatus(error.kind);
      log.warn('analyse en échec', { token, kind: error.kind, message: error.message });
      // Upstream wording (node error text, provider messages) stays in the logs.
      return errorResponse(status, PUBLIC_MESSAGE[error.kind] ?? 'A data source failed');
    }
    // Reading the chain ran past its budget: a busy token, not a broken one.
    if (error instanceof Error && error.message === COLLECT_TIMEOUT_MESSAGE) {
      log.warn('analyse trop longue', {
        token,
        ms: Date.now() - started,
        stages: progress.stages,
        reads: progress.reads,
      });
      return errorResponse(
        504,
        'This token has a long history and took too long to read. Try again in a moment.',
      );
    }
    log.error('analyse en échec', { token, error: String(error) });
    return errorResponse(500, 'The analysis could not be completed');
  }
}
