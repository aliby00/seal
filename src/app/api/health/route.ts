import { NextResponse } from 'next/server';
import { resolveProvider } from '@/lib/agent/providers';
import { storeKind } from '@/lib/store';
import { modelFailure } from '@/lib/model-health';
import { solanaNodeHealth } from '@/lib/solana/health';

export const dynamic = 'force-dynamic';

/**
 * Sonde utilisée par les smoke tests après chaque déploiement.
 * Elle dit « l'application tourne », et de quel nœud Solana elle lit :
 * lequel (alchemy, solana-rpc-url ou public, jamais son URL qui porte la
 * clé) et s'il répond à un `getSlot` (2 s au plus, un seul appel). Elle lit
 * aussi, dans le store partagé (800 ms au plus, repli mémoire), le dernier
 * échec durable du modèle, que les lectures ont constaté elles-mêmes. La
 * sonde n'appelle jamais le modèle.
 */
export async function GET() {
  const [failure, solana] = await Promise.all([
    modelFailure().catch(() => null),
    solanaNodeHealth(),
  ]);
  // Every analysis reads the chain first: a node that does not answer leaves
  // the site up but unable to read anything. The probe says so with a 503 and
  // `degraded`, so the smoke tests and the uptime check see it; the body keeps
  // every field.
  return NextResponse.json(
    {
      status: solana.slotOk ? 'ok' : 'degraded',
      env: process.env.SEAL_ENV ?? 'development',
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      // Which services are configured — names only, never a key or a URL — so a
      // deployment that silently runs offline is visible from outside.
      config: {
        reasoning: resolveProvider()?.provider.name ?? 'offline',
        chain: 'solana',
        // The Solana node read first, by its label; the public one closes the list.
        solanaNode: solana.node,
        solanaNodes: solana.nodes,
        // Where the rate limit and the analysis cache live: shared, or per instance.
        store: storeKind(),
      },
      // Whether the first node answered a `getSlot` just now, and how fast.
      solana: {
        node: solana.node,
        slotOk: solana.slotOk,
        ...(solana.slotOk ? { slot: solana.slot } : { error: solana.error }),
        ms: solana.ms,
      },
      // A configured model that does not answer (revoked key, retired model id,
      // no credit): its kind and since when, never the provider's message.
      reasoningFailing: failure ? failure.kind : null,
      reasoningFailingSince: failure ? failure.at : null,
      at: new Date().toISOString(),
    },
    {
      status: solana.slotOk ? 200 : 503,
      // Each probe costs a getSlot and a store read: a healthy answer is
      // shared by the CDN for ten seconds, a failing one never.
      headers: { 'Cache-Control': solana.slotOk ? 'public, max-age=0, s-maxage=10' : 'no-store' },
    },
  );
}
