import type { LaunchReplayData } from './contracts/launch';
import type { ReportFacts, TimelineLaunch } from './facts';
import { addressesWord, buildStory } from './launch-story';
import { whereSetAside } from './set-aside';
import type { SpecialistAnswer } from './specialists/brief';
import type { GroupMeasure, Measures, PowerMeasure } from './specialists/types';
import { curveName } from './specialists/words';
import {
  CREATOR_HOLDS_SHARE,
  DEAD_LAUNCHES_MIN,
  EMPTY_MARKET_USD,
  GROUP_SHARE,
  GROUP_SHARE_MIN,
  LARGEST_WALLET_SHARE,
  MOSTLY_SET_ASIDE,
  THIN_LIQUIDITY_USD,
} from './specialists/thresholds';
import { READ_WORDS, readFailed } from './failed-reads';
import { flowHeadline } from './supply-flow';

export { EMPTY_MARKET_USD, THIN_LIQUIDITY_USD };

/**
 * The report's opening: what a reader should know about a Solana token in
 * ten seconds, in plain sentences. Each line restates one measured fact and
 * points to where it is shown in full: the powers the mint still gives
 * someone, where the supply sits, what the creator holds and sold (and the
 * wallets it funded), wallets that got tokens together at launch, a market
 * with next to nothing in it, and what became of the creator's other tokens.
 * Nothing is scored or summed; a line that could not be measured is listed
 * as unseen rather than left out silently.
 */

export type GlanceTone = 'attention' | 'reassuring' | 'neutral';

export type GlanceItem = {
  id: 'flow' | 'powers' | 'sales' | 'record' | 'supply' | 'launch-buys' | 'market';
  tone: GlanceTone;
  /**
   * The number the line is about, set large. Absent when no number carries
   * the line ("no other launch found" is not a "1"): the sentence stands alone.
   */
  figure?: string;
  /** One sentence, readable on its own. */
  title: string;
  /** Where the figure comes from, in a few words. */
  detail: string;
  /** The section that shows it in full. */
  href: string;
  /** A read that failed: said, after the findings, never as the first line. */
  unread?: true;
};

export type Glance = {
  /** The first line, said as a sentence: the most telling fact measured. */
  headline: string;
  items: GlanceItem[];
  /** What could not be measured, so its absence is not read as good news. */
  unseen: string[];
  /**
   * Reads that failed this time, in words: the report is partial and worth
   * asking again. Absent when every read answered.
   */
  partial?: string[];
};

/** The notice a partial report carries, wherever the glance is shown. */
export function partialNotice(partial: readonly string[]): string {
  return `Partial report: some reads failed this time (${partial.join(', ')}). What they would have shown is not known. Try again in a minute.`;
}

export type GlanceInput = {
  facts?: ReportFacts;
  timeline?: TimelineLaunch[];
  launch?: LaunchReplayData;
  /**
   * The ten questions' answers: their measures carry what the facts do not
   * (the mint's powers, the creator's part, linked wallets, launch groups,
   * the curve). Without them, the lines they feed are left out.
   */
  specialists?: SpecialistAnswer[];
};

const MAX_ITEMS = 4;
const DAY_MS = 86_400_000;

/**
 * One rule with the figures row and the text (figures.ts): "41.9%", never
 * "42%" beside it (POPCAT showed 18%, 17.5% and 17% for one holder).
 */
function pct(value: number): string {
  if (value === 0) return '0%';
  if (value === 1) return '100%';
  if (value > 0 && value < 0.0001) return '<0.01%';
  if (value > 0.999 && value < 1) return '>99.9%';
  const x = value * 100;
  // "12%", not "12.0%"; "0.2%", not "0.20%".
  return `${x.toFixed(x < 1 ? 2 : 1).replace(/\.?0+$/, '')}%`;
}

