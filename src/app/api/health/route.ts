import { NextResponse } from 'next/server';
import { resolveProvider } from '@/lib/agent/providers';
import { storeKind } from '@/lib/store';
import { DEFAULT_RPC_URL, logsRpcUrl, logsRpcUrls, rpcUrls } from '@/lib/chain/rpc';

export const dynamic = 'force-dynamic';

/**
 * Sonde utilisée par les smoke tests après chaque déploiement.
 * Elle doit rester sans dépendance externe : son rôle est de dire
 * « l'application tourne », pas « les APIs tierces répondent ».
 */
export function GET() {
  return NextResponse.json({
    status: 'ok',
    env: process.env.SEAL_ENV ?? 'development',
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    // Which services are configured — names only, never a key or a URL — so a
    // deployment that silently runs offline is visible from outside.
    config: {
      reasoning: resolveProvider()?.provider.name ?? 'offline',
      rpc: process.env.RPC_URL ? 'custom' : 'public',
      // Nodes tried in turn, the public one included: 1 means no failover.
      rpcNodes: rpcUrls().length,
      logsRpc: logsRpcUrl() === DEFAULT_RPC_URL ? 'public' : 'custom',
      logsRpcNodes: logsRpcUrls().length,
      holders: process.env.BLOCKSCOUT_API_KEY ? 'blockscout' : 'chain',
      // Where the rate limit and the analysis cache live: shared, or per instance.
      store: storeKind(),
    },
    at: new Date().toISOString(),
  });
}
