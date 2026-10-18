import { OTHER_LAUNCH_SALES_DAYS } from './contracts/creator';
import type { LaunchReplayData } from './contracts/launch';
import type { ReportFacts, TimelineLaunch } from './facts';
import { addressesWord, buildStory } from './launch-story';
import { feePayerWords, whereSetAside } from './set-aside';
import type { SpecialistAnswer } from './specialists/brief';
import { READ_WORDS, readFailed } from './failed-reads';
import { checkedWords, joinClauses } from './checked-sample';
import { flowHeadline } from './supply-flow';

/**
 * The report's opening: what a reader should know in ten seconds, in plain
 * sentences. Each line restates one measured fact and points to where it is
 * shown in full. Nothing is scored or summed; a line that could not be
 * measured is listed as unseen rather than left out silently.
 */

export type GlanceTone = 'attention' | 'reassuring' | 'neutral';

export type GlanceItem = {
  id: 'flow' | 'sales' | 'record' | 'liquidity' | 'supply' | 'launch-buys' | 'market' | 'network';
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
  /** The ten questions' answers: the funding one can link this creator to others. */
  specialists?: SpecialistAnswer[];
};

const MAX_ITEMS = 4;
const DAY_MS = 86_400_000;

function pct(value: number): string {
  if (value > 0 && value < 0.001) return '<0.1%';
  if (value > 0.999 && value < 1) return '>99.9%';
  // 99.7% rounded to "100%" would say nothing is left: one decimal near the top.
  return `${(value * 100).toFixed(value < 0.1 || (value >= 0.995 && value < 1) ? 1 : 0)}%`;
}

