import type { LaunchMove, LaunchReplayData } from './contracts/launch';
import type { LaunchGraduation } from './contracts/creator';
import type { AddressRoleKind, NamedAddress, VestingLock } from './contracts/roles';

/**
 * Where the supply went at launch, as a person would draw it: created, then
 * handed to its first holders (a curve, a pool, the creator, a launchpad's
 * wallet), then passed on by them to others — each with its share, its name
 * by role, and what it holds today.
 *
 * Built from the launch replay's moves and the names read on chain; nothing
 * is inferred beyond them. SIRIUS: 50 % to Virtuals' launch curve, 50 % to
 * Virtuals' reserve wallet, which passed 25 % to Virtuals' capital-formation
 * wallet at +29 s and 25 % to the creator's TokenTable lock at +90 s.
 */

export type FlowNodeKind =
  | AddressRoleKind
  | 'creator'
  | 'wallet'
  | 'contract'
  | 'burn'
  /** Everyone who bought on the curve, together: no single address. */
  | 'buyers';

export type FlowNode = {
  address: string;
  kind: FlowNodeKind;
  /** Its name by role: "Virtuals’ team lock (TokenTable)", "the creator", "a wallet". */
  name: string;
  /** What it does with the token, when known. */
  detail?: string;
  /** Share of the supply it received in the launch window. */
  received: number;
  /** Share it holds today; null when unread. */
  heldNow: number | null;
  /** Seconds after the launch block of its first receipt. */
  at: number;
  /** Whether what it holds can be sold today; null when not known. */
  tradable: boolean | null;
  lock?: VestingLock;
  /** What it passed on in the window, to whom. */
  children: FlowNode[];
  /** When it received: at launch (the default), or at the curve's graduation. */
  via?: 'graduation';
};

export type SupplyFlow = {
  /** The launchpad that made the token, by name. */
  launchpad: string | null;
  windowSeconds: number;
  /** The first holders of the supply, the largest first. */
  roots: FlowNode[];
  /** Purchases seen in the window: none means the launch only handed the supply out. */
  buys: number;
  /** When the curve graduated to an open market, when read. */
  graduatedAt?: string | null;
};

/** Below this share, a recipient is not drawn (dust, rounding). */
export const FLOW_MIN_SHARE = 0.001;
/** Recipients drawn under one holder, at most. */
export const FLOW_MAX_CHILDREN = 6;

const lower = (a: string) => a.toLowerCase();

function plainName(
  address: string,
  kind: LaunchMove['actorKind'],
  isCreator: boolean,
  names: ReadonlyMap<string, NamedAddress>,
): Pick<FlowNode, 'kind' | 'name' | 'detail' | 'tradable' | 'lock'> {
  const named = names.get(lower(address));
  if (named) {
    return {
      kind: named.kind,
      name: named.name,
      ...(named.detail ? { detail: named.detail } : {}),
      tradable: named.tradable,
      ...(named.lock ? { lock: named.lock } : {}),
    };
  }
  if (isCreator) return { kind: 'creator', name: 'the creator', tradable: true };
  if (kind === 'pool') return { kind: 'pool', name: 'a trading pool', tradable: false };
  if (kind === 'burn') return { kind: 'burn', name: 'a burn address', tradable: false };
  return kind === 'contract'
    ? { kind: 'contract', name: 'a contract', tradable: null }
    : { kind: 'wallet', name: 'a wallet', tradable: true };
}

