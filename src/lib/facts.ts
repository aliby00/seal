import type { CheckedLaunchpad } from './checked-sample';
import type {
  CreatorLinks,
  FailedRead,
  FeePayer,
  LaunchReplayData,
  NamedAddress,
  SetAsideRole,
  TokenReport,
} from './contracts';
import type { SolanaLaunchReplay } from './solana/launch-types';
import { buildSupplyFlow, type SupplyFlow } from './supply-flow';

/**
 * The numbers the report screen draws, taken from the collected report and
 * nothing else. Each block says whether it was measured: a missing block is
 * drawn as "not measured", never as zero — a 0 % concentration bar would read
 * as a fact about the token.
 *
 * There is no overall score here, on purpose: SEAL shows what each source
 * observed, and never folds them into a grade.
 *
 * TODO-SOLANA: this is the screen's shape from the Robinhood Chain reports,
 * kept so the UI compiles while it is rewritten for Solana. `toFacts` fills
 * it from the Solana report; the fields only EVM reads had (v4 fees, the
 * indexer's pool activity, the ETH graduation threshold, pons origins) stay
 * absent or null. The new UI should read the TokenReport blocks instead.
 */
export type ReportFacts = {
  /**
   * The reads that failed this time: what they would have found is unknown,
   * and the report says it is partial. Absent when every read answered.
   */
  failed?: FailedRead[];
  /**
   * Where the supply went at launch, by role: drawn when the launch handed
   * part of it to others than its market. Absent otherwise.
   */
  supplyFlow?: SupplyFlow;
  /** What the main addresses are, read on chain (locks, pools, launchpad wallets). */
  roles?: NamedAddress[];
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
      /** What it is, when the chain says more: "Virtuals’ capital-formation wallet (ACF)". */
      name?: string;
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
    setAside?: { address: string; role: SetAsideRole; share: number | null; name?: string }[];
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

/** Who a removal's sender, or a recipient, is to the creator. Exact match: base58 is case-sensitive. */
export function partyOf(address: string, creator: string, funder?: string): Party {
  if (address === creator) return 'creator';
  return funder && address === funder ? 'funder' : 'other';
}

const TOP_SHOWN = 8;

/**
 * The Solana launch replay in the shape the screen's launch views read
 * (contracts/launch.ts): the same moves and summary, the creation slot as
 * the launch block. `null` when the creation was not found.
 */
export function launchView(replay: SolanaLaunchReplay | undefined): LaunchReplayData | null {
  const d = replay?.data;
  if (!d || d.launchBlock === null || d.supply === null) return null;
  return {
    token: d.token,
    launchBlock: d.launchBlock,
    launchedAt: d.launchedAt,
    windowSeconds: d.windowSeconds,
    supply: d.supply,
    moves: d.moves,
    movesInWindow: d.movesInWindow,
    ...(d.summary ? { summary: d.summary } : {}),
  };
}

/**
 * What an address holds today, as a share of the whole supply, read from the
 * holders list. The list holds the largest only: an address absent from it is
 * unread, never "nothing".
 */
function heldFromHolders(report: TokenReport): (address: string) => number | null {
  const holders = report.holders;
  if (holders.completeness === 'unavailable') return () => null;
  const shares = new Map<string, number>();
  for (const h of holders.data.top) shares.set(h.address, h.ofSupply);
  for (const s of holders.data.setAside ?? []) {
    if (s.share !== null && !shares.has(s.address)) shares.set(s.address, s.share);
  }
  return (address) => shares.get(address) ?? null;
}

const noteOf = (sources: readonly { note?: string }[]) => sources.find((s) => s.note)?.note;

function creatorFacts(report: TokenReport): ReportFacts['creator'] {
  const { creator, creatorHistory: history, creatorOnToken: onToken } = report;
  const tokens = history && history.completeness !== 'unavailable' ? history.data.tokens : [];
  const count = (outcome: string) => tokens.filter((t) => t.outcome === outcome).length;
  // The analysed token, when its curve is complete, is one graduation more.
  const ownGraduation = report.graduation?.data.graduated === true ? 1 : 0;
  // What the creator did with this token, when its moves were read.
  const sold = onToken && onToken.completeness !== 'unavailable' ? onToken.data.sold !== '0' : null;
  const from = creator.data.from;
  const pad = report.launchpad.data.launchpad;
  return {
    measured: creator.completeness !== 'unavailable',
    note: noteOf(creator.sources),
    address: creator.data.creator,
    // The analysed token counts as one of its launches: the history leaves it out.
    launched: (history?.data.counts.launched ?? 0) + (creator.data.creator ? 1 : 0),
    detailed: tokens.length,
    graduated: count('graduated') + ownGraduation,
    // TODO-SOLANA: Solana's `dead` (launched over a day ago, no trade in 24 h)
    // is shown where the EVM screen said "abandoned"; the wording is the UI's.
    abandoned: count('dead'),
    undetermined: count('unknown'),
    active: count('active'),
    checked: sold === null ? 0 : 1,
    soldIntoPool: sold === true ? 1 : 0,
    liquidityPulled: 0,
    salesChecked: sold === null ? 0 : 1,
    liquidityChecked: 0,
    source: null,
    role: null,
    launchContract: null,
    launchesListed: history?.data.scanned.pumpCurvesListed === true,
    transactionCount: null,
    launchpad: pad?.name ?? null,
    creatorFrom:
      from === 'pump-curve'
        ? 'launch-record'
        : from === 'creation-transaction'
          ? 'transaction'
          : null,
    notListed: [],
    graduation: pad ? (report.graduation ? 'measured' : 'not-measured') : 'not-applicable',
    ...(onToken && sold !== null
      ? { ownSales: { days: null, wholeLife: onToken.completeness === 'full' } }
      : {}),
  };
}

export function toFacts(report: TokenReport, options: { funder?: string } = {}): ReportFacts {
  void options;
  const { holders, market } = report;
  const launch = launchView(report.launch);
  const flow = launch
    ? buildSupplyFlow(
        launch,
        [],
        report.launchpad.data.launchpad?.name ?? null,
        heldFromHolders(report),
        null,
      )
    : null;

  return {
    ...(report.failedReads?.length ? { failed: report.failedReads } : {}),
    ...(flow ? { supplyFlow: flow } : {}),
    creator: creatorFacts(report),
    holders: {
      measured: holders.completeness !== 'unavailable',
      note: noteOf(holders.sources),
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
          ...(h.name ? { name: h.name } : {}),
        })),
      ...(holders.data.setAside ? { setAside: holders.data.setAside } : {}),
      ...(report.creatorOnToken && report.creatorOnToken.completeness !== 'unavailable'
        ? { fromCreator: report.creatorOnToken.data.sends.distinct }
        : {}),
    },
    market: {
      measured: market.completeness !== 'unavailable',
      note: noteOf(market.sources),
      priceUsd: market.data.priceUsd,
      liquidityUsd: market.data.liquidityUsd,
      ...(market.data.quiet !== undefined
        ? { quietHours: market.data.quiet === null ? null : market.data.quiet.hours }
        : {}),
      volume24hUsd: market.data.volumeUsd?.h24 ?? null,
      buys24h: market.data.txns?.h24.buys ?? null,
      sells24h: market.data.txns?.h24.sells ?? null,
      fdvUsd: market.data.fdvUsd,
      // TODO-SOLANA: the screen's graduation bar is in ETH; a Solana curve's
      // progress is in `report.graduation` (tokens sold or quote raised).
      graduation: null,
    },
  };
}

