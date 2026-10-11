import { isAddress } from 'viem';
import { NextResponse } from 'next/server';
import { investigate } from '@/lib/agent/investigate';
import { TtlCache } from '@/lib/cache';
import { createRpcClient } from '@/lib/chain';
import { MarketIndex, scanMarkets, tokenSide } from '@/lib/chain/pools';
import { collect } from '@/lib/collect';
import type { TokenReport } from '@/lib/contracts';
import { SealError } from '@/lib/errors';
import { log } from '@/lib/logger';
import {
  compileAgent,
  gatherContext,
  InvalidAgentSpecError,
  type Finding,
} from '@/lib/specialists';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const GLOBAL_TIMEOUT_MS = 55_000;

/**
 * Fenêtre de l'index construit à la volée : 30 000 blocs, soit ~50 minutes et
 * une seule requête `eth_getLogs`. C'est court. L'index long — celui qui sert
 * au classement — se construit hors requête ; ici on ne promet que ce qu'on lit.
 */
const LIVE_INDEX_BLOCKS = 30_000;
const indexCache = new TtlCache<MarketIndex>({ ttlMs: 5 * 60_000, maxEntries: 1 });

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

async function liveIndex(): Promise<MarketIndex> {
  const { value } = await indexCache.resolve('live', async () => {
    const rpc = createRpcClient(process.env.RPC_URL);
    const latest = Number(await rpc.call<string>('eth_blockNumber', []));
    const { markets } = await scanMarkets(rpc, {
      fromBlock: latest - LIVE_INDEX_BLOCKS,
      toBlock: latest,
    });
    return new MarketIndex(markets.map((m) => ({ ...m, token: tokenSide(m) })));
  });
  return value;
}

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();

  let body: { token?: unknown; agent?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse(400, 'Unreadable request body');
  }

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
      const rpc = createRpcClient(process.env.RPC_URL);
      // Un token sans lancement pons reste analysable : les spécialistes qui
      // dépendent du rapport répondront `unknown` en le disant.
      const [report, index] = await Promise.all([
        collect(token, { blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY }).catch(
          (error: unknown): TokenReport | undefined => {
            log.warn('rapport pons indisponible', { token, error: String(error) });
            return undefined;
          },
        ),
        liveIndex().catch(() => undefined),
      ]);
      const context = await gatherContext(rpc, token, report, index);
      return investigate(checklist, context);
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
      return errorResponse(status, error.message);
    }
    log.error('agent en échec', { token, error: String(error) });
    return errorResponse(500, 'The agent could not complete');
  }
}
