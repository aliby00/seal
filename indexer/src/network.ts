import type { Db, FundingRow } from './db.ts';
import { effectiveFunder, type FunderKind } from './funder-kind.ts';

/**
 * Who funded a creator, as the API says it, and the creators linked to it
 * through the wallets above it.
 *
 * A funding is grouped by its effective funder: the funder itself, or the
 * sender behind a batch-sending tool. Only a wallet groups anything: an
 * exchange, a bridge or an unprofiled address funds everyone, so the
 * creators it funded are not listed as linked.
 */

/** Wallet levels walked above a creator: creator ← w1 ← w2 ← w3. */
export const MAX_DEPTH = 3;
/** Creators collected at most; past it the answer says it is capped. */
export const NETWORK_CAP = 500;
const MAX_ROWS = 1_000;

/** What the walk could not read yet; the stream is asked to read it first. */
export type Needs = {
  funding?: (address: string) => void;
  profile?: (address: string) => void;
  origin?: (creator: string) => void;
};

export type FunderView = {
  funder: string;
  funderKind: FunderKind;
  funderName: string | null;
  funderTxCount: number | null;
  /** The sender of the funding transaction, when the funder is a batch-sending tool. */
  origin: string | null;
  originKind: FunderKind | null;
  originTxCount: number | null;
  /** The address the funding is grouped by; `null` while a tool's sender is unread. */
  effective: string | null;
  effectiveKind: FunderKind;
  effectiveTxCount: number | null;
};

export type PathStep = {
  /** 1 = the creator's own funder. */
  level: number;
  address: string;
  kind: FunderKind;
  name: string | null;
  txCount: number | null;
  /** The batch-sending tool the funding went through, when it did. */
  via?: { address: string; name: string | null };
  /** Token creators this address funded directly, the creator asked about left out. */
  creatorsFunded: number;
};

