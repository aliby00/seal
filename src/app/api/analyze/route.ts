import { isAddress } from 'viem';
import { NextResponse } from 'next/server';
import { explain } from '@/lib/agent/reason';
import { collect } from '@/lib/collect';
import { SealError } from '@/lib/errors';
import { ANALYZE_LIMIT, guardedJson } from '@/lib/guard';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The route has 60 s in all. Collecting gets 30; the wording then has the
 * provider's own 25 s timeout (ANTHROPIC_TIMEOUT_MS), and falls back to the
 * facts when it runs out — so the response always leaves before the platform
 * kills the function.
 */
const COLLECT_TIMEOUT_MS = 30_000;

export type AnalyzeResponse = {
  token: string;
  explanation: string;
  completeness: string;
  sources: { name: string; note?: string }[];
  costUsd: number;
  collectedAt: string;
  /** Vrai si la restitution vient du mode hors-ligne, sans appel au modèle. */
  offline: boolean;
};

const PUBLIC_MESSAGE: Record<string, string> = {
  'rate-limit': 'A data source is rate-limiting requests. Try again in a minute.',
  'not-found': 'Nothing was found for this address',
  timeout: 'A data source did not answer in time',
};

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

  try {
    const report = await Promise.race([
      collect(token, { blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY }),
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
    };

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
