import { fetchSolanaPairs, toSolanaMarketState } from './market/solana';
import { SharedCache } from './shared-cache';
import { readHolders } from './solana/holders';
import { createSolanaRpc } from './solana/rpc';

/**
 * What moves by the second, read again for a page already showing a report:
 * the market from DexScreener (the same main pair and the same sums as the
 * report), and the holders with what the dev holds from the chain. Each is
 * kept a few seconds per token in the shared cache, whoever asks: the cost
 * follows the tokens being watched, not the number of people watching.
 */
export type LiveMarket = {
  token: string;
  at: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  liquidityToMarketCap: number | null;
  volume24hUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
  perTradeUsd24h: number | null;
};

export type LiveHolders = {
  token: string;
  at: string;
  holderCount: number | null;
  top1OfSupply: number | null;
  top10OfSupply: number | null;
  /** What the dev holds, of the supply; `null` when no dev was asked about or it was not read. */
  devHolds: number | null;
};

/** DexScreener refreshes its pairs every few seconds: kept this long, whoever asks. */
export const LIVE_MARKET_TTL_MS = 3_000;
/** A holders read costs a dozen node calls: kept this long. */
export const LIVE_HOLDERS_TTL_MS = 15_000;
/** Node calls a holders refresh may spend, and its time. */
const HOLDERS_CALLS = 12;
const HOLDERS_TIMEOUT_MS = 6_000;

export const liveMarketCache = new SharedCache<LiveMarket>({
  prefix: 'seal:live:market:v1',
  ttlMs: LIVE_MARKET_TTL_MS,
  maxEntries: 500,
});
export const liveHoldersCache = new SharedCache<LiveHolders>({
  prefix: 'seal:live:holders:v1',
  ttlMs: LIVE_HOLDERS_TTL_MS,
  maxEntries: 300,
});

export async function readLiveMarket(token: string, signal?: AbortSignal): Promise<LiveMarket> {
  const pairs = await fetchSolanaPairs(token, signal ? { signal } : {});
  const state = toSolanaMarketState(token, pairs);
  const d = state.data;
  return {
    token,
    at: new Date().toISOString(),
    priceUsd: d.priceUsd,
    marketCapUsd: d.marketCapUsd,
    fdvUsd: d.fdvUsd,
    liquidityUsd: d.liquidityUsd,
    liquidityToMarketCap: d.liquidityToMarketCap ?? null,
    volume24hUsd: d.volumeUsd?.h24 ?? null,
    buys24h: d.txns?.h24.buys ?? null,
    sells24h: d.txns?.h24.sells ?? null,
    perTradeUsd24h: d.perTradeUsd24h ?? null,
  };
}

export async function readLiveHolders(token: string, creator: string | null): Promise<LiveHolders> {
  const rpc = createSolanaRpc({ maxCalls: HOLDERS_CALLS });
  const read = await readHolders(token, rpc, {
    ...(creator ? { creator } : {}),
    maxCalls: HOLDERS_CALLS,
    timeoutMs: HOLDERS_TIMEOUT_MS,
  });
  const d = read.data;
  const ok = read.completeness !== 'unavailable' && d.method !== 'none';
  return {
    token,
    at: new Date().toISOString(),
    holderCount: ok ? d.holderCount : null,
    top1OfSupply: ok ? d.ofSupply.largestWallet : null,
    top10OfSupply: ok ? d.ofSupply.top10Wallets : null,
    devHolds: creator && d.creator ? d.creator.ofSupply : null,
  };
}
