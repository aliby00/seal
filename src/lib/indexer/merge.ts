import type { IndexedListing, ListedLaunch } from '../chain/deployer';
import { LAUNCHPADS, launchpadById } from '../chain/launchpads';
import type { CreatorHistory, LaunchedToken, MarketState, PoolActivityWindow } from '../contracts';
import type { FundingFacts } from '../specialists/types';
import type { IndexerCoverage, IndexerCreator, IndexerToken, IndexerWindow } from './client';

/**
 * Ce que l'indexeur ajoute à un rapport, en fonctions pures : chaque ajout
 * garde la complétude honnête et cite l'indexeur comme source.
 */

/** Launches added from the indexer to a history, at most: the timeline stays readable. */
export const MAX_INDEXED_LAUNCHES = 50;

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

function windowOf(w: IndexerWindow): PoolActivityWindow {
  return {
    buys: w.buys,
    sells: w.sells,
    traders: w.uniqueTraders,
    volume: w.volume,
    lastTradeAt: w.lastTradeAt,
  };
}

/** "since 16 Oct 2026, 09:00 UTC", said for a person. */
function since(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/**
 * The launch pool's trades, for a pons token no listed pair covers. A market
 * that DexScreener already describes is left as it is: its counts come with a
 * price, the indexer's do not.
 */
export function withPoolActivity(
  market: MarketState,
  stats: IndexerToken | undefined,
  fetchedAt: string,
): MarketState {
  if (!stats || market.data.pair !== null) return market;
  const covered = since(stats.coveredFromAt);
  const window =
    stats.sinceLaunchComplete || !covered
      ? 'every swap since the launch is counted'
      : `swaps are counted from ${covered} on`;
  const pair = stats.launch.pairToken.toLowerCase() === WETH ? 'WETH' : 'the pair token';
  return {
    completeness: 'partial',
    sources: [
      ...market.sources,
      {
        name: 'indexer',
        fetchedAt,
        note: `trades counted from the launch pool’s own swaps by the SEAL indexer (${window}); volume is in ${pair}, and there is no price because no trading pair is listed`,
      },
    ],
    data: {
      ...market.data,
      txns: {
        h1: { buys: stats.stats.h1.buys, sells: stats.stats.h1.sells },
        h24: { buys: stats.stats.h24.buys, sells: stats.stats.h24.sells },
      },
      activity: {
        source: 'indexer',
        pool: stats.launch.pool,
        pairToken: stats.launch.pairToken,
        coveredFrom: stats.sinceLaunchComplete ? stats.launch.timestamp : stats.coveredFromAt,
        indexedTo: stats.indexedTo,
        h1: windowOf(stats.stats.h1),
        h24: windowOf(stats.stats.h24),
        d7: windowOf(stats.stats.d7),
        sinceLaunch: { ...windowOf(stats.stats.sinceLaunch), complete: stats.sinceLaunchComplete },
        creatorTraded: stats.creatorTraded.traded,
      },
    },
  };
}

/**
 * The creator's launches the RPC read did not reach (it scans ~35 days), from
 * the indexer's full list. Their outcome was not read: they are added as
 * undetermined, and the history says it is partial.
 */
export function withIndexedLaunches(
  history: CreatorHistory,
  indexed: IndexerCreator | undefined,
  fetchedAt: string,
): CreatorHistory {
  if (!indexed || history.completeness === 'unavailable') return history;
  if (indexed.creator.toLowerCase() !== history.data.creator.toLowerCase()) return history;
  const known = new Set(history.data.tokens.map((t) => t.address.toLowerCase()));
  // Only what lies before the RPC window: inside it, the RPC read is the record.
  // Only pons launches: the pons read is what this completes.
  const older = indexed.launches.filter(
    (l) =>
      (l.launchpad ?? 'pons') === 'pons' &&
      l.block < history.data.scannedRange.fromBlock &&
      !known.has(l.token.toLowerCase()),
  );
  // A capped list still gives the true total (of pons launches, when the
  // indexer reads other launchpads too: the others are merged apart).
  const ponsCount = indexed.launchpads
    ? indexed.launchCount -
      indexed.launches.filter((l) => (l.launchpad ?? 'pons') !== 'pons').length
    : indexed.launchCount;
  const extra = indexed.truncated
    ? Math.max(older.length, ponsCount - history.data.counts.launched)
    : older.length;
  if (extra <= 0) return history;

  const added: LaunchedToken[] = older.slice(0, MAX_INDEXED_LAUNCHES).map((l) => ({
    address: l.token,
    pool: l.pool,
    launchedAtBlock: l.block,
    launchedAt: l.timestamp,
    outcome: 'undetermined',
    graduationProgress: 0,
    liquidityPulled: null,
    creatorDumped: null,
  }));
  const first = older.reduce(
    (min, l) => Math.min(min, l.block),
    history.data.scannedRange.fromBlock,
  );
  return {
    completeness: 'partial',
    sources: [
      ...history.sources,
      {
        name: 'indexer',
        fetchedAt,
        note: `${extra} older launch${extra === 1 ? '' : 'es'} by this creator listed by the SEAL indexer; what became of ${extra === 1 ? 'it' : 'them'} was not checked`,
      },
    ],
    data: {
      ...history.data,
      tokens: [...history.data.tokens, ...added],
      counts: {
        ...history.data.counts,
        launched: history.data.counts.launched + extra,
        undetermined: history.data.counts.undetermined + extra,
      },
      scannedRange: { ...history.data.scannedRange, fromBlock: first },
    },
  };
}

/**
 * The creator's first funder, as the funding question reads it:
 * `undefined` = not looked up (or not yet), `null` = looked up, nothing found.
 */
export function fundingFacts(indexed: IndexerCreator | undefined): FundingFacts | null | undefined {
  if (!indexed) return undefined;
  if (indexed.fundingState === 'none') return null;
  if (indexed.fundingState !== 'found' || !indexed.funding) return undefined;
  return {
    funder: indexed.funding.funder,
    otherCreatorsFunded: indexed.funding.otherCreatorsFunded.length,
  };
}

/** An indexer this far behind the head does not list the latest launches. */
export const INDEXER_MAX_LAG_BLOCKS = 6_000;

/**
 * A creator's launches on the launchpads the indexer has read up to the head:
 * those the node is then not asked about — and the only list there is for a
 * launchpad that records the creator in its event data (flap.sh). A list the
 * indexer capped covers nothing: it would read as complete.
 */
export function indexedListing(
  found: IndexerCreator | undefined,
  coverage: IndexerCoverage | undefined,
  latestBlock: number,
): IndexedListing | undefined {
  if (!coverage || found?.truncated) return undefined;
  const covered = new Set(
    Object.entries(coverage.launchpads)
      .filter(([, indexedTo]) => indexedTo >= latestBlock - INDEXER_MAX_LAG_BLOCKS)
      .map(([id]) => id)
      .filter((id) => launchpadById(id) !== undefined),
  );
  if (covered.size === 0) return undefined;
  const launches: ListedLaunch[] = (found?.launches ?? [])
    .filter((l) => covered.has(l.launchpad ?? 'pons'))
    .map((l) => {
      const launchpad =
        LAUNCHPADS.find((p) => p.address === l.factory.toLowerCase()) ??
        launchpadById(l.launchpad ?? 'pons');
      return {
        token: l.token.toLowerCase(),
        blockNumber: l.block,
        transactionHash: l.txHash ?? '',
        ...(launchpad ? { launchpad } : {}),
      };
    });
  return { launches, covered };
}
