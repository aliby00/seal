import { launchpadById } from './chain/launchpads';
import { checkedByLaunchpad, type CheckedLaunchpad } from './checked-sample';
import type { CreatorLinks, FailedRead, FeePayer, SetAsideRole, TokenReport } from './contracts';

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
  /**
   * The reads that failed this time: what they would have found is unknown,
   * and the report says it is partial. Absent when every read answered.
   */
  failed?: FailedRead[];
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
    /**
     * Launches where the creator took tokens out of a v4 position on the
     * market without removing liquidity: fees collected (AML, +387 s).
     * Absent from older reports.
     */
    feesCollected?: number;
    /**
     * What the market's trading rules (hooks) paid out to the creator over
     * this token's life: its fees, summed. Absent when none was seen.
     */
    ownFees?: {
      share: number;
      transfers: number;
      /** The contracts that paid, and what each is to this token. Absent from older reports. */
      hooks?: string[];
      payers?: FeePayer[];
    };
    /** Launches where each signal was actually measured (the other may not be). */
    salesChecked: number;
    liquidityChecked: number;
    /**
     * The other launches checked, launchpad by launchpad: how many each has,
     * how many (the most recent) were checked, and what was seen. Absent when
     * the creator has no other launch, and from older reports.
     */
    checkedBy?: CheckedLaunchpad[];
    /** How the creator was found: their pons launch record, or the token's first mint. */
    source: 'pons' | 'deployer' | null;
    /** What the address did: created the contract, launched it through a contract, or sent its first mint. */
    role: 'deployer' | 'launcher' | 'first-minter' | null;
    /** The launch contract the creator called, when one made the token. */
    launchContract: string | null;
    /** False when the creator's other launches cannot be listed: `launched` is then a minimum. */
    launchesListed: boolean;
    /** Transactions the creator's wallet has sent (null for a contract, or when unknown). */
    transactionCount: number | null;
    /** The known launchpad that made the token, by name. Optional: absent from reports cached before launchpads. */
    launchpad?: string | null;
    /** Whether the creator is named by the launch record, or is the sender of the launch transaction. */
    creatorFrom?: 'launch-record' | 'transaction' | null;
    /** Where the creator's launches could not be listed (launchpad names, direct deploys). */
    notListed?: string[];
    /**
     * Graduation: read (pons), a step this launchpad has but SEAL does not
     * read, or a step that does not exist for this token.
     */
    graduation?: 'measured' | 'not-measured' | 'not-applicable';
    /**
     * Over how long the analysed token's own sales were read: its whole life
     * so far, or up to a day. The other launches are read over their first
     * OTHER_LAUNCH_SALES_DAYS. Absent when not checked, or from older reports.
     */
    ownSales?: { days: number | null; wholeLife: boolean } | null;
    /**
     * This token's liquidity removals: who sent each (the creator, the
     * wallet that first funded it, or another address), and to whom the
     * market returned the token, as shares of the supply. Absent when none
     * was seen, or from older reports.
     */
    ownRemovals?: {
      transaction: string;
      by: Party;
      /**
       * Whose liquidity it was: the creator's removal, or another liquidity
       * provider taking back a position of its own. Absent from older reports.
       */
      whose?: 'creator' | 'other-provider';
      sender: string;
      returned: { address: string; share: number; to: Party; heldNow: number | null }[];
    }[];
  };
  holders: {
    measured: boolean;
    note?: string;
    holderCount: number | null;
    /** Share of the whole supply still in pools and burn addresses; null when unknown. */
    pooled: number | null;
    top1: number;
    top10: number;
    /**
     * Largest holders, pools and burn addresses excluded. `fromCreator`: what
     * the holder received from the creator, as a share of the whole supply,
     * directly or `via` a contract the creator sent tokens to.
     */
    top: {
      address: string;
      share: number;
      kind: 'wallet' | 'contract';
      fromCreator?: { share: number; via: string | null };
    }[];
    /**
     * What the creator's own transfers say about the holders: burns, the
     * contracts that passed its tokens on, the holders that received from
     * it. Absent when its transfers were not all read.
     */
    creatorLinks?: CreatorLinks;
    /**
     * Distinct addresses the creator sent this token to outside its markets:
     * when it nears the holder count, most holders received tokens rather
     * than bought them. Absent when not read.
     */
    fromCreator?: number | null;
    /**
     * Where the part set aside sits: pools, curves, launch contracts, burn.
     * Optional: absent from reports cached before it was recorded.
     */
    setAside?: { address: string; role: SetAsideRole; share: number | null }[];
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
    /**
     * The liquidity DexScreener lists while the token's pools hold under 1 %
     * of its supply on chain: not current, so `liquidityUsd` is null and this
     * says what was listed. Absent when the listed figure matches the chain.
     */
    staleLiquidity?: { listedUsd: number; poolsShare: number };
    /** No trade in the last this many hours; null when trades are recent; absent when unknown. */
    quietHours?: number | null;
    /**
     * Trades counted by the SEAL indexer from the launch pool's own swaps, when
     * no listed pair gives them. No price: counts, and volume in ETH.
     */
    poolActivity?: {
      buys24h: number;
      sells24h: number;
      traders24h: number;
      /** In ETH when the pool trades against WETH, else `null`. */
      volume24hEth: number | null;
      lastTradeAt: string | null;
      /** Swaps are counted from this time on (the launch, when every swap is counted). */
      coveredFrom: string | null;
    };
  };
};

