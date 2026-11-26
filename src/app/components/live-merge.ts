import type { ReportFacts } from '@/lib/facts';
import type { LiveValues } from '@/lib/flags';
import type { LiveHolders, LiveMarket } from '@/lib/live';

/**
 * The report's facts with the live reads laid over them: the market from the
 * last poll, the holders from the last refresh. A figure the live read does
 * not give (a curve's liquidity, which DexScreener does not list) keeps the
 * report's.
 */
export function liveFacts(
  facts: ReportFacts,
  market: LiveMarket | null,
  holders: LiveHolders | null,
): ReportFacts {
  const keep = <T>(value: T | null | undefined, fallback: T): T =>
    value === null || value === undefined ? fallback : value;
  return {
    ...facts,
    market: market
      ? {
          ...facts.market,
          priceUsd: keep(market.priceUsd, facts.market.priceUsd),
          liquidityUsd: keep(market.liquidityUsd, facts.market.liquidityUsd),
          volume24hUsd: keep(market.volume24hUsd, facts.market.volume24hUsd),
          buys24h: keep(market.buys24h, facts.market.buys24h),
          sells24h: keep(market.sells24h, facts.market.sells24h),
          fdvUsd: keep(market.fdvUsd, facts.market.fdvUsd),
          marketCapUsd: keep(market.marketCapUsd, facts.market.marketCapUsd ?? null),
          liquidityToMarketCap: keep(
            market.liquidityToMarketCap,
            facts.market.liquidityToMarketCap ?? null,
          ),
          // The same pairs as the volume: never a stale average beside a fresh volume.
          perTradeUsd24h: market.perTradeUsd24h,
        }
      : facts.market,
    holders: holders
      ? {
          ...facts.holders,
          holderCount: keep(holders.holderCount, facts.holders.holderCount),
          top1OfSupply: keep(holders.top1OfSupply, facts.holders.top1OfSupply ?? null),
          top10OfSupply: keep(holders.top10OfSupply, facts.holders.top10OfSupply ?? null),
        }
      : facts.holders,
  };
}

/** The live values the flags are drawn again with. */
export function liveValues(
  market: LiveMarket | null,
  holders: LiveHolders | null,
): LiveValues | null {
  if (!market && !holders) return null;
  const out: LiveValues = {};
  if (market) {
    const mcap = market.marketCapUsd ?? market.fdvUsd;
    if (mcap !== null) out.mcap = mcap;
    if (market.liquidityUsd !== null) out.liquidity = market.liquidityUsd;
    if (market.liquidityToMarketCap !== null) out.ratio = market.liquidityToMarketCap;
    if (market.volume24hUsd !== null) out.volume24h = market.volume24hUsd;
  }
  if (holders) {
    if (holders.top10OfSupply !== null) out.top10 = holders.top10OfSupply;
    if (holders.top1OfSupply !== null) out.top1 = holders.top1OfSupply;
    if (holders.holderCount !== null) out.holders = holders.holderCount;
    if (holders.devHolds !== null) out.devHolds = holders.devHolds;
  }
  return out;
}
