import type { TokenReport } from './contracts';

/**
 * The numbers the report screen draws, taken from the collected report and
 * nothing else. Each block says whether it was measured: a missing block is
 * drawn as "not measured", never as zero — a 0 % concentration bar would read
 * as a fact about the token.
 *
 * There is no overall score here, on purpose: SEAL shows what each source
 * observed, and never folds them into a grade.
 */
export type ReportFacts = {
  creator: {
    measured: boolean;
    /** Why it is missing or partial, in the source's words. */
    note?: string;
    address: string | null;
    launched: number;
    /** Launches read in detail (the counts below are over these). */
    detailed: number;
    graduated: number;
    abandoned: number;
    undetermined: number;
    active: number;
    /** Launches whose sales and liquidity were checked, and what was seen. */
    checked: number;
    soldIntoPool: number;
    liquidityPulled: number;
  };
  holders: {
    measured: boolean;
    note?: string;
    holderCount: number | null;
    top1: number;
    top10: number;
    /** Largest holders, pools and burn addresses excluded. */
    top: { address: string; share: number; kind: 'wallet' | 'contract' }[];
  };
  market: {
    measured: boolean;
    note?: string;
    priceUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    buys24h: number | null;
    sells24h: number | null;
    fdvUsd: number | null;
    graduation: { progress: number; thresholdEth: number; graduated: boolean } | null;
  };
};

const TOP_SHOWN = 8;

export function toFacts(report: TokenReport): ReportFacts {
  const { creator, holders, market } = report;
  const tokens = creator.data.tokens;
  const checked = tokens.filter((t) => t.creatorDumped !== null || t.liquidityPulled !== null);
  const note = (sources: { note?: string }[]) => sources.find((s) => s.note)?.note;

  return {
    creator: {
      measured: creator.completeness !== 'unavailable',
      note: note(creator.sources),
      address: creator.data.creator && creator.data.creator !== '0x' ? creator.data.creator : null,
      launched: creator.data.counts.launched,
      detailed: tokens.length,
      graduated: tokens.filter((t) => t.outcome === 'graduated').length,
      abandoned: tokens.filter((t) => t.outcome === 'abandoned').length,
      undetermined: tokens.filter((t) => t.outcome === 'undetermined').length,
      active: tokens.filter((t) => t.outcome === 'active').length,
      checked: checked.length,
      soldIntoPool: tokens.filter((t) => t.creatorDumped === true).length,
      liquidityPulled: tokens.filter((t) => t.liquidityPulled === true).length,
    },
    holders: {
      measured: holders.completeness !== 'unavailable',
      note: note(holders.sources),
      holderCount: holders.data.holderCount,
      top1: holders.data.concentration.top1,
      top10: holders.data.concentration.top10,
      top: holders.data.top
        .filter(
          (h): h is typeof h & { kind: 'wallet' | 'contract' } =>
            h.kind === 'wallet' || h.kind === 'contract',
        )
        .slice(0, TOP_SHOWN)
        .map((h) => ({ address: h.address, share: h.share, kind: h.kind })),
    },
    market: {
      measured: market.completeness !== 'unavailable',
      note: note(market.sources),
      priceUsd: market.data.priceUsd,
      liquidityUsd: market.data.liquidityUsd,
      volume24hUsd: market.data.volumeUsd?.h24 ?? null,
      buys24h: market.data.txns?.h24.buys ?? null,
      sells24h: market.data.txns?.h24.sells ?? null,
      fdvUsd: market.data.fdvUsd,
      graduation: market.data.graduation
        ? {
            progress: market.data.graduation.progress,
            thresholdEth: market.data.graduation.thresholdEth,
            graduated: market.data.graduation.graduated,
          }
        : null,
    },
  };
}

/**
 * The creator's launches in time order, for the report's timeline. Each one
 * keeps its own outcome and what was checked on it; nothing is summed here.
 * `current` marks the token being analysed.
 */
export type TimelineLaunch = {
  address: string;
  launchedAt: string | null;
  block: number;
  outcome: 'graduated' | 'active' | 'abandoned' | 'undetermined';
  /** Share of the graduation threshold reached, 0 to 1. */
  progress: number;
  sold: boolean | null;
  pulled: boolean | null;
  current: boolean;
};

export function toTimeline(report: TokenReport): TimelineLaunch[] {
  if (report.creator.completeness === 'unavailable') return [];
  const token = report.token.toLowerCase();
  return [...(report.creator.data.tokens ?? [])]
    .sort((a, b) => a.launchedAtBlock - b.launchedAtBlock)
    .map((t) => ({
      address: t.address,
      launchedAt: t.launchedAt,
      block: t.launchedAtBlock,
      outcome: t.outcome,
      progress: t.graduationProgress,
      sold: t.creatorDumped,
      pulled: t.liquidityPulled,
      current: t.address.toLowerCase() === token,
    }));
}
