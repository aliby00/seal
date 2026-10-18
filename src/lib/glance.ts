import type { LaunchReplayData } from './contracts/launch';
import type { ReportFacts, TimelineLaunch } from './facts';
import { addressesWord, buildStory } from './launch-story';
import { whereSetAside } from './set-aside';
import type { SpecialistAnswer } from './specialists/brief';

/**
 * The report's opening: what a reader should know in ten seconds, in plain
 * sentences. Each line restates one measured fact and points to where it is
 * shown in full. Nothing is scored or summed; a line that could not be
 * measured is listed as unseen rather than left out silently.
 */

export type GlanceTone = 'attention' | 'reassuring' | 'neutral';

export type GlanceItem = {
  id: 'sales' | 'record' | 'liquidity' | 'supply' | 'launch-buys' | 'market' | 'network';
  tone: GlanceTone;
  /** The number the line is about, set large. */
  figure: string;
  /** One sentence, readable on its own. */
  title: string;
  /** Where the figure comes from, in a few words. */
  detail: string;
  /** The section that shows it in full. */
  href: string;
};

export type Glance = {
  /** The first line, said as a sentence: the most telling fact measured. */
  headline: string;
  items: GlanceItem[];
  /** What could not be measured, so its absence is not read as good news. */
  unseen: string[];
};

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
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "in 3 days", "in one day", or nothing when the dates are not known. */
function spanOf(timeline: TimelineLaunch[] | undefined): { days: number; words: string } | null {
  const dates = (timeline ?? [])
    .map((l) => (l.launchedAt ? Date.parse(l.launchedAt) : NaN))
    .filter((t) => Number.isFinite(t));
  if (dates.length < 2) return null;
  const days = Math.max(1, Math.ceil((Math.max(...dates) - Math.min(...dates)) / DAY_MS));
  return { days, words: days === 1 ? 'within a day' : `in ${days} days` };
}

function salesItem(creator: ReportFacts['creator']): GlanceItem | null {
  const checked = creator.salesChecked ?? creator.checked;
  if (!creator.measured || checked === 0) return null;
  const sold = creator.soldIntoPool;
  const title =
    sold === 0
      ? checked === 1
        ? 'The creator did not sell into the pool on the launch checked.'
        : `The creator did not sell into the pool on any of the ${checked} launches checked.`
      : sold === checked && checked > 1
        ? `The creator sold into the pool on all ${checked} launches checked.`
        : checked === 1
          ? 'The creator sold into the pool on the launch checked.'
          : `The creator sold into the pool on ${sold} of ${checked} launches checked.`;
  return {
    id: 'sales',
    tone: sold > 0 ? 'attention' : 'reassuring',
    figure: `${sold}/${checked}`,
    title,
    detail: 'Sales found in each launch’s first days, confirmed by a trade in the pool.',
    href: '#fact-creator',
  };
}

function recordItem(
  creator: ReportFacts['creator'],
  timeline: TimelineLaunch[] | undefined,
): GlanceItem | null {
  if (!creator.measured || creator.launched === 0) return null;
  const atLeast = creator.launchesListed === false ? 'at least ' : '';
  if (creator.launched === 1 && creator.launchesListed !== false) {
    return {
      id: 'record',
      tone: 'neutral',
      figure: '1st',
      title: 'This is the creator’s first token: there is no past launch to compare with.',
      detail: 'From the launches recorded for this wallet.',
      href: '#fact-creator',
    };
  }
  const span = spanOf(timeline);
  // Graduation is read on pons only: elsewhere, saying none graduated would
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
  const rapid = span !== null && creator.launched >= 3 && span.days <= 7;
  return {
    id: 'record',
    tone: rapid ? 'attention' : creator.graduated > 0 ? 'reassuring' : 'neutral',
    figure: `${creator.launched}`,
    title: `This creator launched ${atLeast}${plural(creator.launched, 'token')}${span ? ` ${span.words}` : ''}.${graduated}`,
    detail: 'Their launch record on chain, this token included.',
    href: '#fact-creator',
  };
}

function liquidityItem(creator: ReportFacts['creator']): GlanceItem | null {
  const checked = creator.liquidityChecked ?? creator.checked;
  if (!creator.measured || checked === 0) return null;
  const pulled = creator.liquidityPulled;
  return {
    id: 'liquidity',
    tone: pulled > 0 ? 'attention' : 'reassuring',
    figure: `${pulled}/${checked}`,
    title:
      pulled === 0
        ? `The launch liquidity was never withdrawn on the ${plural(checked, 'launch')} checked.`
        : `The launch liquidity was withdrawn on ${pulled} of ${plural(checked, 'launch')} checked.`,
    detail: 'Withdrawals from each launch’s own liquidity position.',
    href: '#fact-creator',
  };
}

/** Where the supply sits: still in its pools, curve or launch contracts, or with holders. */
function supplyItem(facts: ReportFacts, launch: LaunchReplayData | undefined): GlanceItem | null {
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
      title: `${pct(pooled)} of the supply is still in ${where}: only ${pct(1 - pooled)} is held outside ${/(curve|contract)$/.test(where) ? 'it' : 'them'} so far.`,
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
  // A contract is never "one wallet": what kind of address it is, is part of the fact.
  const who =
    creator && largest.address.toLowerCase() === creator
      ? 'The creator'
      : largest.kind === 'contract'
        ? 'One contract'
        : 'One wallet';
  return {
    id: 'supply',
    tone: largest.share >= 0.2 ? 'attention' : 'neutral',
    figure: pct(largest.share),
    title:
      whole !== null
        ? `${who} holds ${pct(largest.share)} of the tokens held outside ${where} (${pct(whole)} of the whole supply).`
        : `${who} holds ${pct(largest.share)} of the tokens held outside ${where}.`,
    detail:
      'The largest holder; pools, launch curves, launch contracts and burn addresses left out.',
    href: '#fact-holders',
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

function marketItem(market: ReportFacts['market']): GlanceItem | null {
  if (market.measured && market.volume24hUsd !== null) {
    const trades = (market.buys24h ?? 0) + (market.sells24h ?? 0);
    const usd =
      market.volume24hUsd >= 1000
        ? `$${(market.volume24hUsd / 1000).toFixed(1)}k`
        : `$${market.volume24hUsd.toFixed(0)}`;
    return {
      id: 'market',
      tone: 'neutral',
      figure: usd,
      title: `${usd} traded in the last 24 hours${trades > 0 ? `, over ${plural(trades, 'trade')}` : ''}.`,
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
  const candidates = [
    salesItem(facts.creator),
    networkItem(specialists),
    recordItem(facts.creator, timeline),
    liquidityItem(facts.creator),
    supplyItem(facts, launch),
    launchBuysItem(launch),
    marketItem(facts.market),
  ].filter((item): item is GlanceItem => item !== null);
  // What deserves attention comes first; within a tone, the order above holds.
  const items = candidates
    .map((item, i) => ({ item, i }))
    .sort((a, b) => ORDER[a.item.tone] - ORDER[b.item.tone] || a.i - b.i)
    .slice(0, MAX_ITEMS)
    .map(({ item }) => item);

  const unseen: string[] = [];
  if (!facts.creator.measured) unseen.push('who created it and what they did before');
  if (!facts.holders.measured) unseen.push('who holds it');
  if (!facts.market.measured) unseen.push('live trading on an open market');

  const headline = items[0]?.title ?? 'Too little could be measured on this token to sum it up.';
  return { headline, items, unseen };
}