/** "1 launch", "9 launches" (not "launchs"), "141,028 trades". */
export const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : /(?:s|x|z|ch|sh)$/.test(word) ? 'es' : 's'}`;

/** "a, b and c", for a sentence. */
function joinAnd(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** Every question's measures, together: each key belongs to one question. */
function measuresOf(specialists: readonly SpecialistAnswer[] | undefined): Measures {
  const out: Measures = {};
  for (const answer of specialists ?? []) if (answer.measures) Object.assign(out, answer.measures);
  return out;
}

// ── Powers ──────────────────────────────────────────────────────────────────

/** What someone holding the power can do, as a verb phrase. */
function canWords(p: PowerMeasure, feeCharged: boolean): string | null {
  if (p.status !== 'held') return null;
  switch (p.power) {
    case 'permanent-delegate':
      return 'take or burn any holder’s tokens';
    case 'freeze':
      return 'freeze any holder’s tokens';
    case 'mint':
      return 'create new tokens';
    case 'pause':
      return p.active ? 'resume transfers' : 'pause all transfers';
    case 'transfer-hook':
      return p.active
        ? 'change the program transfers run'
        : 'add a program that can refuse transfers';
    case 'transfer-fee-change':
      return feeCharged ? 'change the transfer fee' : 'set a transfer fee of up to 100%';
    case 'default-account-state':
      return p.active ? null : 'make new token accounts start frozen';
    default:
      return null;
  }
}

/** A rule in force today, as a sentence. */
function ruleWords(p: PowerMeasure): string | null {
  if (p.status === 'none' || p.active !== true) return null;
  switch (p.power) {
    case 'transfer-fee':
      return p.fee ? `Every transfer pays a ${p.fee} fee` : 'Every transfer pays a fee';
    case 'transfer-hook':
      return 'Every transfer runs a program that can refuse it';
    case 'pause':
      return 'Transfers are paused right now';
    case 'default-account-state':
      return 'New token accounts start frozen';
    case 'non-transferable':
      return 'Holders cannot transfer it';
    default:
      return null;
  }
}

/**
 * What the mint still lets someone do to holders, and the rules it applies
 * to every transfer: the first thing to know about a Solana token, before
 * any holder or market figure (PYUSD: a permanent delegate, a freeze
 * authority and a transfer hook authority, all held).
 */
function powersItem(m: Measures): GlanceItem | null {
  if (!m.powers && !m.rules) return null;
  const all = [...(m.powers ?? []), ...(m.rules ?? [])];
  const feeCharged = all.some((p) => p.power === 'transfer-fee' && p.active === true);
  const rules = all.map(ruleWords).filter((w): w is string => w !== null);
  const held = all.filter((p) => canWords(p, feeCharged) !== null);
  const can = held.map((p) => canWords(p, feeCharged)!);
  const href =
    held.some((p) => m.powers?.includes(p)) || rules.length === 0
      ? '#question-token-powers'
      : '#question-transfer-rules';
  const detail = 'Read from the mint: its authorities and its Token-2022 extensions.';
  if (rules.length > 0 || can.length > 0) {
    const who = held.length > 0 && held.every((p) => p.byCreator) ? 'The creator' : 'Someone';
    const sentences = [
      ...rules.map((r) => `${r}.`),
      ...(can.length > 0 ? [`${who} can still ${joinAnd(can)}.`] : []),
    ];
    return { id: 'powers', tone: 'attention', title: sentences.join(' '), detail, href };
  }
  if (all.some((p) => p.status === 'unknown')) {
    return {
      id: 'powers',
      tone: 'neutral',
      title:
        'Part of what the mint allows could not be decoded: what it lets someone do is not fully known.',
      detail,
      href: '#question-token-powers',
    };
  }
  if (all.some((p) => p.power === 'metadata-update' && p.status === 'held')) {
    return {
      id: 'powers',
      tone: 'neutral',
      title:
        'Someone can still change the token’s name, symbol and image; no one can create more tokens or freeze holders.',
      detail,
      href: '#question-token-powers',
    };
  }
  // A setting not said above (a fee scheduled for a later epoch, confidential
  // transfers, a close or rate authority): "no rule acts on transfers" would deny it.
  if (all.some((p) => p.status !== 'none')) {
    return {
      id: 'powers',
      tone: 'neutral',
      title:
        'No one can create more tokens or freeze holders’ tokens; the mint keeps other settings, listed under its powers and transfer rules.',
      detail,
      href: (m.rules ?? []).some((p) => p.status !== 'none')
        ? '#question-transfer-rules'
        : '#question-token-powers',
    };
  }
  return {
    id: 'powers',
    tone: 'reassuring',
    title:
      'No one can create more tokens or freeze holders’ tokens, and no rule of the mint acts on transfers.',
    detail,
    href: '#question-token-powers',
  };
}

// ── The creator ─────────────────────────────────────────────────────────────

/** "1 wallet", "3 wallets". */
const wallets = (n: number) => plural(n, 'wallet');

/**
 * What the creator holds and sold of this token, and what the wallets it
 * sent SOL to around the launch did with it. A sale read is a sale; "has not
 * sold" is said only when every move was read.
 */
function salesItem(
  creator: ReportFacts['creator'],
  m: Measures,
  /** The read of this token's sales failed. */
  unread = false,
): GlanceItem | null {
  const c = m.creator;
  const l = m.linked;
  if (!creator.measured && !c) return null;
  if (unread && c?.hasSold !== true && (!c || creator.soldIntoPool === 0)) {
    return {
      id: 'sales',
      tone: 'neutral',
      title: 'Whether the creator sold this token could not be read this time.',
      unread: true,
      detail: 'The read of the creator’s moves did not complete; try again in a minute.',
      href: '#fact-creator',
    };
  }
  // Trades of the funded wallets not all read: what they bought and sold is a floor.
  const floor = l && !l.complete ? 'at least ' : '';
  const linkedWords =
    l && l.buyers > 0
      ? ` ${capitalized(wallets(l.buyers))} the creator sent SOL to around the launch bought ${floor}${pct(l.bought)} of the supply${l.sellers > 0 ? ` and sold ${floor}${pct(l.sold)}` : ''}${l.heldNow !== null ? `; the wallets it funded hold ${l.heldNow === 0 ? 'none of it' : pct(l.heldNow)} today` : ''}.`
      : '';
  const linkedAttention = Boolean(l && (l.sellers > 0 || l.bought >= GROUP_SHARE_MIN));
  const detail = `What the creator bought, sold and holds, read from its own token accounts${linkedWords ? ', and the trades of the wallets it funded' : ''}.`;
  if (!c) {
    // An answer cached before the measures: the facts alone.
    if (creator.salesChecked === 0) return null;
    const sold = creator.soldIntoPool > 0;
    return {
      id: 'sales',
      tone: sold ? 'attention' : 'reassuring',
      title: sold ? 'The creator sold some of this token.' : 'The creator has not sold this token.',
      detail,
      href: '#fact-creator',
    };
  }
  const holds = c.holdsNow;
  const holdsWords =
    holds === null
      ? ''
      : holds === 0
        ? ' and holds none of it today'
        : ` and holds ${pct(holds)} today`;
  // A dust sale (POPCAT's creator sold 0.0191 SOL of a two-year-old token)
  // is a fact, never the headline, and never "0.00%" beside a warning.
  if (c.hasSold === true && creator.saleSize === 'minor' && !linkedAttention) {
    return {
      id: 'sales',
      tone: 'neutral',
      title: `The creator sold only a few tokens of it${holdsWords}.${linkedWords}`,
      detail,
      href: '#fact-creator',
    };
  }
  if (c.hasSold === true) {
    const all = c.sold !== null && c.bought !== null && c.bought > 0 && c.sold >= c.bought * 0.99;
    return {
      id: 'sales',
      tone: 'attention',
      ...(c.sold !== null ? { figure: pct(c.sold) } : {}),
      title: `The creator sold ${c.sold !== null ? `${pct(c.sold)} of the supply` : 'some of this token'}${all ? ', all it had bought,' : ''}${holdsWords}.${linkedWords}`,
      detail,
      href: '#fact-creator',
    };
  }
  const bigHolder = holds !== null && holds >= CREATOR_HOLDS_SHARE;
  const holdsSentence =
    holds === null
      ? ''
      : holds === 0
        ? '; it holds none of it today'
        : `; it holds ${pct(holds)} of the supply today`;
  if (c.hasSold === false) {
    return {
      id: 'sales',
      tone: bigHolder || linkedAttention ? 'attention' : 'reassuring',
      ...(bigHolder
        ? { figure: pct(holds!) }
        : linkedAttention && l
          ? { figure: pct(l.bought) }
          : {}),
      title: `The creator has not sold this token${holdsSentence}.${linkedWords}`,
      detail,
      href: '#fact-creator',
    };
  }
  return {
    id: 'sales',
    tone: bigHolder || linkedAttention ? 'attention' : 'neutral',
    ...(bigHolder ? { figure: pct(holds!) } : {}),
    title: `No sale by the creator was seen in the transactions read (not all of them)${holdsSentence}.${linkedWords}`,
    detail,
    href: '#fact-creator',
  };
}

/**
 * "in 3 days", "within a day", or nothing when the dates are not known.
 * `dated` is how many launches the span rests on.
 */
function spanOf(
  timeline: TimelineLaunch[] | undefined,
): { days: number; words: string; dated: number } | null {
  const dates = (timeline ?? [])
    .map((l) => (l.launchedAt ? Date.parse(l.launchedAt) : NaN))
    .filter((t) => Number.isFinite(t));
  if (dates.length < 2) return null;
  const days = Math.max(1, Math.ceil((Math.max(...dates) - Math.min(...dates)) / DAY_MS));
  return { days, words: days === 1 ? 'within a day' : `in ${days} days`, dated: dates.length };
}

/** What became of the creator's other tokens: how many, and how many have no trade left. */
function recordItem(
  creator: ReportFacts['creator'],
  m: Measures,
  timeline: TimelineLaunch[] | undefined,
  /** A read of the creator's other launches failed this time. */
  unread = false,
): GlanceItem | null {
  if (!creator.measured && !m.history) return null;
  // The facts count this token among the launches; the measures do not.
  const h = m.history ?? {
    launched: Math.max(0, creator.launched - 1),
    graduated: creator.graduated,
    dead: creator.abandoned,
    active: creator.active,
    unknown: creator.undetermined,
    atLeast: !creator.launchesListed,
  };
  if (unread) {
    return {
      id: 'record',
      tone: 'neutral',
      ...(h.launched > 0 ? { figure: `${h.launched}+` } : { unread: true as const }),
      title:
        h.launched > 0
          ? `This creator launched at least ${plural(h.launched, 'other token')}; part of its history could not be read this time.`
          : 'Whether this creator launched other tokens could not be read this time.',
      detail: 'A read of the creator’s history did not complete; try again in a minute.',
      href: '#fact-creator',
    };
  }
  // Without the history read, the facts know of other launches only when
  // they count some: "no other token found" would state an unread absence.
  if (!m.history && creator.launched <= 1) return null;
  if (h.launched === 0) {
    return {
      id: 'record',
      tone: 'neutral',
      title:
        'No other token by this creator was found on pump.fun’s curves or in its transactions read.',
      detail: 'pump.fun’s curves naming the creator, and its own transactions.',
      href: '#fact-creator',
    };
  }
  const span = spanOf(timeline);
  // Many launches in a few days is a pattern worth seeing; one a month is not.
  const rapid = span !== null && span.dated >= 3 && span.days <= 7;
  const deadPattern = h.dead >= DEAD_LAUNCHES_MIN && h.dead * 2 >= h.launched;
  const spanWords = span && span.dated > h.launched ? ` ${span.words}, this one included` : '';
  const outcomes = [
    h.dead > 0
      ? `${h.dead} ${h.dead === 1 ? 'was' : 'were'} launched over a day ago and had no trade in the last 24 hours`
      : '',
    h.graduated > 0 ? `${h.graduated} graduated from their curve` : '',
    h.active > 0 ? `${h.active} traded in the last 24 hours` : '',
  ].filter(Boolean);
  return {
    id: 'record',
    tone: deadPattern || rapid ? 'attention' : 'neutral',
    figure: `${h.launched}${h.atLeast ? '+' : ''}`,
    title: `This creator launched ${h.atLeast ? 'at least ' : ''}${plural(h.launched, 'other token')}${spanWords}${outcomes.length > 0 ? `: ${joinAnd(outcomes)}` : ''}.`,
    detail:
      'pump.fun’s curves naming the creator, and its own transactions; each token’s trades from DexScreener.',
    href: '#fact-creator',
  };
}

// ── Holders ─────────────────────────────────────────────────────────────────

/** Where the supply sits: still on its curve or in its pools, or with holders. */
function supplyItem(facts: ReportFacts, launch: LaunchReplayData | undefined): GlanceItem | null {
  const fromReplay = launch?.moves
    .filter((m) => m.actorKind === 'pool' && m.heldNow !== null)
    .reduce<number | null>((max, m) => Math.max(max ?? 0, m.heldNow ?? 0), null);
  const pooled = facts.holders.pooled ?? fromReplay ?? null;
  const where = whereSetAside(facts.holders.setAside);
  const onCurve = where === 'its bonding curve';
  if (pooled !== null && pooled >= MOSTLY_SET_ASIDE) {
    return {
      id: 'supply',
      tone: 'neutral',
      figure: pct(pooled),
      // "Still … so far" only for a curve, which sells it on; burned tokens are gone for good.
      title: `${pct(pooled)} of the supply is ${onCurve ? 'still ' : ''}in ${where}: only ${pct(1 - pooled)} is held outside ${/^(?:its bonding curve|the incinerator|a liquidity lock)$/.test(where) ? 'it' : 'them'}${onCurve ? ' so far' : ''}.`,
      detail: 'Shares of the whole supply, read from the token accounts.',
      href: '#fact-holders',
    };
  }
  if (!facts.holders.measured || facts.holders.top.length === 0) return null;
  const largest = facts.holders.top[0]!;
  // Shares are of what circulates; with the set-aside part known, they are
  // restated against the whole supply so 70% does not read as 70% of it.
  const whole = pooled !== null ? largest.share * (1 - pooled) : null;
  const creator = facts.creator.address;
  const who =
    creator && largest.address === creator
      ? 'The creator'
      : largest.name && largest.name !== 'wallet'
        ? capitalized(largest.name)
        : largest.kind === 'contract'
          ? 'One program account'
          : 'One wallet';
  const locks = (facts.holders.setAside ?? []).filter((s) => s.role === 'vesting');
  const lockWords =
    locks.length > 0 && !facts.supplyFlow
      ? ` ${pct(locks.reduce((n, l) => n + (l.share ?? 0), 0))} of the supply sits in ${locks.length === 1 ? (locks[0]!.name ?? 'a lock') : `${locks.length} locks`}, left out: it cannot be sold before it unlocks.`
      : '';
  return {
    id: 'supply',
    tone: largest.share >= LARGEST_WALLET_SHARE ? 'attention' : 'neutral',
    figure: pct(largest.share),
    title:
      whole !== null
        ? `${who} holds ${pct(largest.share)} of the tokens held outside ${where} (${pct(whole)} of the whole supply).${lockWords}`
        : `${who} holds ${pct(largest.share)} of the tokens held outside ${where}.${lockWords}`,
    detail: `The largest holder; curves, pools${locks.length > 0 ? ', locks' : ''} and the incinerator left out.`,
    href: '#fact-holders',
  };
}

/**
 * Where the supply went at launch, in one short sentence, when the launch
 * handed it out beyond its curve or pools. The drawing below carries the detail.
 */
function flowItem(facts: ReportFacts): GlanceItem | null {
  const flow = facts.supplyFlow;
  if (!flow) return null;
  // A mint created on its own mints its whole supply to its creator: "100%
  // to the creator at launch" is true of every such token and tells nothing.
  // What the creator still holds today does.
  const only = flow.roots.length === 1 ? flow.roots[0]! : null;
  if (
    only &&
    !flow.launchpad &&
    only.kind === 'creator' &&
    only.received >= 0.995 &&
    only.children.length === 0 &&
    only.heldNow !== null
  ) {
    const held = only.heldNow;
    return {
      id: 'flow',
      tone: held >= CREATOR_HOLDS_SHARE ? 'attention' : 'neutral',
      figure: pct(held),
      title:
        held >= 0.995
          ? 'The creator minted the whole supply to itself and still holds all of it.'
          : held < 0.001
            ? 'The creator minted the whole supply to itself and holds none of it today.'
            : `The creator minted the whole supply to itself and still holds ${pct(held)} of it.`,
      detail: 'Where the supply went at launch, drawn below with what each address holds today.',
      href: '#supply-flow',
    };
  }
  const { figure, sentence, share, creatorKept } = flowHeadline(flow, facts.creator.address);
  // Nothing worth a first line: the other findings lead.
  if (share < 0.01) return null;
  return {
    id: 'flow',
    tone: creatorKept && share >= CREATOR_HOLDS_SHARE ? 'attention' : 'neutral',
    figure,
    title: sentence,
    detail: 'Where the supply went at launch, drawn below with what each address holds today.',
    href: '#supply-flow',
  };
}

// ── The launch ──────────────────────────────────────────────────────────────

function heldWords(g: GroupMeasure): string {
  if (g.heldNow === null) return '';
  return g.heldNow === 0 ? '; they hold none of it today' : `; they hold ${pct(g.heldNow)} today`;
}

/**
 * Wallets that got tokens together at launch: in transactions the creator
 * (or the creation's fee payer) paid for, or in the creation slot itself.
 * Facts only: what they got and hold, never what they are.
 */
function launchBuysItem(
  launch: LaunchReplayData | undefined,
  m: Measures,
  /** The replay's read failed this time: what the groups got is what was read, a floor. */
  cut = false,
): GlanceItem | null {
  const atLeast = cut ? 'at least ' : '';
  const groups = m.launch;
  const paid = groups?.payerGroup;
  const slot = groups?.sameSlot;
  // The larger group leads: 2% paid by the creator must not hide 40% got in the creation slot.
  if (paid && paid.share >= GROUP_SHARE_MIN && (!slot || paid.share >= slot.share)) {
    return {
      id: 'launch-buys',
      tone: paid.share >= GROUP_SHARE ? 'attention' : 'neutral',
      figure: pct(paid.share),
      title: `${capitalized(wallets(paid.wallets))} got ${atLeast}${pct(paid.share)} of the supply in transactions paid by the creator or by the creation’s fee payer${heldWords(paid)}.`,
      detail: 'Read from the first transactions after the creation, by who paid each one.',
      href: '#launch-title',
    };
  }
  if (slot && slot.share >= GROUP_SHARE_MIN) {
    return {
      id: 'launch-buys',
      tone: slot.share >= GROUP_SHARE ? 'attention' : 'neutral',
      figure: pct(slot.share),
      title: `In the creation slot, ${wallets(slot.wallets)} other than the creator got ${atLeast}${pct(slot.share)} of the supply${heldWords(slot)}.`,
      detail: 'Read from the transactions of the slot the token was created in.',
      href: '#launch-title',
    };
  }
  if (!launch) return null;
  // The totals of every move read when the replay kept them; an older replay
  // only has the moves listed, and says so.
  const story = buildStory(launch);
  const among = story.counted === 'shown' && story.partial ? ', among the moves shown' : '';
  const detail =
    story.counted === 'all'
      ? 'Counted over every transfer of the window read, not only the moves drawn.'
      : story.partial
        ? 'Counted over the moves drawn only: the window had more.'
        : 'Counted over every transfer of the window read.';
  // What the creator's own launch transaction delivered to other addresses
  // is linked to the creator by that transaction; who controls them is not
  // shown, and the line says so.
  const viaCreator = launch.summary?.creatorTx;
  if (viaCreator && viaCreator.share >= GROUP_SHARE_MIN) {
    const n = viaCreator.addresses;
    return {
      id: 'launch-buys',
      tone: viaCreator.share >= GROUP_SHARE ? 'attention' : 'neutral',
      figure: pct(viaCreator.share),
      title: `The creator’s own creation transaction delivered ${pct(viaCreator.share)} of the supply to ${n} ${addressesWord(n, viaCreator.contracts)} other than the creator’s wallet, none of them a pool or a curve; who controls ${n === 1 ? 'it' : 'them'} is not shown.`,
      detail,
      href: '#launch-title',
    };
  }
  // Many addresses served by one transaction is the stronger fact: say that.
  const bundle = story.bundle;
  if (bundle && bundle.share >= GROUP_SHARE_MIN) {
    const at =
      bundle.seconds < 1
        ? 'in its first second'
        : `${Math.round(bundle.seconds)} seconds after creation`;
    return {
      id: 'launch-buys',
      tone: bundle.share >= GROUP_SHARE ? 'attention' : 'neutral',
      figure: pct(bundle.share),
      title: `${bundle.wallets} ${addressesWord(bundle.wallets, bundle.contracts)} received ${pct(bundle.share)} of the supply in one single transaction, ${at}${among}.`,
      detail,
      href: '#launch-title',
    };
  }
  const early = story.early;
  // A few dust buys say nothing; a visible slice of the supply does.
  if (early.wallets === 0 || early.share < GROUP_SHARE_MIN) return null;
  const last = Math.round(early.within);
  const when =
    early.within < 1
      ? 'in its first second'
      : `within ${last} second${last === 1 ? '' : 's'} of its creation`;
  return {
    id: 'launch-buys',
    tone: early.share >= GROUP_SHARE ? 'attention' : 'neutral',
    figure: pct(early.share),
    title:
      early.share > 1
        ? `${early.wallets} ${addressesWord(early.wallets, early.contracts)} bought ${pct(early.share)} of the supply ${when}${among}: more than the whole supply, as the same tokens were bought and sold back several times.`
        : `${early.wallets} ${addressesWord(early.wallets, early.contracts)} bought ${pct(early.share)} of the supply ${when}${among}.`,
    detail,
    href: '#launch-title',
  };
}

// ── The market ──────────────────────────────────────────────────────────────

/** "$337", "$61.9k", "$7.3M", "$9.1B": a figure a reader takes in at once. */
export function usdShort(value: number): string {
  if (value >= 999_950_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 999_950) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  // "$0" would say a market held nothing when it held 39 cents.
  if (value > 0 && value < 9.995) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(0)}`;
}