/** Builds the flow, or `null` when the launch handed nothing out beyond its market. */
export function buildSupplyFlow(
  launch: LaunchReplayData,
  names: readonly NamedAddress[] = [],
  launchpad: string | null = null,
  /**
   * What each address holds today, as a share of the supply, from the holders
   * list: used where the replay could not read a balance.
   */
  heldToday?: (address: string) => number | null,
  /** The curve's graduation, when read: what was bought there, what moved to the market. */
  graduation?: LaunchGraduation | null,
): SupplyFlow | null {
  const byAddress = new Map(names.map((n) => [lower(n.address), n]));
  const node = (m: LaunchMove, address: string, kind: LaunchMove['actorKind'], creator: boolean) =>
    ({
      address: lower(address),
      ...plainName(address, kind, creator, byAddress),
      received: 0,
      heldNow: null,
      at: m.seconds,
      children: [],
    }) as FlowNode;

  const roots = new Map<string, FlowNode>();
  for (const m of launch.moves) {
    if (m.kind !== 'mint') continue;
    const key = lower(m.actor);
    const root = roots.get(key) ?? node(m, m.actor, m.actorKind, m.actorIsCreator);
    root.received += m.share;
    root.heldNow = m.heldNow;
    root.at = Math.min(root.at, m.seconds);
    roots.set(key, root);
  }
  if (roots.size === 0) return null;

  for (const m of launch.moves) {
    // A holder passing tokens on outside any market, or putting them in a pool as liquidity.
    const from =
      m.kind === 'allocation'
        ? lower(m.counterparty)
        : m.kind === 'provide'
          ? lower(m.actor)
          : null;
    const parent = from ? roots.get(from) : undefined;
    if (!parent) continue;
    const to = m.kind === 'allocation' ? m.actor : m.counterparty;
    const toKind = m.kind === 'allocation' ? m.actorKind : 'pool';
    const toCreator = m.kind === 'allocation' ? m.actorIsCreator : m.counterpartyIsCreator;
    let child = parent.children.find((c) => c.address === lower(to));
    if (!child) {
      child = node(m, to, toKind, toCreator);
      parent.children.push(child);
    }
    child.received += m.share;
    if (m.kind === 'allocation') child.heldNow = m.heldNow;
  }

  // The curve's outcome: what buyers took from it, and what its graduation
  // moved to the market and to the launchpad's excess wallet (SIRIUS: 50 %
  // in, about 35 % bought, 10.5 % to its Uniswap v2 pair, 4.5 % excess).
  if (graduation) {
    const curve = [...roots.values()].find((r) => r.kind === 'curve' && r.children.length === 0);
    if (curve) {
      const moved = (graduation.market?.share ?? 0) + (graduation.excess?.share ?? 0);
      const bought = curve.received - moved;
      const child = (
        address: string,
        share: number,
        fallback: string,
        fallbackKind: FlowNodeKind,
      ): FlowNode => {
        const named = byAddress.get(lower(address));
        return {
          address: lower(address),
          kind: named?.kind ?? fallbackKind,
          name: named?.name ?? fallback,
          ...(named?.detail ? { detail: named.detail } : {}),
          received: share,
          heldNow: null,
          at: curve.at,
          tradable: named?.tradable ?? null,
          children: [],
          via: 'graduation',
        };
      };
      if (bought >= FLOW_MIN_SHARE) {
        curve.children.push({
          address: '',
          kind: 'buyers',
          name: 'buyers on the curve',
          received: bought,
          heldNow: null,
          at: curve.at,
          tradable: true,
          children: [],
        });
      }
      if (graduation.market) {
        curve.children.push(
          child(graduation.market.address, graduation.market.share, 'its Uniswap v2 pair', 'pool'),
        );
      }
      if (graduation.excess) {
        curve.children.push(
          child(
            graduation.excess.address,
            graduation.excess.share,
            'the launchpad’s excess wallet',
            'distributor',
          ),
        );
      }
      if (curve.heldNow === null) curve.heldNow = 0;
    }
  }
  // A balance the replay could not read, taken from the holders list.
  if (heldToday) {
    const fill = (n: FlowNode) => {
      if (n.heldNow === null && n.address) n.heldNow = heldToday(n.address);
      n.children.forEach(fill);
    };
    roots.forEach(fill);
  }
  const ordered = [...roots.values()]
    .filter((r) => r.received >= FLOW_MIN_SHARE)
    .map((r) => ({
      ...r,
      children: r.children
        .filter((c) => c.received >= FLOW_MIN_SHARE)
        .sort((a, b) => b.received - a.received)
        .slice(0, FLOW_MAX_CHILDREN),
    }))
    .sort((a, b) => b.received - a.received);

  // Worth drawing only when part of the supply went somewhere other than its market.
  // A curve moving its tokens into its own pools (MUT8: 0x7ed5's curve to the
  // PoolManager and its lock contract) is the market's plumbing, not a hand-out.
  const market = (k: FlowNodeKind) =>
    k === 'pool' || k === 'curve' || k === 'launchpad' || k === 'buyers';
  const handedOut = ordered.some(
    (r) =>
      (!market(r.kind) && r.received >= 0.01) ||
      r.children.some((c) => !market(c.kind) && c.received >= 0.01 && c.via !== 'graduation'),
  );
  if (!handedOut) return null;
  const buys = launch.moves.filter((m) => m.kind === 'buy').length;
  return {
    launchpad,
    windowSeconds: launch.windowSeconds,
    roots: ordered,
    buys,
    ...(graduation ? { graduatedAt: graduation.at } : {}),
  };
}