/** Who an address is to the creator. */
export type Party = 'creator' | 'funder' | 'other';

/** Who a removal's sender, or a recipient, is to the creator. */
export function partyOf(address: string, creator: string, funder?: string): Party {
  const a = address.toLowerCase();
  if (a === creator.toLowerCase()) return 'creator';
  return funder && a === funder.toLowerCase() ? 'funder' : 'other';
}

const TOP_SHOWN = 8;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

function poolActivity(
  activity: NonNullable<TokenReport['market']['data']['activity']>,
): NonNullable<ReportFacts['market']['poolActivity']> {
  let volume: number | null = null;
  if (activity.pairToken.toLowerCase() === WETH) {
    try {
      // Wei to ETH, kept to six decimals without going through a float of 1e18.
      volume = Number(BigInt(activity.h24.volume) / 1_000_000_000_000n) / 1_000_000;
    } catch {
      volume = null;
    }
  }
  return {
    buys24h: activity.h24.buys,
    sells24h: activity.h24.sells,
    traders24h: activity.h24.traders,
    volume24hEth: volume,
    lastTradeAt: activity.sinceLaunch.lastTradeAt,
    coveredFrom: activity.coveredFrom,
  };
}

function graduationOf(
  origin: TokenReport['creator']['data']['origin'],
): ReportFacts['creator']['graduation'] {
  // A history without an origin is a pons read from before origins existed.
  if (!origin || origin.source === 'pons') return 'measured';
  const launchpad = origin.launchpad ? launchpadById(origin.launchpad.id) : undefined;
  if (launchpad) return launchpad.graduates ? 'not-measured' : 'not-applicable';
  // A contract deployed on its own has no launch curve to leave.
  return origin.role === 'deployer' ? 'not-applicable' : 'not-measured';
}

