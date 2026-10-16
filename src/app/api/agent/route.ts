import { isAddress } from 'viem';
import { NextResponse } from 'next/server';
import { investigate } from '@/lib/agent/investigate';
import { createRpcClient } from '@/lib/chain';
import { collect } from '@/lib/collect';
import type { TokenReport } from '@/lib/contracts';
import { SealError } from '@/lib/errors';
import { AGENT_LIMIT, guardedJson } from '@/lib/guard';
import { log } from '@/lib/logger';
import { overBudget, recordSpend } from '@/lib/spend';
import {
  compileAgent,
  gatherContext,
  InvalidAgentSpecError,
  liveIndex,
  type Finding,
} from '@/lib/specialists';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Same split as /api/analyze: 30 s to gather, the provider's 25 s to word it. */
const GLOBAL_TIMEOUT_MS = 55_000;
/** Below this, the model is not worth calling: the findings are listed offline. */
const MIN_MODEL_MS = 5_000;
/** Gathering gets its own share, so a slow source leaves time to word the findings. */
const GATHER_TIMEOUT_MS = 35_000;

export type AgentResponse = {
  token: string;
  agent: string;
  fingerprint: string;
  findings: Finding[];
  /** Spécialistes que l'enquête a ajoutés hors de la sélection. */
  leads: string[];
  tier: string;
  explanation: string;
  costUsd: number;
  offline: boolean;
};

function errorResponse(status: number, message: string, detail?: string | string[]) {
  return NextResponse.json({ error: message, ...(detail ? { detail } : {}) }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();

  const guarded = await guardedJson(request, AGENT_LIMIT, 'agent');
  if ('response' in guarded) return guarded.response;
  const body = (guarded.body ?? {}) as { token?: unknown; agent?: unknown };

  const { token } = body;
  if (typeof token !== 'string' || !isAddress(token)) {
    return errorResponse(400, 'Invalid token address');
  }

  let checklist;
  try {
    checklist = compileAgent(body.agent);
  } catch (error) {
    if (error instanceof InvalidAgentSpecError) {
      return errorResponse(400, 'Invalid agent', error.issues);
    }
    throw error;
  }

  try {
    const work = (async () => {
      const rpc = createRpcClient(process.env.RPC_URL || undefined);
      // Un token sans lancement pons reste analysable : les spécialistes qui
      // dépendent du rapport répondront `unknown` en le disant.
      const [report, index] = await Promise.all([
        Promise.race([
          collect(token, {
            rpcUrl: process.env.RPC_URL || undefined,
            blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY || undefined,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('collecte trop longue')), GATHER_TIMEOUT_MS),
          ),
        ]).catch((error: unknown): TokenReport | undefined => {
          log.warn('rapport pons indisponible', { token, error: String(error) });
          return undefined;
        }),
        liveIndex().catch(() => undefined),
      ]);
      const context = await gatherContext(rpc, token, report, index);
      const left = GLOBAL_TIMEOUT_MS - (Date.now() - started);
      const result = await investigate(checklist, context, {
        offline: left < MIN_MODEL_MS || (await overBudget()),
        signal: AbortSignal.timeout(Math.max(1, left)),
      });
      await recordSpend(result.totalCostUsd);
      return result;
    })();

    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout global')), GLOBAL_TIMEOUT_MS),
      ),
    ]);

    const response: AgentResponse = {
      token: token.toLowerCase(),
      agent: checklist.name,
      fingerprint: checklist.fingerprint,
      findings: result.findings,
      leads: result.leads,
      tier: result.tier,
      explanation: result.text,
      costUsd: result.totalCostUsd,
      offline: result.offline,
    };
    log.info('agent servi', {
      token,
      agent: checklist.fingerprint,
      tier: result.tier,
      ms: Date.now() - started,
      costUsd: result.totalCostUsd,
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof SealError) {
      const status = error.kind === 'rate-limit' ? 429 : 502;
      log.warn('agent en échec', { token, kind: error.kind, message: error.message });
      return errorResponse(status, 'A data source failed. Try again in a minute.');
    }
    log.error('agent en échec', { token, error: String(error) });
    return errorResponse(500, 'The agent could not complete');
  }
}
