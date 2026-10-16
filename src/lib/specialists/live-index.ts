import { TtlCache } from '../cache';
import { createRpcClient, type RpcClient } from '../chain/rpc';
import { MarketIndex, scanMarkets, tokenSide } from '../chain/pools';

/**
 * Fenêtre de l'index construit à la volée : 30 000 blocs, soit ~50 minutes et
 * une seule requête `eth_getLogs`. C'est court. L'index long — celui qui sert
 * au classement — se construit hors requête ; ici on ne promet que ce qu'on lit.
 */
export const LIVE_INDEX_BLOCKS = 30_000;

const indexCache = new TtlCache<MarketIndex>({ ttlMs: 5 * 60_000, maxEntries: 1 });

/** The recent v4 markets, shared by every request on this instance for five minutes. */
export async function liveIndex(rpc?: RpcClient): Promise<MarketIndex> {
  const { value } = await indexCache.resolve('live', async () => {
    const client = rpc ?? createRpcClient(process.env.RPC_URL || undefined);
    const latest = Number(await client.call<string>('eth_blockNumber', []));
    const { markets } = await scanMarkets(client, {
      fromBlock: latest - LIVE_INDEX_BLOCKS,
      toBlock: latest,
    });
    return new MarketIndex(markets.map((m) => ({ ...m, token: tokenSide(m) })));
  });
  return value;
}
