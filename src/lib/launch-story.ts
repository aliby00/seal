import { BUNDLE_MIN_WALLETS, EARLY_SECONDS } from './contracts/launch';
import type { LaunchMove, LaunchReplayData } from './contracts/launch';

export { BUNDLE_MIN_WALLETS, EARLY_SECONDS };

/**
 * The first minutes of a token, told as a story a non-technical reader can
 * follow: what the creator took at launch, how fast the first buyers came,
 * and what they still hold today. Every number is read from the moves; a
 * balance that could not be read is never counted as zero.
 */

/** Buyers listed by name, in the order they bought. */
export const BUYERS_LISTED = 10;

const isHolder = (m: LaunchMove) => m.actorKind === 'wallet' || m.actorKind === 'contract';

export type Buyer = {
  address: string;
  isCreator: boolean;
  /** The transaction of the first purchase, to show buyers served together. */
  transaction: string;
  /** Seconds after launch of the first purchase. */
  firstAt: number;
  /** Share of supply bought in the moves read. */
  bought: number;
  /** Share held today, `null` when unread. */
  heldNow: number | null;
};

export type StoryPoint = { seconds: number; bought: number; held: number };

export type LaunchStory = {
  /** What the creator received or bought in the launch block itself. */
  creatorAtLaunch: number;
  /** Creator sales in the window, share of supply. */
  creatorSold: number;
  early: {
    wallets: number;
    share: number;
    /** When the last of them bought. */
    within: number;
    /** What they hold today, `null` when none could be read. */
    heldNow: number | null;
    /** How many of them could not be read. */
    unread: number;
    /** How many of them are contracts; `null` when not known. */
    contracts: number | null;
  };
  buyers: Buyer[];
  /** Cumulative bought and still-held shares, in time order. */
  curve: StoryPoint[];
  /** Creator sales, to mark on the curve. */
  creatorSales: { seconds: number; share: number }[];
  /**
   * The largest transaction that delivered a purchase to several wallets at
   * once: one sender, many receivers, in a single transaction. A fact, read
   * from the transfers; nothing here says who is behind it.
   */
  bundle: {
    transaction: string;
    wallets: number;
    share: number;
    seconds: number;
    /** How many of the addresses served are contracts; `null` when not known. */
    contracts: number | null;
  } | null;
  /**
   * What the launch block's transactions sent by the creator delivered to
   * other addresses than the creator's; `null` when none, or not read.
   */
  creatorTx: { share: number; addresses: number; contracts: number | null } | null;
  /** True when the window had more moves than were read. */
  partial: boolean;
  /**
   * `all`: the totals above count every move in the window. `shown`: a replay
   * cached before the totals were kept, counted over the moves listed only —
   * to be said ("among the moves shown") whenever `partial`.
   */
  counted: 'all' | 'shown';
  /**
   * True when nearly everything was bought in the first second: a curve over
   * ten minutes would be one flat block, so a plain comparison says it better.
   */
  frontLoaded: boolean;
};

