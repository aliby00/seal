import { isAddress } from 'viem';
import { NextResponse } from 'next/server';
import { explain } from '@/lib/agent/reason';
import { collect } from '@/lib/collect';
import { SealError } from '@/lib/errors';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Au-delà, l'utilisateur a déjà fermé l'onglet. */
const GLOBAL_TIMEOUT_MS = 55_000;

export type AnalyzeResponse = {
  token: string;
  explanation: string;
  completeness: string;
  sources: { name: string; note?: string }[];
  costUsd: number;
  collectedAt: string;
};

function errorResponse(status: number, message: string, detail?: string) {
  return NextResponse.json({ error: message, ...(detail ? { detail } : {}) }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();

  let token: unknown;
  try {
    ({ token } = (await request.json()) as { token?: unknown });
  } catch {
    return errorResponse(400, 'Corps de requête illisible');
  }

  if (typeof token !== 'string' || !isAddress(token)) {
    return errorResponse(400, 'Adresse de token invalide');
  }

  try {
    const report = await Promise.race([
      collect(token, { blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout global')), GLOBAL_TIMEOUT_MS),
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
        "L'analyse produite ne respectait pas les contraintes de formulation. Réessayez.",
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
    };

    log.info('analyse servie', { token, ms: Date.now() - started, costUsd: body.costUsd });
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof SealError) {
      const status = error.kind === 'rate-limit' ? 429 : error.kind === 'not-found' ? 404 : 502;
      log.warn('analyse en échec', { token, kind: error.kind, message: error.message });
      return errorResponse(status, error.message);
    }
    log.error('analyse en échec', { token, error: String(error) });
    return errorResponse(500, "L'analyse n'a pas pu aboutir");
  }
}