export type Network = {
  /** Linked creators, the creator asked about left out. */
  creators: number;
  capped: boolean;
  /** Distinct tokens those creators launched. */
  launches: number;
  launchpads: Record<string, number>;
  firstLaunchAt: string | null;
  lastLaunchAt: string | null;
  /** Wallet levels whose creators were collected. */
  depth: number;
  path: PathStep[];
  incomplete: boolean;
  reason?: string;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const iso = (ts: number | null): string | null =>
  ts === null ? null : new Date(ts * 1000).toISOString();

export function createNetwork(db: Db) {
  const fundedBy = db.raw.prepare(
    `SELECT f.creator, f.tx_hash, f.block, f.kind FROM funding f
     WHERE f.effective = ? AND f.status = 'found'
       AND EXISTS (SELECT 1 FROM launches l WHERE l.creator = f.creator)
     ORDER BY f.block LIMIT ${MAX_ROWS}`,
  );
  const groupedOrDirect = db.raw.prepare(
    `SELECT f.creator, f.tx_hash, f.block, f.kind FROM funding f
     WHERE (f.effective = ? OR (f.effective IS NULL AND f.funder = ?)) AND f.status = 'found'
       AND EXISTS (SELECT 1 FROM launches l WHERE l.creator = f.creator)
     ORDER BY f.block LIMIT ${MAX_ROWS}`,
  );
  const launchTotals = db.raw.prepare(
    `SELECT COUNT(DISTINCT token) AS n, MIN(ts) AS first, MAX(ts) AS last FROM launches
     WHERE creator IN (SELECT value FROM json_each(?))`,
  );
  const launchesByPad = db.raw.prepare(
    `SELECT launchpad, COUNT(DISTINCT token) AS n FROM launches
     WHERE creator IN (SELECT value FROM json_each(?)) GROUP BY launchpad ORDER BY launchpad`,
  );

  function view(row: FundingRow & { funder: string }, needs: Needs = {}): FunderView {
    const profile = db.funder(row.funder);
    if (!profile) needs.profile?.(row.funder);
    const funderKind: FunderKind = profile?.kind ?? 'unknown';
    let originKind: FunderKind | null = null;
    let originTxCount: number | null = null;
    if (funderKind === 'tool') {
      if (!row.origin) {
        needs.origin?.(row.creator);
      } else {
        const sender = db.funder(row.origin);
        if (!sender) needs.profile?.(row.origin);
        originKind = sender?.kind ?? 'unknown';
        originTxCount = sender?.tx_count ?? null;
      }
    }
    const { effective, kind } = effectiveFunder({
      funder: row.funder,
      kind: funderKind,
      origin: row.origin,
      originKind,
    });
    return {
      funder: row.funder,
      funderKind,
      funderName: profile?.name ?? null,
      funderTxCount: profile?.tx_count ?? null,
      origin: funderKind === 'tool' ? row.origin : null,
      originKind,
      originTxCount,
      effective,
      effectiveKind: kind,
      effectiveTxCount: funderKind === 'tool' ? originTxCount : (profile?.tx_count ?? null),
    };
  }

  /** Token creators funded by this effective funder. Empty for anything but a wallet. */
  function creatorsOf(
    effective: string | null,
    kind: FunderKind,
  ): { creator: string; tx_hash: string; block: number; kind: string }[] {
    if (!effective || kind !== 'wallet') return [];
    return fundedBy.all(effective) as {
      creator: string;
      tx_hash: string;
      block: number;
      kind: string;
    }[];
  }

  /**
   * Token creators grouped under this address, whatever its kind; while a
   * funder is not profiled, the fundings it made directly.
   */
  function groupedUnder(address: string) {
    return groupedOrDirect.all(address, address) as {
      creator: string;
      tx_hash: string;
      block: number;
      kind: string;
    }[];
  }

  function walk(creator: string, needs: Needs = {}): Network {
    const members = new Set<string>();
    const seen = new Set<string>([creator]);
    const path: PathStep[] = [];
    let depth = 0;
    let capped = false;
    let reason: string | undefined;
    let current = creator;

    for (let level = 1; level <= MAX_DEPTH; level += 1) {
      const row = db.funding(current);
      if (!row) {
        needs.funding?.(current);
        reason =
          level === 1
            ? 'the creator’s first funding has not been read yet'
            : `the first funding of ${short(current)} has not been read yet`;
        break;
      }
      if (row.status !== 'found' || !row.funder) break;
      const v = view(row as FundingRow & { funder: string }, needs);
      if (v.funderKind === 'unknown') {
        reason = `the funder ${short(v.funder)} has not been profiled yet`;
      } else if (v.funderKind === 'tool' && !v.origin) {
        reason = `the sender behind the batch-sending tool ${short(v.funder)} has not been read yet`;
      } else if (v.effectiveKind === 'unknown' && v.origin) {
        reason = `the sender ${short(v.origin)} has not been profiled yet`;
      }
      const address = v.effective ?? v.funder;
      const step: PathStep = {
        level,
        address,
        kind: v.effective ? v.effectiveKind : v.funderKind,
        name: v.funderKind === 'tool' ? null : v.funderName,
        txCount: v.effectiveTxCount,
        ...(v.funderKind === 'tool' ? { via: { address: v.funder, name: v.funderName } } : {}),
        creatorsFunded: 0,
      };
      path.push(step);
      if (reason || step.kind !== 'wallet' || !v.effective || seen.has(v.effective)) break;
      seen.add(v.effective);
      depth = level;
      for (const r of creatorsOf(v.effective, 'wallet')) {
        // The wallet below may be a creator itself: it is linked too.
        if (r.creator === creator) continue;
        step.creatorsFunded += 1;
        if (members.size >= NETWORK_CAP) {
          capped = true;
          continue;
        }
        members.add(r.creator);
      }
      current = v.effective;
    }

    const list = JSON.stringify([...members]);
    const totals =
      members.size > 0
        ? (launchTotals.get(list) as { n: number; first: number | null; last: number | null })
        : { n: 0, first: null, last: null };
    const launchpads: Record<string, number> = {};
    if (members.size > 0) {
      for (const r of launchesByPad.all(list) as { launchpad: string; n: number }[]) {
        launchpads[r.launchpad] = r.n;
      }
    }
    return {
      creators: members.size,
      capped,
      launches: totals.n,
      launchpads,
      firstLaunchAt: iso(totals.first),
      lastLaunchAt: iso(totals.last),
      depth,
      path,
      incomplete: reason !== undefined,
      ...(reason ? { reason } : {}),
    };
  }

  return { view, creatorsOf, groupedUnder, walk };
}