/** "0.0590 SOL", "12.4 SOL". */
function solShort(sol: number): string {
  return `${sol.toFixed(sol >= 10 ? 1 : sol >= 1 ? 2 : 4)} SOL`;
}

/** "the last hour", "the last 3 hours", or nothing when a trade is recent or unknown. */
function quietWords(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '';
  return hours === 1 ? 'the last hour' : `the last ${hours} hours`;
}

const EMPTY_MARKET_WORDS = 'Its market is all but empty';

/** Trades over the last day, said after the liquidity. */
function activityWords(market: ReportFacts['market']): string {
  if (market.buys24h === null && market.sells24h === null) return '';
  const trades = (market.buys24h ?? 0) + (market.sells24h ?? 0);
  const quiet = quietWords(market.quietHours);
  return trades === 0
    ? ' No trade in the last 24 hours.'
    : ` ${capitalized(plural(trades, 'trade'))} in the last 24 hours${quiet ? `, none in ${quiet}` : ''}.`;
}

function marketItem(market: ReportFacts['market'], m: Measures): GlanceItem | null {
  // A token on its launch curve trades against the curve: what the curve
  // holds is its market (DexScreener gives no liquidity for it).
  const curve = m.curve;
  if (curve && curve.sol !== null) {
    const usd = curve.usd !== null ? ` (about ${usdShort(curve.usd)})` : '';
    const holds = `its ${curveName(curve.launchpad)} holds ${solShort(curve.sol)}${usd}`;
    if (curve.usd !== null && curve.usd < EMPTY_MARKET_USD) {
      return {
        id: 'market',
        tone: 'attention',
        figure: solShort(curve.sol),
        title: `${EMPTY_MARKET_WORDS}: ${holds}.${activityWords(market)}`,
        detail: 'SOL on the bonding curve, read on chain; dollars at the token’s own SOL price.',
        href: '#fact-market',
      };
    }
    if (curve.usd !== null && curve.usd < THIN_LIQUIDITY_USD) {
      return {
        id: 'market',
        tone: 'attention',
        figure: solShort(curve.sol),
        title: `${capitalized(holds).replace(' holds ', ' holds only ')}: a sale of a few hundred dollars moves its price.`,
        detail: 'SOL on the bonding curve, read on chain; dollars at the token’s own SOL price.',
        href: '#fact-market',
      };
    }
    return {
      id: 'market',
      tone: 'neutral',
      ...(curve.progress !== null ? { figure: pct(curve.progress) } : {}),
      title: `It is ${curve.progress !== null ? `${pct(curve.progress)} of the way` : 'still on the way'} to graduation; ${holds}.`,
      detail: 'The bonding curve, read on chain.',
      href: '#fact-market',
    };
  }
  // A liquidity the chain contradicts comes first.
  if (market.measured && market.staleLiquidity) {
    const quiet = quietWords(market.quietHours);
    return {
      id: 'market',
      tone: 'attention',
      figure: pct(market.staleLiquidity.poolsShare),
      title: `Its pools hold ${pct(market.staleLiquidity.poolsShare)} of the supply today: the ${usdShort(market.staleLiquidity.listedUsd)} of liquidity DexScreener lists is not current.${quiet ? ` No trade in ${quiet}.` : ''}`,
      detail: 'Pool balances read on chain, against the listed trading pair.',
      href: '#fact-market',
    };
  }
  // Below a few dollars there is no market left to speak of; below a
  // thousand, one modest sale moves the price.
  if (market.measured && market.liquidityUsd !== null && market.liquidityUsd < EMPTY_MARKET_USD) {
    return {
      id: 'market',
      tone: 'attention',
      figure: usdShort(market.liquidityUsd),
      title: `${EMPTY_MARKET_WORDS}: ${usdShort(market.liquidityUsd)} of liquidity.${activityWords(market)}`,
      detail: 'Liquidity of the token’s listed trading pair.',
      href: '#fact-market',
    };
  }
  if (market.measured && market.liquidityUsd !== null && market.liquidityUsd < THIN_LIQUIDITY_USD) {
    return {
      id: 'market',
      tone: 'attention',
      figure: usdShort(market.liquidityUsd),
      title: `Its market holds only ${usdShort(market.liquidityUsd)} of liquidity: a sale of a few hundred dollars moves its price.`,
      detail: 'Liquidity of the token’s listed trading pair.',
      href: '#fact-market',
    };
  }
  if (market.measured && market.volume24hUsd !== null) {
    const trades = (market.buys24h ?? 0) + (market.sells24h ?? 0);
    const usd = usdShort(market.volume24hUsd);
    const quiet = trades > 0 ? quietWords(market.quietHours) : '';
    return {
      id: 'market',
      tone: 'neutral',
      figure: usd,
      title: `${usd} traded in the last 24 hours${trades > 0 ? `, over ${plural(trades, 'trade')}` : ''}${quiet ? `, none in ${quiet}` : ''}.`,
      // Volume and trades are added up over these pairs; "none" is said of every listed pair.
      detail: 'From DexScreener: its main pair and its other pairs against SOL, USDC or USDT.',
      href: '#fact-market',
    };
  }
  return null;
}

