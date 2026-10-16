import { isAddress } from 'viem';
import { NextResponse } from 'next/server';
import { explain } from '@/lib/agent/reason';
import { collect } from '@/lib/collect';
import { toFacts, type ReportFacts } from '@/lib/facts';
import { SealError } from '@/lib/errors';
import { ANALYZE_LIMIT, guardedJson } from '@/lib/guard';
import { log } from '@/lib/logger';
import { analysisCache, type CachedAnalysis } from '@/lib/analysis-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The route has 60 s in all. Collecting gets 30; the wording then has the
 * provider's own 25 s timeout (ANTHROPIC_TIMEOUT_MS), and falls back to the
 * facts when it runs out — so the response always leaves before the platform
 * kills the function.
 */
const COLLECT_TIMEOUT_MS = 30_000;

/** The response body. Its shape is kept with the cache, which stores it as is. */
export type AnalyzeResponse = CachedAnalysis;

const PUBLIC_MESSAGE: Record<string, string> = {
  'rate-limit': 'A data source is rate-limiting requests. Try again in a minute.',
  'not-found': 'Nothing was found for this address',
  timeout: 'A data source did not answer in time',
};

/** The charts are a bonus on top of the text: a malformed report must not fail the response. */
function chartable(report: Parameters<typeof toFacts>[0]): ReportFacts | undefined {
  try {
    return toFacts(report);
  } catch (error) {
    log.warn('faits non représentables', { error: String(error) });
    return undefined;
  }
}

function errorResponse(status: number, message: string, detail?: string) {
  return NextResponse.json({ error: message, ...(detail ? { detail } : {}) }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();

  const guarded = await guardedJson(request, ANALYZE_LIMIT, 'analyze');
  if ('response' in guarded) return guarded.response;
  const token = (guarded.body as { token?: unknown } | null)?.token;

  if (typeof token !== 'string' || !isAddress(token)) {
    return errorResponse(400, 'Invalid token address');
  }

  const cacheKey = token.toLowerCase();
  const hit = await analysisCache.get(cacheKey);
  if (hit) {
    log.info('analyse servie depuis le cache', { token, ms: Date.now() - started });
    return NextResponse.json({ ...hit, costUsd: 0, cached: true } satisfies AnalyzeResponse);
  }

  try {
    const report = await Promise.race([
      collect(token, {
        rpcUrl: process.env.RPC_URL || undefined,
        blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY || undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout global')), COLLECT_TIMEOUT_MS),
      ),
    ]);

    const explanation = await explain(report);

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

    const body: AnalyzeResponse = {
      token: report.token,
      explanation: explanation.text,
      completeness: report.completeness,
      sources: [...report.creator.sources, ...report.holders.sources, ...report.market.sources].map(
        ({ name, note }) => ({ name, ...(note ? { note } : {}) }),
      ),
      costUsd: explanation.cost.costUsd,
      collectedAt: report.collectedAt,
      offline: explanation.offline,
      facts: chartable(report),
    };

    await analysisCache.set(cacheKey, body);
    log.info('analyse servie', { token, ms: Date.now() - started, costUsd: body.costUsd });
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof SealError) {
      const status = error.kind === 'rate-limit' ? 429 : error.kind === 'not-found' ? 404 : 502;
      log.warn('analyse en échec', { token, kind: error.kind, message: error.message });
      // Upstream wording (node error text, provider messages) stays in the logs.
      return errorResponse(status, PUBLIC_MESSAGE[error.kind] ?? 'A data source failed');
    }
    log.error('analyse en échec', { token, error: String(error) });
    return errorResponse(500, 'The analysis could not be completed');
  }
}
