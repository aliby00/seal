import type { LaunchMove, LaunchReplayData } from './contracts/launch';

/**
 * The first minutes of a token, told as a story a non-technical reader can
 * follow: what the creator took at launch, how fast the first buyers came,
 * and what they still hold today. Every number is read from the moves; a
 * balance that could not be read is never counted as zero.
 */

/** Buys in this many seconds count as "the first buyers". */
export const EARLY_SECONDS = 60;
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
  bundle: { transaction: string; wallets: number; share: number; seconds: number } | null;
  /** True when the window had more moves than were read. */
  partial: boolean;
  /**
   * True when nearly everything was bought in the first second: a curve over
   * ten minutes would be one flat block, so a plain comparison says it better.
   */
  frontLoaded: boolean;
};

/** Wallets served by one transaction before it reads as "bought together". */
export const BUNDLE_MIN_WALLETS = 3;

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
      }))
      .sort((a, b) => b.share - a.share)[0] ?? null;

  return {
    bundle,
    creatorAtLaunch,
    creatorSold: sales.reduce((sum, m) => sum + m.share, 0),
    early: {
      wallets: early.length,
      share: early.reduce((sum, b) => sum + b.bought, 0),
      within: early.length ? Math.max(...early.map((b) => b.firstAt)) : 0,
      heldNow: read.length ? read.reduce((sum, b) => sum + keep(b), 0) : null,
      unread: early.length - read.length,
    },
    buyers,
    curve,
    creatorSales: sales.map((m) => ({ seconds: m.seconds, share: m.share })),
    partial: launch.movesInWindow > launch.moves.length,
    frontLoaded:
      bought > 0 && (curve.filter((p) => p.seconds <= 1).at(-1)?.bought ?? 0) >= bought * 0.9,
  };
}