/** "28.6%", "50%", "<0.1%": one decimal, none when it is whole. */
export function flowPct(value: number): string {
  if (value > 0 && value < 0.001) return '<0.1%';
  return `${(Math.round(value * 1000) / 10).toFixed(1).replace(/\.0$/, '')}%`;
}

/** "Nov 29, 2026", in UTC: the day an unlock comes. */
export function flowDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "locked for the creator, unlocking from Nov 29, 2026 to Jan 25, 2028". */
export function lockWords(
  lock: VestingLock,
  creator?: string | null,
  /** What the lock received at launch: more locked than that was added later. */
  received?: number,
): string {
  const beneficiaries = [...new Set(lock.schedules.map((s) => s.beneficiary).filter(Boolean))];
  const who =
    beneficiaries.length === 1
      ? creator && beneficiaries[0] === lower(creator)
        ? ' for the creator'
        : ` for ${beneficiaries[0]}`
      : beneficiaries.length > 1
        ? ` for ${beneficiaries.length} beneficiaries`
        : '';
  const first = lock.schedules.map((s) => s.startsAt).sort()[0];
  const span =
    lock.locked <= 0
      ? 'all of it unlocked already'
      : first && lock.fullyUnlockedAt
        ? lock.nextUnlockAt && lock.nextUnlockAt > first
          ? `the next unlock on ${flowDate(lock.nextUnlockAt)}, the last on ${flowDate(lock.fullyUnlockedAt)}`
          : `unlocking from ${flowDate(first)} to ${flowDate(lock.fullyUnlockedAt)}`
        : 'on a schedule';
  const later =
    received !== undefined && lock.locked - received >= 0.005
      ? ` (${flowPct(lock.locked - received)} of it added after the launch)`
      : '';
  return `${flowPct(lock.locked)} is locked${who}${later}, ${span}`;
}

/** What a node holds today, said after its name; empty when it says nothing new. */
function todayWords(n: FlowNode, creator?: string | null): string {
  if (n.lock) return `, where ${lockWords(n.lock, creator, n.received)}`;
  if (n.kind === 'curve' && n.heldNow === 0 && n.children.length === 0) {
    return ' (now empty: bought there, or moved to its trading pool at graduation)';
  }
  if (n.heldNow === null || n.kind === 'pool' || n.kind === 'curve') return '';
  if (n.heldNow === 0) return n.children.length > 0 ? '' : ', which holds none of it today';
  if (Math.abs(n.heldNow - n.received) < 0.0005) return ', which still holds it all';
  return n.heldNow < n.received
    ? `, which still holds ${flowPct(n.heldNow)}`
    : `, which holds ${flowPct(n.heldNow)} today`;
}

/** "the creator’s TokenTable lock", said lower-case inside a sentence. */
const inSentence = (name: string) => name.replace(/^(The|A|An) /, (w) => w.toLowerCase());

/**
 * The flow in one or two sentences, for the report's first line: where the
 * supply went, by role, and what the main recipients hold today.
 */