export function toFacts(report: TokenReport, options: { funder?: string } = {}): ReportFacts {
  const { creator, holders, market } = report;
  const tokens = creator.data.tokens;
  // A listed liquidity the chain contradicts is not shown as liquidity.
  const stale = market.data.liquidityCheck?.current === false;
  const own = tokens.find((t) => String(t.address).toLowerCase() === report.token.toLowerCase());
  const checked = tokens.filter((t) => t.creatorDumped !== null || t.liquidityPulled !== null);
  const checkedBy =
    creator.completeness === 'unavailable' ? [] : checkedByLaunchpad(creator.data, report.token);
  const note = (sources: { note?: string }[]) => sources.find((s) => s.note)?.note;

  return {
    ...(report.failedReads?.length ? { failed: report.failedReads } : {}),
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
      ...(tokens.some((t) => t.feesCollected === true)
        ? { feesCollected: tokens.filter((t) => t.feesCollected === true).length }
        : {}),
      ...(own?.feesTaken
        ? {
            ownFees: {
              share: own.feesTaken.share,
              transfers: own.feesTaken.transfers,
              hooks: own.feesTaken.hooks,
              ...(own.feesTaken.payers ? { payers: own.feesTaken.payers } : {}),
            },
          }
        : {}),
      salesChecked: tokens.filter((t) => t.creatorDumped !== null).length,
      liquidityChecked: tokens.filter((t) => t.liquidityPulled !== null).length,
      ...(checkedBy.length > 0 ? { checkedBy } : {}),
      source: creator.data.origin?.source ?? null,
      role: creator.data.origin?.role ?? null,
      launchContract: creator.data.origin?.launchContract ?? null,
      launchesListed: creator.data.origin?.launchesListed ?? creator.completeness !== 'unavailable',
      transactionCount: creator.data.origin?.transactionCount ?? null,
      launchpad: creator.data.origin?.launchpad?.name ?? null,
      creatorFrom: creator.data.origin?.creatorFrom ?? null,
      notListed: creator.data.origin?.launchpadsNotRead ?? [],
      graduation: graduationOf(creator.data.origin),
      ...(own?.salesWindow && own.creatorDumped !== null
        ? { ownSales: { days: own.salesWindow.days, wholeLife: own.salesWindow.wholeLife } }
        : {}),
      ...(own?.liquidityRemovals?.length
        ? {
            ownRemovals: own.liquidityRemovals.map((r) => ({
              transaction: r.transaction,
              by: partyOf(r.sender, creator.data.creator, options.funder),
              whose:
                r.sender.toLowerCase() === creator.data.creator.toLowerCase()
                  ? 'creator'
                  : 'other-provider',
              sender: r.sender,
              returned: r.returned.map((x) => ({
                address: x.address,
                share: x.share,
                to: partyOf(x.address, creator.data.creator, options.funder),
                heldNow: x.heldNow,
              })),
            })),
          }
        : {}),
    },
    holders: {
      measured: holders.completeness !== 'unavailable',
      note: note(holders.sources),
      holderCount: holders.data.holderCount,
      pooled: holders.data.pooledShare ?? null,
      top1: holders.data.concentration.top1,
      top10: holders.data.concentration.top10,
      top: holders.data.top
        .filter(
          (h): h is typeof h & { kind: 'wallet' | 'contract' } =>
            h.kind === 'wallet' || h.kind === 'contract',
        )
        .slice(0, TOP_SHOWN)
        .map((h) => ({
          address: h.address,
          share: h.share,
          kind: h.kind,
          ...(h.fromCreator ? { fromCreator: h.fromCreator } : {}),
        })),
      ...(holders.data.setAside ? { setAside: holders.data.setAside } : {}),
      ...(holders.data.creatorLinks ? { creatorLinks: holders.data.creatorLinks } : {}),
      ...(own?.creatorRecipients !== undefined ? { fromCreator: own.creatorRecipients } : {}),
    },
    market: {
      measured: market.completeness !== 'unavailable',
      note: note(market.sources),
      priceUsd: market.data.priceUsd,
      liquidityUsd: stale ? null : market.data.liquidityUsd,
      ...(stale && market.data.liquidityUsd !== null && market.data.liquidityCheck
        ? {
            staleLiquidity: {
              listedUsd: market.data.liquidityUsd,
              poolsShare: market.data.liquidityCheck.poolsShare,
            },
          }
        : {}),
      ...(market.data.quiet !== undefined
        ? { quietHours: market.data.quiet === null ? null : market.data.quiet.hours }
        : {}),
      volume24hUsd: market.data.volumeUsd?.h24 ?? null,
      buys24h: market.data.txns?.h24.buys ?? null,
      sells24h: market.data.txns?.h24.sells ?? null,
      fdvUsd: market.data.fdvUsd,
      ...(market.data.activity ? { poolActivity: poolActivity(market.data.activity) } : {}),
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
  /** The launchpad that recorded it, when a known one did. */
  launchpad?: string;
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
      ...(t.launchpad ? { launchpad: t.launchpad } : {}),
    }));
}
