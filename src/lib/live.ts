import { log } from './logger';
import { fetchSolanaPairs, toSolanaMarketState } from './market/solana';
import { SharedCache } from './shared-cache';
import { readHolders } from './solana/holders';
import { NATIVE_MINT } from './solana/programs';
import { readPoolPrice, type LivePoolKind, type PoolPrice } from './solana/pool-price';
import { createSolanaRpc } from './solana/rpc';

/**
 * What moves by the second, read again for a page already showing a report:
 * the price, market cap and liquidity from the main pool on chain, slot by
 * slot; the volume and trade counts from DexScreener (the same main pair and
 * the same sums as the report), which runs 10 to 60 s behind the chain; the
 * holders with what the dev holds from the chain. Each is kept a few seconds
 * per token in the shared cache, whoever asks: the cost follows the tokens
 * being watched, not the number of people watching.
 */
export type LiveMarket = {
  token: string;
  /** The freshest part of the read: the chain's when read, DexScreener's otherwise. */
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
  /**
   * Where price, market cap, FDV and liquidity were read: the main pool on
   * chain at `slot`; `null` when the pool is not of a kind read here or the
   * read failed, and they are DexScreener's. Absent from older answers.
   */
  chain?: LiveChain | null;
  /** When DexScreener's figures were read (they lag the chain by 10 to 60 s). */
  dexAt?: string;
  /** The quote on the token's curve in dollars, when the main pair is its curve (DexScreener gives none). */
  curveLiquidityUsd?: number | null;
};

/**
 * What the main pool said on chain at `slot`, read at `readAt`. The market
 * cap keeps DexScreener's supply (the report's); `liquidityUsd` is both
 * sides of a pool, or the SOL a curve holds in dollars.
 */