export function flowSentence(flow: SupplyFlow, creator?: string | null): string {
  const intro = flow.launchpad ? `Launched on ${flow.launchpad}. ` : '';
  const parts = flow.roots.map((r) => {
    const head = `${flowPct(r.received)} to ${inSentence(r.name)}`;
    if (r.children.length === 0) return `${head}${todayWords(r, creator)}`;
    if (r.children.every((c) => c.kind === 'buyers' || c.via === 'graduation')) {
      const buyers = r.children.find((c) => c.kind === 'buyers');
      const moved = r.children.filter((c) => c.via === 'graduation');
      const when = flow.graduatedAt ? ` on ${flowDate(flow.graduatedAt)}` : '';
      return `${head}: ${buyers ? `${flowPct(buyers.received)} bought there` : 'little bought there'}${moved.length ? `, then at graduation${when} ${moved.map((c) => `${flowPct(c.received)} to ${inSentence(c.name)}`).join(' and ')}` : ''}`;
    }
    const passed = r.children.reduce((n, c) => n + c.received, 0);
    const last = Math.max(...r.children.map((c) => c.at));
    const when = last < 90 ? `${Math.round(last)} seconds` : `${Math.round(last / 60)} minutes`;
    const kids = r.children.map(
      (c) => `${flowPct(c.received)} to ${inSentence(c.name)}${todayWords(c, creator)}`,
    );
    return `${head}, which passed ${passed >= r.received * 0.99 ? 'it all' : flowPct(passed)} on within ${when}: ${kids.join(', and ')}`;
  });
  const list =
    parts.length <= 1
      ? (parts[0] ?? '')
      : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
  const buys =
    flow.buys === 0 ? ' Nobody bought in the first minutes: the supply was only handed out.' : '';
  return `${intro}At launch, ${list.replace(/^(\S+) to /, '$1 of the supply went to ')}.${buys}`;
}

/** "2028": the year a date falls in, UTC. */
const yearOf = (iso: string) => new Date(iso).getUTCFullYear();

/**
 * The flow in one short sentence, for the report's first line (at most about
 * 20 words), and the figure it is about: what a reader must know first.
 * SIRIUS: "Launched on Virtuals: 28.6% locked for the creator until 2028,
 * 18% held by Virtuals’ capital-formation wallet."
 */
export function flowHeadline(
  flow: SupplyFlow,
  creator?: string | null,
): { figure: string; sentence: string; share: number; creatorKept: boolean } {
  const all = flow.roots.flatMap((r) => [r, ...r.children]);
  // What the creator keeps comes first, locked or not, then what a launchpad will sell.
  const clauses: { share: number; words: string; rank: number }[] = [];
  for (const n of all) {
    if (n.lock && n.lock.locked > 0) {
      const who = n.lock.schedules.every((s) => creator && s.beneficiary === creator.toLowerCase())
        ? ' for the creator'
        : '';
      const until = n.lock.fullyUnlockedAt ? ` until ${yearOf(n.lock.fullyUnlockedAt)}` : '';
      clauses.push({
        rank: 0,
        share: n.lock.locked,
        words: `${flowPct(n.lock.locked)} locked${who}${until}`,
      });
    } else if (n.kind === 'capital-formation' && (n.heldNow ?? n.received) > 0) {
      const held = n.heldNow ?? n.received;
      const pad = flow.launchpad;
      const owner = pad ? `${pad}${/s$/i.test(pad) ? '’' : '’s'}` : 'the launchpad’s';
      clauses.push({ rank: 2, share: held, words: `${flowPct(held)} held by ${owner} ACF wallet` });
    } else if (n.kind === 'creator' && n.received >= 0.01) {
      clauses.push({
        rank: 1,
        share: n.received,
        words: `${flowPct(n.received)} to the creator at launch`,
      });
    }
  }
  // Without a lock or a known role, what went outside the market at launch.
  if (clauses.length === 0) {
    const market = new Set<FlowNodeKind>(['pool', 'curve', 'launchpad']);
    const out = flow.roots.filter((r) => !market.has(r.kind));
    const share = out.reduce((n, r) => n + r.received, 0);
    const n = out.length;
    clauses.push({
      rank: 3,
      share,
      words: `${flowPct(share)} handed to ${n === 1 ? inSentence(out[0]!.name) : `${n} addresses`} at launch, not sold`,
    });
  }
  const top = [...clauses].sort((a, b) => a.rank - b.rank || b.share - a.share).slice(0, 2);
  const intro = flow.launchpad ? `Launched on ${flow.launchpad}: ` : '';
  const sentence = `${intro}${top.map((c) => c.words).join(', ')}.`;
  return {
    // What the creator itself received, unlocked, leads: a fact that deserves attention.
    creatorKept: top[0]!.rank === 1,
    share: top[0]!.share,
    figure: flowPct(top[0]!.share),
    sentence: sentence.charAt(0).toUpperCase() + sentence.slice(1),
  };
}