const ORDER: Record<GlanceTone, number> = { attention: 0, neutral: 1, reassuring: 2 };

export function buildGlance({ facts, timeline, launch, specialists }: GlanceInput): Glance | null {
  if (!facts) return null;
  const failed = facts.failed ?? [];
  const m = measuresOf(specialists);
  const powers = powersItem(m);
  const candidates = [
    salesItem(facts.creator, m, readFailed(failed, 'creator-sales')),
    supplyItem(facts, launch),
    launchBuysItem(launch, m, readFailed(failed, 'launch-replay')),
    recordItem(facts.creator, m, timeline, readFailed(failed, 'creator-launches')),
    marketItem(facts.market, m),
    ...(powers && powers.tone !== 'attention' ? [powers] : []),
  ].filter((item): item is GlanceItem => item !== null);
  // What the mint still lets someone do to holders leads: no holder or
  // market figure means much beside it. Then a market with next to nothing
  // in it, then where the supply went when the launch handed it out.
  // A replay that failed says nothing of who bought: no "handed out, nobody bought" line then.
  const flow = readFailed(failed, 'launch-replay') ? null : flowItem(facts);
  const empty = candidates.find((i) => i.id === 'market' && i.title.startsWith(EMPTY_MARKET_WORDS));
  const lead = [
    ...(powers && powers.tone === 'attention' ? [powers] : []),
    ...(empty ? [empty] : []),
    ...(flow ? [flow] : []),
  ];
  const items = [
    ...lead,
    ...candidates
      .filter((item) => item !== empty)
      .map((item, i) => ({ item, i }))
      .sort(
        (a, b) =>
          Number(Boolean(a.item.unread)) - Number(Boolean(b.item.unread)) ||
          ORDER[a.item.tone] - ORDER[b.item.tone] ||
          // A line with a measured figure before one without, within a tone.
          Number(!a.item.figure) - Number(!b.item.figure) ||
          a.i - b.i,
      )
      .slice(0, Math.max(0, MAX_ITEMS - lead.length))
      .map(({ item }) => item),
  ];

  const unseen: string[] = [];
  const asked = (id: string) => specialists?.find((a) => a.specialist === id);
  if (asked('token-powers')?.signal === 'unknown') unseen.push('what the mint lets someone do');
  if (!facts.creator.measured) unseen.push('who created it and what they did before');
  if (!facts.holders.measured) unseen.push('who holds it');
  if (!facts.market.measured) unseen.push('live trading on an open market');

  const headline = items[0]?.title ?? 'Too little could be measured on this token to sum it up.';
  const partial = [...new Set(failed.map((f) => READ_WORDS[f.read]))];
  return { headline, items, unseen, ...(partial.length > 0 ? { partial } : {}) };
}