/** "1 launch", "9 launches" (not "launchs": ASTEROID, staging 18/10/2026). */
export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? '' : /(?:s|x|z|ch|sh)$/.test(word) ? 'es' : 's'}`;

/**
 * "in 3 days", "within a day", or nothing when the dates are not known.
 * `dated` is how many launches the span rests on: only those read in detail
 * carry a date, so a creator with more launches is not given their span.
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

/** "Doppler and direct deploys", for a sentence. */
function joinAnd(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Where the creator's launches could not be listed, as a parenthesis: the
 * token's own launchpad when its event does not name creators, the
 * launchpads that cannot be read, and contracts deployed directly.
 */
function unlistedWords(creator: ReportFacts['creator']): string {
  const items = [
    ...(creator.launchesListed === false && creator.launchpad ? [creator.launchpad] : []),
    ...(creator.notListed ?? []),
  ]
    .map((n) => (n === 'contracts deployed directly' ? 'direct deploys' : n))
    // "launchpad 0x7ed5… (used by pons)" inside a parenthesis reads double.
    .map((n) => n.replace(/\s*\([^)]*\)$/, ''));
  const unique = [...new Set(items)];
  if (unique.length === 0) return '';
  const verb = unique.length > 1 || unique[0] === 'direct deploys' ? 'are' : 'is';
  return ` (${joinAnd(unique)} ${verb} not listed)`;
}

/** "over its whole life so far (78 days)", "up to day 140", or nothing when unknown. */
export function ownSalesWords(own: ReportFacts['creator']['ownSales']): string | null {
  if (!own) return null;
  const days =
    own.days === null ? null : own.days < 1 ? 'less than a day' : plural(own.days, 'day');
  if (own.wholeLife) return `over its whole life so far${days ? ` (${days})` : ''}`;
  return own.days !== null ? `up to day ${own.days} after its launch` : null;
}

function salesItem(
  creator: ReportFacts['creator'],
  launch: LaunchReplayData | undefined,
  timeline?: TimelineLaunch[],
  /** The read of this token's sales failed. */
  unread = false,
): GlanceItem | null {
  const checked = creator.salesChecked ?? creator.checked;
  if (!creator.measured) return null;
  const sold = creator.soldIntoPool;
  // This token's sales could not be told this time: never "did not sell".
  if (unread && sold === 0) {
    return {
      id: 'sales',
      tone: 'neutral',
      title: 'Whether the creator sold this token could not be read this time.',
      unread: true,
      detail: 'The read of the creator’s transfers did not complete; try again in a minute.',
      href: '#fact-creator',
    };
  }
  if (checked === 0) return null;
  const own = ownSalesWords(creator.ownSales);
  // Each launch is read over its own window, and the reader is told which.
  const detail = own
    ? checked === 1
      ? `Sales of this token checked ${own}, confirmed by a trade in its market.`
      : `This token’s sales checked ${own}; the creator’s other launches in the first ${OTHER_LAUNCH_SALES_DAYS} days after each. Each confirmed by a trade in the market.`
    : `Sales checked in the first ${OTHER_LAUNCH_SALES_DAYS} days after each launch, confirmed by a trade in the pool.`;
  // A buy sold back at once is a round trip, not a creator selling an allocation.
  const summary = launch?.summary;
  const roundTrip =
    checked === 1 &&
    sold === 1 &&
    summary &&
    summary.creatorBought > 0 &&
    summary.creatorFirstBuyAt !== null &&
    summary.creatorLastSaleAt !== null &&
    Math.abs(summary.creatorSold - summary.creatorBought) <= summary.creatorBought * 0.01
      ? Math.round(summary.creatorLastSaleAt - summary.creatorFirstBuyAt)
      : null;
  if (roundTrip !== null && summary) {
    return {
      id: 'sales',
      tone: 'neutral',
      figure: pct(summary.creatorBought),
      title: `The creator bought ${pct(summary.creatorBought)} of the supply, then sold back the same amount ${roundTrip} s later.`,
      detail,
      href: '#launch-title',
    };
  }
  // Over several launches, whether this one is among the sales: the count
  // includes it, and the creator-history question counts the others.
  const current = timeline?.find((l) => l.current);
  const thisOne =
    checked > 1 && sold > 0 && sold < checked && current && current.sold !== null
      ? current.sold
        ? ', this token included'
        : ', not on this token'
      : '';
  const title =
    sold === 0
      ? checked === 1
        ? 'The creator did not sell into the pool on the launch checked.'
        : `The creator did not sell into the pool on any of the ${checked} launches checked.`
      : sold === checked && checked > 1
        ? `The creator sold into the pool on all ${checked} launches checked.`
        : checked === 1
          ? 'The creator sold into the pool on the launch checked.'
          : `The creator sold into the pool on ${sold} of ${checked} launches checked${thisOne}.`;
  // Which launches were checked: the most recent of each launchpad, said so
  // (AI: "0 of 10" were its ten latest Doppler launches, not its pons ones).
  const by = (creator.checkedBy ?? []).filter((r) => r.listed > 0);
  const which =
    by.length > 0 && checked > 1
      ? ` On its other launches: ${joinClauses(checkedWords(by, 'sales'))}.`
      : '';
  return {
    id: 'sales',
    tone: sold > 0 ? 'attention' : 'reassuring',
    figure: `${sold}/${checked}`,
    title: `${title}${which}`,
    detail,
    href: '#fact-creator',
  };
}

function recordItem(
  creator: ReportFacts['creator'],
  timeline: TimelineLaunch[] | undefined,
  /** A read of the creator's other launches failed this time. */
  unread = false,
): GlanceItem | null {
  if (!creator.measured || creator.launched === 0) return null;
  // An absence is said only when the read that would have found it answered
  // (AI: "no other launch was found" while the indexer, which lists its 80,
  // did not answer).
  if (unread) {
    return {
      id: 'record',
      tone: 'neutral',
      ...(creator.launched > 1 ? { figure: `${creator.launched}+` } : { unread: true as const }),
      title:
        creator.launched > 1
          ? `This creator launched at least ${plural(creator.launched, 'token')}; some of the places their launches are listed could not be read this time.`
          : 'Whether this creator launched other tokens could not be read this time.',
      detail: 'A read of their launch record did not complete; try again in a minute.',
      href: '#fact-creator',
    };
  }
  const unlisted = unlistedWords(creator);
  // "First token" would claim that nowhere holds an earlier launch: SEAL
  // never reads every place that could (Doppler's Airlock does not name its
  // creators; a contract deployed directly is in no launchpad's record).
  if (creator.launched === 1) {
    return {
      id: 'record',
      tone: 'neutral',
      title: `No other launch by this creator was found on the launchpads SEAL can list${unlisted}.`,
      detail: 'Their launch record on chain, this token included.',
      href: '#fact-creator',
    };
  }
  const span = spanOf(timeline);
  // The span rests on the launches with a date; with more launches than
  // that, it is said of those only.
  const spanWords = span
    ? span.dated >= creator.launched
      ? ` ${span.words}`
      : `; the ${span.dated} read in detail came ${span.words}`
    : '';
  // Graduation is read on pons and Virtuals only: elsewhere, saying none graduated would
  // state what was never looked at.
  const graduated =
    creator.detailed === 0 || (creator.graduation ?? 'measured') !== 'measured'
      ? ''
      : creator.graduated === 0
        ? creator.detailed === 1
          ? ' It has not graduated.'
          : ` None of the ${creator.detailed} read in detail graduated.`
        : ` ${creator.graduated} of the ${creator.detailed} read in detail graduated.`;
  // Many launches in a few days is a pattern worth seeing; one a month is not.
  const rapid = span !== null && span.dated >= 3 && span.days <= 7;
  const where = unlisted ? ` on the launchpads SEAL can list${unlisted}` : '';
  return {
    id: 'record',
    tone: rapid ? 'attention' : creator.graduated > 0 ? 'reassuring' : 'neutral',
    figure: `${creator.launched}`,
    title: `This creator launched ${plural(creator.launched, 'token')}${span && span.dated >= creator.launched ? spanWords : ''}${where}${span && span.dated < creator.launched ? spanWords : ''}.${graduated}`,
    detail: 'Their launch record on chain, this token included.',
    href: '#fact-creator',
  };
}

function liquidityItem(creator: ReportFacts['creator']): GlanceItem | null {
  const checked = creator.liquidityChecked ?? creator.checked;
  if (!creator.measured) return null;
  // Fees paid out to the creator are measured even where withdrawals were
  // not (MEME: 0.52 % over 28 transfers), and their size is given wherever
  // they are (ASTEROID: 6.91 % over 52 transfers, said as "on 1 of them").
  const own = creator.ownFees;
  const feesSized =
    own && own.transfers > 0
      ? `the creator received ${pct(own.share)} of the supply from ${feePayerWords(own.payers, own.hooks ?? [])}, in ${plural(own.transfers, 'transfer')}: trading fees taken out of the market`
      : null;
  if (checked === 0 && feesSized) {
    return {
      id: 'liquidity',
      tone: 'neutral',
      figure: pct(own!.share),
      title: `On this token, ${feesSized}.`,
      detail: 'Transfers of this token from those contracts to the creator, over its life.',
      href: '#fact-creator',
    };
  }
  if (checked === 0) return null;
  const pulled = creator.liquidityPulled;
  // Fees taken out of the position are tokens the creator withdrew from the
  // market: "never withdrawn" alone would hide them (AML, +387 s).
  const fees = creator.feesCollected ?? 0;
  const feesWords = feesSized
    ? ` On this token, ${feesSized}.`
    : fees > 0
      ? ` The creator did collect trading fees from the market’s liquidity position on ${fees === checked ? (checked === 1 ? 'it' : 'all of them') : `${fees} of them`}.`
      : '';
  // A deployer's removals are told by who sent them; other providers taking
  // back their own positions are said apart, never as the launch liquidity.
  const deployer = creator.source === 'deployer';
  const others = (creator.ownRemovals ?? []).filter((r) => r.whose === 'other-provider').length;
  const othersWords =
    others > 0
      ? ` Separately, other liquidity providers took back positions of their own ${others === 1 ? 'once' : `${others} times`} on this token: not the creator’s liquidity.`
      : '';
  const by = (creator.checkedBy ?? []).filter((r) => r.listed > 0 && r.liquidityChecked > 0);
  const which =
    deployer && by.length > 0 && checked > 1
      ? ` Removals checked on its other launches: ${joinClauses(checkedWords(by, 'liquidity'))}.`
      : '';
  return {
    id: 'liquidity',
    tone: pulled > 0 ? 'attention' : fees > 0 || feesSized ? 'neutral' : 'reassuring',
    figure: `${pulled}/${checked}`,
    title: deployer
      ? pulled === 0
        ? `The creator never removed liquidity on the ${plural(checked, 'launch')} checked.${feesWords}`
        : `The creator removed liquidity on ${pulled} of ${plural(checked, 'launch')} checked.${feesWords}`
      : pulled === 0
        ? `The launch liquidity was never withdrawn on the ${plural(checked, 'launch')} checked.${feesWords}`
        : `The launch liquidity was withdrawn on ${pulled} of ${plural(checked, 'launch')} checked.${feesWords}`,
    detail: `${deployer ? 'Removal transactions sent by the creator.' : 'Withdrawals from each launch’s own liquidity position.'}${which}${othersWords}`,
    href: '#fact-creator',
  };
}

/**
 * What the creator's own transfers say about the holders, in plain words:
 * the largest holder's tokens came from the creator, contracts it funded
 * passed its tokens on, it burned some. Empty when nothing links them, or
 * when the creator's transfers were not read.
 */
export function creatorLinkWords(holders: ReportFacts['holders']): {
  words: string;
  weight: number;
} {
  const links = holders.creatorLinks;
  if (!links) return { words: '', weight: 0 };
  const parts: string[] = [];
  let weight = 0;
  const largest = holders.top[0];
  const linked = holders.top.filter((h) => h.fromCreator);
  if (largest?.fromCreator) {
    const f = largest.fromCreator;
    parts.push(
      f.via
        ? `It received ${pct(f.share)} of the supply from a contract the creator had sent tokens to.`
        : `It received ${pct(f.share)} of the supply directly from the creator.`,
    );
    weight = Math.max(weight, f.share);
  }
  const others = linked.filter((h) => h !== largest);
  if (others.length > 0) {
    parts.push(
      `${others.length === 1 ? 'One other' : `${others.length} other`} of the largest holders received tokens from the creator.`,
    );
    weight = Math.max(weight, ...others.map((h) => h.fromCreator?.share ?? 0));
  }
  if (links.distributors.length > 0) {
    const share = links.distributors.reduce((n, d) => n + d.share, 0);
    const recipients = links.distributors.reduce((n, d) => n + d.recipients, 0);
    const n = links.distributors.length;
    parts.push(
      `The creator sent ${pct(share)} of the supply to ${n === 1 ? 'a contract' : `${n} contracts`} that passed it on to ${recipients.toLocaleString('en-US')} addresses.`,
    );
    weight = Math.max(weight, share);
  }
  if (links.burned >= 0.001) parts.push(`The creator burned ${pct(links.burned)} of the supply.`);
  return { words: parts.join(' '), weight };
}

/** Where the supply sits: still in its pools, curve or launch contracts, or with holders. */
function supplyItem(facts: ReportFacts, launch: LaunchReplayData | undefined): GlanceItem | null {
  const link = creatorLinkWords(facts.holders);
  const linked = link.words ? ` ${link.words}` : '';
  const fromReplay = launch?.moves
    .filter((m) => m.actorKind === 'pool' && m.heldNow !== null)
    .reduce<number | null>((max, m) => Math.max(max ?? 0, m.heldNow ?? 0), null);
  const pooled = facts.holders.pooled ?? fromReplay ?? null;
  const where = whereSetAside(facts.holders.setAside);
  if (pooled !== null && pooled >= 0.9) {
    return {
      id: 'supply',
      tone: 'neutral',
      figure: pct(pooled),
      title: `${pct(pooled)} of the supply is still in ${where}: only ${pct(1 - pooled)} is held outside ${/(curve|contract)$/.test(where) ? 'it' : 'them'} so far.${linked.replace(' It received', ' The largest holder outside received')}`,
      detail: 'Shares of the whole supply, read from the holders list.',
      href: '#fact-holders',
    };
  }
  if (!facts.holders.measured || facts.holders.top.length === 0) return null;
  const largest = facts.holders.top[0]!;
  // Shares are of the supply outside pools; with the pooled part known, they
  // are restated against the whole supply so 70% does not read as 70% of it.
  const whole = pooled !== null ? largest.share * (1 - pooled) : null;
  const creator = facts.creator.address?.toLowerCase();
  // A contract is never "one wallet": what kind of address it is, is part of
  // the fact, and what the chain says it is, when it says more (SIRIUS:
  // Virtuals' capital-formation wallet, not "one wallet").
  const who =
    creator && largest.address.toLowerCase() === creator
      ? 'The creator'
      : largest.name
        ? capitalized(largest.name)
        : largest.kind === 'contract'
          ? 'One contract'
          : 'One wallet';
  const locks = (facts.holders.setAside ?? []).filter((s) => s.role === 'vesting');
  // The lock is the summary's first line when the flow is drawn: not said twice.
  const lockWords =
    locks.length > 0 && !facts.supplyFlow
      ? ` ${pct(locks.reduce((n, l) => n + (l.share ?? 0), 0))} of the supply sits in ${locks.length === 1 ? (locks[0]!.name ?? 'a vesting lock') : `${locks.length} vesting locks`}, left out: it cannot be sold before it unlocks.`
      : '';
  return {
    id: 'supply',
    tone: largest.share >= 0.2 || link.weight >= 0.05 ? 'attention' : 'neutral',
    figure: pct(largest.share),
    title:
      whole !== null
        ? `${who} holds ${pct(largest.share)} of the tokens held outside ${where} (${pct(whole)} of the whole supply).${lockWords}${linked}`
        : `${who} holds ${pct(largest.share)} of the tokens held outside ${where}.${lockWords}${linked}`,
    detail: `The largest holder; pools, launch curves, launch contracts${locks.length > 0 ? ', vesting locks' : ''} and burn addresses left out.`,
    href: '#fact-holders',
  };
}

const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * Where the supply went at launch, in one short sentence: the first thing to
 * know about a launch that handed its supply out (SIRIUS: "Launched on
 * Virtuals: 28.6% locked for the creator until 2028, 18% held by Virtuals’
 * ACF wallet"). The drawing below carries the detail.
 */
function flowItem(facts: ReportFacts): GlanceItem | null {
  const flow = facts.supplyFlow;
  if (!flow) return null;
  const { figure, sentence, share, creatorKept } = flowHeadline(flow, facts.creator.address);
  // Nothing worth a first line: the other findings lead.
  if (share < 0.01) return null;
  return {
    id: 'flow',
    tone: creatorKept && share >= 0.05 ? 'attention' : 'neutral',
    figure,
    title: sentence,
    detail: 'Where the supply went at launch, drawn below with what each address holds today.',
    href: '#supply-flow',
  };
}

function launchBuysItem(launch: LaunchReplayData | undefined): GlanceItem | null {
  if (!launch) return null;
  // The totals of every move read when the replay kept them; an older replay
  // only has the moves listed, and says so.
  const story = buildStory(launch);
  const among = story.counted === 'shown' && story.partial ? ', among the moves shown' : '';
  const detail =
    story.counted === 'all'
      ? 'Counted over every transfer of the window, not only the moves drawn.'
      : story.partial
        ? 'Counted over the moves drawn only: the window had more.'
        : 'Counted over every transfer of the window.';
  // What the creator's own launch transaction delivered to other addresses
  // is linked to the creator by that transaction (MUT8: 71.4 % to three
  // contracts); who controls them is not shown, and the line says so.
  const viaCreator = launch.summary?.creatorTx;
  if (viaCreator && viaCreator.share >= 0.01) {
    const n = viaCreator.addresses;
    return {
      id: 'launch-buys',
      tone: viaCreator.share >= 0.05 ? 'attention' : 'neutral',
      figure: pct(viaCreator.share),
      // Pools are left out of these addresses: never "delivered into pools" (MUT8).
      title: `The creator’s own launch transaction delivered ${pct(viaCreator.share)} of the supply to ${n} ${addressesWord(n, viaCreator.contracts)} other than the creator’s wallet, none of them a pool; who controls ${n === 1 ? 'it' : 'them'} is not shown.`,
      detail,
      href: '#launch-title',
    };
  }
  // Many addresses served by one transaction is the stronger fact: say that.
  const bundle = story.bundle;
  if (bundle && bundle.share >= 0.01) {
    const at =
      bundle.seconds < 1
        ? 'in its first second'
        : `${Math.round(bundle.seconds)} seconds after launch`;
    return {
      id: 'launch-buys',
      tone: bundle.share >= 0.05 ? 'attention' : 'neutral',
      figure: pct(bundle.share),
      title: `${bundle.wallets} ${addressesWord(bundle.wallets, bundle.contracts)} received ${pct(bundle.share)} of the supply in one single transaction, ${at}${among}.`,
      detail,
      href: '#launch-title',
    };
  }
  const early = story.early;
  // A few dust buys say nothing; a visible slice of the supply does.
  if (early.wallets === 0 || early.share < 0.01) return null;
  const last = Math.round(early.within);
  const when =
    early.within < 1
      ? 'in its first second'
      : `within ${last} second${last === 1 ? '' : 's'} of its launch`;
  return {
    id: 'launch-buys',
    tone: early.share >= 0.05 ? 'attention' : 'neutral',
    figure: pct(early.share),
    title:
      early.share > 1
        ? `${early.wallets} ${addressesWord(early.wallets, early.contracts)} bought ${pct(early.share)} of the supply ${when}${among}: more than the whole supply, as the same tokens were bought and sold back several times.`
        : `${early.wallets} ${addressesWord(early.wallets, early.contracts)} bought ${pct(early.share)} of the supply ${when}${among}.`,
    detail,
    href: '#launch-title',
  };
}

/** "$337", "$61.9k", "$7.3M": a figure a reader takes in at once. */
export function usdShort(value: number): string {
  if (value >= 999_950) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

/** "the last hour", "the last 3 hours", or nothing when a trade is recent or unknown. */
function quietWords(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '';
  return hours === 1 ? 'the last hour' : `the last ${hours} hours`;
}

function marketItem(market: ReportFacts['market']): GlanceItem | null {
  // A liquidity the chain contradicts comes first: shown as liquidity, it
  // read as reassuring while the pools held almost nothing.
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
  if (market.measured && market.volume24hUsd !== null) {
    const trades = (market.buys24h ?? 0) + (market.sells24h ?? 0);
    const usd = usdShort(market.volume24hUsd);
    const quiet = trades > 0 ? quietWords(market.quietHours) : '';
    return {
      id: 'market',
      tone: 'neutral',
      figure: usd,
      title: `${usd} traded in the last 24 hours${trades > 0 ? `, over ${plural(trades, 'trade')}` : ''}${quiet ? `, none in ${quiet}` : ''}.`,
      detail: 'From the token’s listed trading pair.',
      href: '#fact-market',
    };
  }
  // No listed pair: the launch pool's own trades, counted by the indexer.
  const pool = market.measured ? market.poolActivity : undefined;
  if (pool && pool.buys24h + pool.sells24h > 0) {
    return {
      id: 'market',
      tone: 'neutral',
      figure: `${pool.buys24h + pool.sells24h}`,
      title: `${plural(pool.buys24h, 'buy')} and ${plural(pool.sells24h, 'sell')} by ${plural(pool.traders24h, 'wallet')} in the last 24 hours.`,
      detail: 'Counted from the launch pool’s own trades; no price, as no pair is listed.',
      href: '#fact-market',
    };
  }
  if (market.graduation && !market.graduation.graduated) {
    return {
      id: 'market',
      tone: 'neutral',
      figure: pct(market.graduation.progress),
      title: `It has reached ${pct(market.graduation.progress)} of the ${market.graduation.thresholdEth} ETH needed to graduate.`,
      detail: 'Progress of its launch toward an open market.',
      href: '#fact-market',
    };
  }
  if (market.graduation?.graduated) {
    return {
      id: 'market',
      tone: 'reassuring',
      figure: '100%',
      title: 'It has graduated from its launch to an open market.',
      detail: 'Its launch reached the graduation threshold.',
      href: '#fact-market',
    };
  }
  return null;
}

/** Fewer linked creators than this is not worth a line of its own: the question says it. */
const MIN_LINKED_CREATORS = 2;

/**
 * Other token creators funded by the wallet that funded this one. Only for a
 * wallet: an exchange, a bridge or an unread address funds everyone, and
 * links nobody.
 */
function networkItem(specialists: SpecialistAnswer[] | undefined): GlanceItem | null {
  const funding = specialists?.find((a) => a.specialist === 'funding-trace')?.funding;
  if (!funding || funding.kind !== 'wallet') return null;
  const n = funding.linkedCreators;
  if (n < MIN_LINKED_CREATORS) return null;
  const who =
    funding.depth > 1
      ? 'The wallets behind this creator’s funding'
      : 'The wallet that funded this creator';
  const launched =
    funding.launches !== null && funding.launches > 0
      ? `, who launched ${plural(funding.launches, 'token')} between them`
      : '';
  return {
    id: 'network',
    tone: 'attention',
    figure: `${n}`,
    title: `${who} also funded ${n} other token creators${launched}.`,
    detail:
      funding.depth > 1
        ? `Followed up ${funding.depth} funding steps, exchanges and other services left out.`
        : 'From who first funded each creator wallet, exchanges and other services left out.',
    href: '#question-funding-trace',
  };
}

const ORDER: Record<GlanceTone, number> = { attention: 0, neutral: 1, reassuring: 2 };

export function buildGlance({ facts, timeline, launch, specialists }: GlanceInput): Glance | null {
  if (!facts) return null;
  const failed = facts.failed ?? [];
  const candidates = [
    salesItem(facts.creator, launch, timeline, readFailed(failed, 'creator-sales')),
    networkItem(specialists),
    recordItem(facts.creator, timeline, readFailed(failed, 'creator-launches')),
    liquidityItem(facts.creator),
    supplyItem(facts, launch),
    launchBuysItem(launch),
    marketItem(facts.market),
  ].filter((item): item is GlanceItem => item !== null);
  // Where the supply went leads, when the launch handed it out: it is what
  // the rest is read against. Then what deserves attention; within a tone,
  // the order above holds.
  const flow = flowItem(facts);
  const items = [
    ...(flow ? [flow] : []),
    ...candidates
      .map((item, i) => ({ item, i }))
      .sort(
        (a, b) =>
          Number(Boolean(a.item.unread)) - Number(Boolean(b.item.unread)) ||
          ORDER[a.item.tone] - ORDER[b.item.tone] ||
          // A line with a measured figure before one without, within a tone.
          Number(!a.item.figure) - Number(!b.item.figure) ||
          a.i - b.i,
      )
      .slice(0, MAX_ITEMS - (flow ? 1 : 0))
      .map(({ item }) => item),
  ];

  const unseen: string[] = [];
  if (!facts.creator.measured) unseen.push('who created it and what they did before');
  if (!facts.holders.measured) unseen.push('who holds it');
  if (!facts.market.measured) unseen.push('live trading on an open market');

  const headline = items[0]?.title ?? 'Too little could be measured on this token to sum it up.';
  const partial = [...new Set(failed.map((f) => READ_WORDS[f.read]))];
  return { headline, items, unseen, ...(partial.length > 0 ? { partial } : {}) };
}