export function buildStory(launch: LaunchReplayData): LaunchStory {
  const moves = [...launch.moves].sort((a, b) => a.seconds - b.seconds);
  const creatorAtLaunch = moves
    .filter(
      (m) =>
        m.actorIsCreator &&
        m.block === 0 &&
        (m.kind === 'buy' || m.kind === 'mint' || m.kind === 'allocation'),
    )
    .reduce((sum, m) => sum + m.share, 0);
  const sales = moves.filter((m) => m.kind === 'sell' && m.actorIsCreator);
  const kindOf = new Map(moves.map((m) => [m.actor.toLowerCase(), m.actorKind]));
  const contractsAmong = (addresses: ReadonlySet<string>) =>
    [...addresses].filter((a) => kindOf.get(a) === 'contract').length;

  const byActor = new Map<string, Buyer>();
  for (const m of moves) {
    if (m.kind !== 'buy' || !isHolder(m)) continue;
    const key = m.actor.toLowerCase();
    const known = byActor.get(key);
    if (known) {
      known.bought += m.share;
      if (m.heldNow !== null) known.heldNow = m.heldNow;
    } else {
      byActor.set(key, {
        address: m.actor,
        isCreator: m.actorIsCreator,
        transaction: m.transaction.toLowerCase(),
        firstAt: m.seconds,
        bought: m.share,
        heldNow: m.heldNow,
      });
    }
  }
  const buyers = [...byActor.values()].sort((a, b) => a.firstAt - b.firstAt);

  const early = buyers.filter((b) => !b.isCreator && b.firstAt <= EARLY_SECONDS);
  const read = early.filter((b) => b.heldNow !== null);
  // What a buyer holds today counts up to what they bought here, never more.
  const keep = (b: Buyer) => Math.min(b.heldNow ?? 0, b.bought);

  const curve: StoryPoint[] = [{ seconds: 0, bought: 0, held: 0 }];
  let bought = 0;
  let held = 0;
  const counted = new Set<string>();
  for (const m of moves) {
    if (m.kind !== 'buy' || !isHolder(m)) continue;
    bought += m.share;
    const key = m.actor.toLowerCase();
    if (!counted.has(key)) {
      counted.add(key);
      held += keep(byActor.get(key)!);
    }
    const last = curve.at(-1)!;
    if (last.seconds === m.seconds) {
      last.bought = bought;
      last.held = held;
    } else curve.push({ seconds: m.seconds, bought, held });
  }
  curve.push({ seconds: launch.windowSeconds, bought, held });

  const byTx = new Map<string, { wallets: Set<string>; share: number; seconds: number }>();
  for (const m of moves) {
    if (m.kind !== 'buy' || !isHolder(m) || m.actorIsCreator) continue;
    const key = m.transaction.toLowerCase();
    const group = byTx.get(key) ?? { wallets: new Set<string>(), share: 0, seconds: m.seconds };
    group.wallets.add(m.actor.toLowerCase());
    group.share += m.share;
    byTx.set(key, group);
  }
  const bundle =
    [...byTx.entries()]
      .filter(([, g]) => g.wallets.size >= BUNDLE_MIN_WALLETS)
      .map(([transaction, g]) => ({
        transaction,
        wallets: g.wallets.size,
        share: g.share,
        seconds: g.seconds,
        contracts: contractsAmong(g.wallets),
      }))
      .sort((a, b) => b.share - a.share)[0] ?? null;

  const summary = launch.summary;
  return {
    // The totals of every move read, when the replay kept them: the moves
    // listed are a selection, and counting them alone understated a launch
    // transaction serving 100 addresses as one serving 35.
    bundle: summary
      ? summary.bundle
        ? {
            transaction: summary.bundle.transaction,
            wallets: summary.bundle.wallets,
            share: summary.bundle.share,
            seconds: summary.bundle.seconds,
            contracts: summary.bundle.contracts,
          }
        : null
      : bundle,
    creatorAtLaunch: summary ? summary.creatorAtLaunch : creatorAtLaunch,
    creatorSold: summary ? summary.creatorSold : sales.reduce((sum, m) => sum + m.share, 0),
    early: summary
      ? {
          wallets: summary.early.wallets,
          share: summary.early.share,
          within: summary.early.within,
          heldNow: summary.early.heldNow,
          unread: summary.early.unread,
          contracts: summary.early.contracts,
        }
      : {
          wallets: early.length,
          share: early.reduce((sum, b) => sum + b.bought, 0),
          within: early.length ? Math.max(...early.map((b) => b.firstAt)) : 0,
          heldNow: read.length ? read.reduce((sum, b) => sum + keep(b), 0) : null,
          unread: early.length - read.length,
          contracts: contractsAmong(new Set(early.map((b) => b.address.toLowerCase()))),
        },
    creatorTx: summary?.creatorTx
      ? {
          share: summary.creatorTx.share,
          addresses: summary.creatorTx.addresses,
          contracts: summary.creatorTx.contracts,
        }
      : null,
    counted: summary ? 'all' : 'shown',
    buyers,
    curve,
    creatorSales: sales.map((m) => ({ seconds: m.seconds, share: m.share })),
    partial: launch.movesInWindow > launch.moves.length,
    frontLoaded:
      bought > 0 && (curve.filter((p) => p.seconds <= 1).at(-1)?.bought ?? 0) >= bought * 0.9,
  };
}

/**
 * What to call the addresses a purchase reached: wallets when none is a
 * contract, contracts when all are, addresses otherwise or when not known.
 */
export function addressesWord(count: number, contracts: number | null): string {
  const one = count === 1;
  if (contracts === 0) return one ? 'wallet' : 'wallets';
  if (contracts !== null && contracts === count) return one ? 'contract' : 'contracts';
  return one ? 'address' : 'addresses';
}