export type LiveChain = {
  priceUsd: number;
  /** The price in SOL; `null` for a pool quoted in USDC or USDT. */
  priceSol: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  slot: number;
  readAt: string;
  pool: string;
  kind: LivePoolKind;
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

/** The chain moves every 400 ms: a merged market read is kept this long, whoever asks. */
export const LIVE_MARKET_TTL_MS = 1_500;
/** DexScreener refreshes its pairs every few seconds and lags the chain anyway: kept this long. */
export const LIVE_DEX_TTL_MS = 3_000;
/** A pool not read here (or failing) is asked again after this long. */
export const UNREAD_POOL_TTL_MS = 60_000;
/** Node calls a market refresh may spend (two the first time a vault pool is seen). */
const MARKET_CALLS = 2;
/** A holders read costs a dozen node calls: kept this long. */
export const LIVE_HOLDERS_TTL_MS = 15_000;
/** Node calls a holders refresh may spend, and its time. */
const HOLDERS_CALLS = 12;
const HOLDERS_TIMEOUT_MS = 6_000;
/**
 * A chain price this far from DexScreener's (either way) is not shown: a
 * pool that moved that much in DexScreener's lag is rarer than a misread.
 */
export const MAX_CHAIN_GAP = 5;

export const liveMarketCache = new SharedCache<LiveMarket>({
  prefix: 'seal:live:market:v2',
  ttlMs: LIVE_MARKET_TTL_MS,
  maxEntries: 500,
});
export const liveHoldersCache = new SharedCache<LiveHolders>({
  prefix: 'seal:live:holders:v1',
  ttlMs: LIVE_HOLDERS_TTL_MS,
  maxEntries: 300,
});

/** DexScreener's side of a live read: the figures the chain does not give, and the main pair. */
export type LiveDex = {
  at: string;
  pair: string | null;
  priceUsd: number | null;
  priceNative: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  liquidityToMarketCap: number | null;
  volume24hUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
  perTradeUsd24h: number | null;
};

export const liveDexCache = new SharedCache<LiveDex>({
  prefix: 'seal:live:dex:v1',
  ttlMs: LIVE_DEX_TTL_MS,
  maxEntries: 500,
});

/** Pools found not readable here, until when: they are not asked again every poll. */
const unread = new Map<string, number>();

export async function readLiveDex(token: string, signal?: AbortSignal): Promise<LiveDex> {
  const pairs = await fetchSolanaPairs(token, signal ? { signal } : {});
  const d = toSolanaMarketState(token, pairs).data;
  return {
    at: new Date().toISOString(),
    pair: d.pair,
    priceUsd: d.priceUsd,
    priceNative: d.priceNative,
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

const ratioOf = (part: number | null, whole: number | null): number | null =>
  part === null || whole === null || whole <= 0
    ? null
    : Math.round((part / whole) * 10_000) / 10_000;

/**
 * The live market from DexScreener's read and the pool's, when there is one.
 * The chain gives the price; market cap and FDV keep DexScreener's supply
 * (its figure over its price), so they stay those of the report, and the
 * mint's supply read beside the pool is used when DexScreener gives none.
 */
export function liveMarketOf(
  token: string,
  dex: LiveDex,
  chain: PoolPrice | null,
  at: string,
): LiveMarket {
  const volume = {
    volume24hUsd: dex.volume24hUsd,
    buys24h: dex.buys24h,
    sells24h: dex.sells24h,
    perTradeUsd24h: dex.perTradeUsd24h,
  };
  if (!chain) {
    return {
      token,
      at: dex.at,
      priceUsd: dex.priceUsd,
      marketCapUsd: dex.marketCapUsd,
      fdvUsd: dex.fdvUsd,
      liquidityUsd: dex.liquidityUsd,
      liquidityToMarketCap: dex.liquidityToMarketCap,
      ...volume,
      chain: null,
      dexAt: dex.at,
    };
  }
  const supplyOf = (figure: number | null) =>
    figure !== null && dex.priceUsd ? figure / dex.priceUsd : null;
  const fdvSupply = supplyOf(dex.fdvUsd) ?? chain.supply;
  const mcapSupply = supplyOf(dex.marketCapUsd);
  const fdvUsd = chain.priceUsd * fdvSupply;
  const marketCapUsd = mcapSupply !== null ? chain.priceUsd * mcapSupply : null;
  const liquidityUsd = chain.liquidityUsd ?? dex.liquidityUsd;
  return {
    token,
    at,
    priceUsd: chain.priceUsd,
    marketCapUsd,
    fdvUsd,
    liquidityUsd,
    liquidityToMarketCap: ratioOf(liquidityUsd ?? chain.curveLiquidityUsd, marketCapUsd ?? fdvUsd),
    ...volume,
    chain: {
      priceUsd: chain.priceUsd,
      priceSol: chain.quoteMint === NATIVE_MINT ? chain.priceQuote : null,
      marketCapUsd: marketCapUsd ?? fdvUsd,
      liquidityUsd: chain.liquidityUsd ?? chain.curveLiquidityUsd,
      slot: chain.slot,
      readAt: at,
      pool: chain.pool,
      kind: chain.kind,
    },
    dexAt: dex.at,
    ...(chain.curveLiquidityUsd !== null ? { curveLiquidityUsd: chain.curveLiquidityUsd } : {}),
  };
}

/** Whether a chain price is close enough to DexScreener's to be the same pool read right. */
export function plausible(chain: PoolPrice, dex: LiveDex): boolean {
  if (!dex.priceUsd) return true;
  const gap = chain.priceUsd / dex.priceUsd;
  return gap < MAX_CHAIN_GAP && gap > 1 / MAX_CHAIN_GAP;
}

export async function readLiveMarket(token: string, signal?: AbortSignal): Promise<LiveMarket> {
  let dex = (await liveDexCache.get(token).catch(() => undefined)) ?? null;
  if (!dex) {
    dex = await readLiveDex(token, signal);
    await liveDexCache.set(token, dex).catch(() => false);
  }
  let chain: PoolPrice | null = null;
  const pool = dex.pair;
  if (pool && (unread.get(pool) ?? 0) <= Date.now()) {
    try {
      const rpc = createSolanaRpc({ maxCalls: MARKET_CALLS, ...(signal ? { signal } : {}) });
      const solUsdHint = dex.priceUsd && dex.priceNative ? dex.priceUsd / dex.priceNative : null;
      chain = await readPoolPrice(rpc, token, pool, { solUsdHint });
      if (chain && !plausible(chain, dex)) {
        log.warn('prix on-chain écarté', { token, pool, chain: chain.priceUsd, dex: dex.priceUsd });
        chain = null;
      }
      if (!chain) unread.set(pool, Date.now() + UNREAD_POOL_TTL_MS);
    } catch (error) {
      // The node failing: DexScreener's figures, said as such; asked again next poll.
      log.warn('prix on-chain indisponible', { token, pool, error: String(error) });
    }
  }
  return liveMarketOf(token, dex, chain, new Date().toISOString());
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