/**
 * The creator's launches in time order, for the report's timeline. Each one
 * keeps its own outcome; nothing is summed here. `current` marks the token
 * being analysed.
 */
export type TimelineLaunch = {
  address: string;
  launchedAt: string | null;
  /** The creation slot, when read (0 when unknown). */
  block: number;
  outcome: 'graduated' | 'active' | 'abandoned' | 'undetermined';
  /** Share of the graduation reached, 0 to 1 (0 when unknown). */
  progress: number;
  sold: boolean | null;
  pulled: boolean | null;
  current: boolean;
  /** The launchpad that recorded it, when a known one did. */
  launchpad?: string;
};

const OUTCOME: Record<string, TimelineLaunch['outcome']> = {
  graduated: 'graduated',
  active: 'active',
  // TODO-SOLANA: see creatorFacts.
  dead: 'abandoned',
  unknown: 'undetermined',
};

export function toTimeline(report: TokenReport): TimelineLaunch[] {
  const history = report.creatorHistory;
  if (!history || history.completeness === 'unavailable') return [];
  const others: TimelineLaunch[] = history.data.tokens.map((t) => ({
    address: t.mint,
    launchedAt: t.launchedAt,
    block: t.slot ?? 0,
    outcome: OUTCOME[t.outcome] ?? 'undetermined',
    progress: t.outcome === 'graduated' ? 1 : 0,
    sold: null,
    pulled: null,
    current: false,
    ...(t.launchpad ? { launchpad: t.launchpad } : {}),
  }));
  const creation = report.creator.data.creation;
  const graduation = report.graduation?.data;
  const onToken = report.creatorOnToken;
  const sold =
    !onToken || onToken.completeness === 'unavailable' ? null : onToken.data.sold !== '0';
  const current: TimelineLaunch = {
    address: report.token,
    launchedAt:
      report.launch.data.launchedAt ??
      (creation?.blockTime ? new Date(creation.blockTime * 1000).toISOString() : null),
    block: creation?.slot ?? report.launch.data.launchBlock ?? 0,
    outcome: graduation?.graduated ? 'graduated' : 'undetermined',
    progress: graduation?.graduated ? 1 : (graduation?.progress ?? 0),
    sold,
    pulled: null,
    current: true,
    ...(report.launchpad.data.launchpad ? { launchpad: report.launchpad.data.launchpad.name } : {}),
  };
  const time = (t: TimelineLaunch) =>
    t.launchedAt ? Date.parse(t.launchedAt) : Number.MAX_SAFE_INTEGER;
  return [...others, current].sort((a, b) => time(a) - time(b));
}
