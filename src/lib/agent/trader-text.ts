import type { TokenReport } from '../contracts';
import { launchView, toFacts, toTimeline } from '../facts';
import {
  bundleNumbers,
  devNumbers,
  figuresOf,
  share as pct,
  sniperNumbers,
  type Figure,
  type FiguresInput,
} from '../figures';
import { buildGlance, usdShort } from '../glance';
import { READ_WORDS, readFailed } from '../failed-reads';
import { answerAll, type SpecialistAnswer } from '../specialists/brief';
import { durationWords, paidWords, shareOf, short, solOf, solWords } from '../specialists/words';
import type { FlowNode } from '../supply-flow';
import { flowDate, flowSentence } from '../supply-flow';
import type { SolanaHolder } from '../solana/holders';

/**
 * What a memecoin trader reads first, worded from the facts alone: the
 * figures row, what stands out about this token (strongest first), what is
 * clean about it beyond what every launchpad token has, and what could not
 * be read. The model is given these lines to build on; the offline text is
 * made of them. Trader words name measured facts ("bundle": wallets that got
 * tokens in the creation slot or in one transaction; "snipers": the first
 * seconds' buyers; "the dev": the creator SEAL identified; "serial
 * launcher": a dev with many other launches), always with their number,
 * never as a verdict on the token or on who is behind a wallet.
 */
export type TraderLine = {
  id:
    | 'powers'
    | 'dev'
    | 'dev-lock'
    | 'flow'
    | 'named'
    | 'bundle'
    | 'linked'
    | 'serial'
    | 'market'
    | 'liquidity'
    | 'concentration'
    | 'name'
    | 'wallet-age'
    | 'quiet';
  /** How much it matters to a trader, 0 to 100: the lines are read strongest first. */
  weight: number;
  text: string;
};

export type TraderReading = {
  figures: Figure[];
  standsOut: TraderLine[];
  /** Short clauses, joined into one sentence: only what is not true of every launchpad token. */
  clean: string[];
  /** What could not be read this time, in a few words each; empty when every read answered. */
  notRead: string[];
};

const MIN = 0.01;

/** The inputs the figures row is drawn from, as the page gets them. */
export function figuresInput(report: TokenReport, specialists?: SpecialistAnswer[]): FiguresInput {
  const launch = launchView(report.launch);
  // The questions read the report alone, with no call: answered here when not given.
  const answers =
    specialists && specialists.length > 0
      ? specialists
      : answerAll({ token: report.token, report, creator: report.creator.data.creator });
  return {
    facts: toFacts(report),
    timeline: toTimeline(report),
    // The replay's totals even when its view cannot be drawn (no creation slot read).
    ...(launch
      ? { launch }
      : report.launch.data.summary
        ? {
            launch: {
              token: report.token,
              launchBlock: 0,
              launchedAt: report.launch.data.launchedAt,
              windowSeconds: report.launch.data.windowSeconds,
              supply: report.mint.data?.supply ?? '0',
              moves: [],
              movesInWindow: 0,
              summary: report.launch.data.summary,
            },
          }
        : {}),
    specialists: answers,
    collectedAt: report.collectedAt,
  };
}

const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "they hold none of it today", "they hold 2.1% today", or nothing when unread. */
function heldToday(heldNow: number | null, they = 'they'): string {
  if (heldNow === null) return '';
  return heldNow === 0 ? `${they} hold none of it today` : `${they} hold ${pct(heldNow)} today`;
}

/** Every lock end the supply flow read, the latest first. */
function unlockDate(flow: ReturnType<typeof toFacts>['supplyFlow']): string | null {
  const ends: string[] = [];
  const walk = (n: FlowNode) => {
    for (const s of n.lock?.schedules ?? []) if (s.endsAt) ends.push(s.endsAt);
    n.children.forEach(walk);
  };
  flow?.roots.forEach(walk);
  const latest = ends.sort().pop();
  return latest ? flowDate(latest) : null;
}

/** The dev's own part in this token: what it got or bought, put in a pool or a lock, sent, sold, holds. */
function devLines(report: TokenReport, input: FiguresInput): TraderLine[] {
  const dev = devNumbers(input);
  const address = report.creator.data.creator;
  if (!dev || !address) return [];
  const out: TraderLine[] = [];
  const onToken = report.creatorOnToken;
  const d = onToken && onToken.completeness !== 'unavailable' ? onToken.data : null;
  const complete = onToken?.completeness === 'full';
  const base = d?.shareBase ?? report.mint.data?.supply ?? report.holders.data.supply ?? null;
  const sm = report.launch.data.summary;
  const ownBought = d ? (shareOf(d.bought, base) ?? 0) : 0;
  const got = dev.bought ?? 0;
  // "Bought" when a buy shows it; a supply minted to the dev is "got" (GIGA got 100% at creation).
  const verb = ownBought >= got * 0.95 || (sm?.creatorBought ?? 0) >= got * 0.95 ? 'bought' : 'got';
  // What its own buys cost, when its own read saw the buys the totals count:
  // in SOL only for what SOL paid (a curve's quote token is another price).
  const paid =
    d && ownBought > 0 && ownBought >= got * 0.95
      ? paidWords(d, (raw) => pct(shareOf(raw, base) ?? 0))
      : '';
  const atCreation = sm ? sm.creatorAtLaunch >= MIN : false;
  // When it bought first and sold last, from its own moves, or the launch window's.
  const times = (kind: 'buy' | 'sell') =>
    (d?.moves ?? [])
      .filter((m) => m.kind === kind && m.blockTime !== null)
      .map((m) => m.blockTime!);
  const buys = times('buy');
  const sells = times('sell');
  let span: number | null = null;
  if (buys.length > 0 && sells.length > 0) span = Math.max(...sells) - Math.min(...buys);
  else if (sm?.creatorFirstBuyAt != null && sm.creatorLastSaleAt != null)
    span = sm.creatorLastSaleAt - sm.creatorFirstBuyAt;
  const within = span !== null && span >= 0 ? ` within ${durationWords(span)}` : '';

  // What it did with it beyond trading: liquidity (not a sale), a lock, transfers.
  const deeds: string[] = [];
  let weight = 50;
  const provided = d?.provided && d.provided !== '0' ? shareOf(d.provided, base) : null;
  if (provided !== null && provided >= MIN) {
    deeds.push(`put ${pct(provided)} into a pool as liquidity (not a sale)`);
  }
  const locked = d ? shareOf(d.locked, base) : null;
  if (locked !== null && locked >= 0.001) {
    const program = d?.moves.find((m) => m.kind === 'locked' && m.lockProgram)?.lockProgram;
    const until = unlockDate(input.facts?.supplyFlow);
    deeds.push(
      `locked ${locked >= got * 0.95 && got > 0 ? 'all of it' : pct(locked)} in ${program ?? 'a lock'} (${until ? `unlocks ${until}` : 'unlock date not read'})`,
    );
    weight = Math.max(weight, locked >= 0.05 ? 76 : 55);
  }
  const sent = d && d.sends.distinct > 0 ? shareOf(d.sends.total, base) : null;
  if (sent !== null && sent >= MIN && d) {
    deeds.push(
      `sent ${pct(sent)} to ${plural(d.sends.distinct, 'other address', 'other addresses')}`,
    );
    weight = Math.max(weight, 66);
  } else if ((sm?.creatorSent ?? 0) >= MIN) {
    // The launch window's transfers, when its own read did not list them: never sales.
    const lockedPart = sm!.creatorLocked ?? 0;
    deeds.push(
      `passed ${pct(sm!.creatorSent!)} to other addresses with nothing paid back${lockedPart >= 0.001 ? ` (${pct(lockedPart)} of it into or out of a lock)` : ''}`,
    );
    weight = Math.max(weight, 60);
  }
  // Its sales: all of it, a share, a few tokens, or none; a partial read says no absence.
  let sold = '';
  if (dev.hasSold === true && !dev.minorSale) {
    const all = got > 0 && dev.sold !== null && dev.sold >= got * 0.95;
    if (all) sold = `sold all of it${within}`;
    else if (!(dev.holds === 0 && !complete) && dev.sold) sold = `sold ${pct(dev.sold)}${within}`;
    weight = Math.max(weight, got >= 0.05 || all ? 92 : 80);
  } else if (dev.hasSold === true) {
    sold = 'sold only a few tokens since';
  } else if (dev.hasSold === false) {
    sold = 'has not sold any';
    if (dev.holds !== null && dev.holds >= 0.05) weight = Math.max(weight, 85);
  } else if (dev.holds === 0 && got >= MIN) {
    weight = Math.max(weight, 85);
  }
  const holds =
    dev.holds === null
      ? ''
      : dev.holds === 0
        ? 'it holds none of it today'
        : `it holds ${pct(dev.holds)} of the supply today`;

  if (got >= 0.001) {
    const head = `The dev ${verb} ${pct(got)} of the supply${paid}${atCreation ? ' in the creation transaction' : ''}`;
    const actions = [...deeds, ...(sold ? [sold] : [])];
    const middle =
      actions.length > 0
        ? `${actions.length > 1 ? ', ' : sold.startsWith('sold') ? ', then ' : ' and '}${joinAnd(actions)}`
        : '';
    out.push({ id: 'dev', weight, text: `${head}${middle}${holds ? `; ${holds}` : ''}.` });
  } else if (dev.holds !== null && dev.holds >= 0.05) {
    out.push({
      id: 'dev',
      weight: 85,
      text: `The dev holds ${pct(dev.holds)} of the supply without having bought it on the market.`,
    });
  } else if (deeds.length > 0) {
    out.push({ id: 'dev', weight, text: `The dev ${joinAnd(deeds)}${holds ? `; ${holds}` : ''}.` });
  }

  const named = report.creator.data.named;
  if (named) {
    out.push({
      id: 'named',
      weight: 58,
      text: `The pump.fun curve names ${short(named.address)}, but ${short(address)} signed and paid for the creation${named.signerShare !== null ? ` and got ${pct(named.signerShare)} of the supply in it` : ''}: the dev figures here are ${short(address)}'s.`,
    });
  }

  const linked = report.linkedWallets;
  if (linked && linked.completeness !== 'unavailable') {
    const traded = linked.data.funded.filter(
      (f) => f.onToken && (f.onToken.bought !== '0' || f.onToken.sold !== '0'),
    );
    if (traded.length > 0) {
      const supply = report.mint.data?.supply ?? null;
      const bought = traded.reduce((n, f) => n + (shareOf(f.onToken!.bought, supply) ?? 0), 0);
      if (bought >= MIN) {
        out.push({
          id: 'linked',
          weight: 74,
          text: `${cap(plural(traded.length, 'wallet'))} the dev sent SOL to around the launch bought ${pct(bought)} of the supply; a transfer links them, it does not show who controls them.`,
        });
      }
    }
  }
  return out;
}

/** Bundle and snipers, in one sentence when both are there. */
function launchLine(input: FiguresInput): TraderLine | null {
  const bundle = bundleNumbers(input);
  const snipers = sniperNumbers(input);
  if (!bundle && !snipers) return null;
  const parts: string[] = [];
  if (bundle) {
    const where =
      bundle.where === 'dev-paid'
        ? 'in transactions the dev or the creation’s fee payer paid for'
        : bundle.where === 'creation slot'
          ? 'in the creation slot'
          : 'in one single transaction';
    parts.push(
      `${bundle.where === 'dev-paid' ? 'Dev-paid bundle' : 'Bundled launch'}: ${plural(bundle.wallets, 'wallet')}${bundle.where === 'dev-paid' ? '' : ' other than the dev'} took ${pct(bundle.share)} of the supply ${where}`,
    );
  }
  if (snipers) {
    const window =
      snipers.seconds <= 1 ? 'in the first second' : `in the first ${snipers.seconds} seconds`;
    const after = snipers.openedAt
      ? ` after trading opened (${snipers.openedAt} s after the creation)`
      : '';
    const bought =
      snipers.share >= 1
        ? 'bought the equivalent of the whole supply, the same tokens changing hands more than once,'
        : `bought ${pct(snipers.share)}`;
    parts.push(
      `${bundle ? `${plural(snipers.wallets, 'sniper')}` : `Snipers: ${plural(snipers.wallets, 'wallet')}`} ${bought} ${window}${after}`,
    );
  }
  let today = '';
  if (bundle && snipers) {
    if (bundle.heldNow !== null && snipers.heldNow !== null) {
      today =
        bundle.heldNow === 0 && snipers.heldNow === 0
          ? '; none of them holds any today'
          : `; they hold ${pct(bundle.heldNow)} and ${pct(snipers.heldNow)} of the supply today`;
    }
  } else {
    const words = heldToday((bundle ?? snipers)!.heldNow);
    if (words) today = `; ${words}`;
  }
  const largest = Math.max(bundle?.share ?? 0, Math.min(1, snipers?.share ?? 0));
  return {
    id: 'bundle',
    weight: largest >= 0.2 ? 88 : largest >= 0.05 ? 76 : 50,
    text: `${parts.join(', and ')}${today}.`,
  };
}

/** The dev's other launches, and what became of them. */
function serialLine(report: TokenReport, input: FiguresInput): TraderLine | null {
  const history = report.creatorHistory;
  if (!history || history.completeness === 'unavailable' || !report.creator.data.creator)
    return null;
  const h = history.data;
  const n = h.launchesAtLeast ?? h.counts.launched;
  if (n === 0) return null;
  const failed = (report.failedReads ?? []).some((f) => f.read === 'creator-launches');
  const atLeast =
    failed ||
    history.completeness !== 'full' ||
    !h.scanned.pumpCurvesListed ||
    h.launchesAtLeast !== undefined;
  const lead = n >= 10 ? 'Serial launcher: the dev' : 'The dev';
  const low =
    h.lowCap && h.lowCap.checked > 0
      ? h.lowCap.under === h.lowCap.checked
        ? `; ${h.lowCap.checked === 1 ? 'the one' : `all ${count(h.lowCap.checked)}`} whose market was read ${h.lowCap.checked === 1 ? 'has' : 'have'} no market or a market cap under ${usdShort(h.lowCap.thresholdUsd)}`
        : `; of the ${count(h.lowCap.checked)} whose market was read, ${count(h.lowCap.under)} ${h.lowCap.under === 1 ? 'has' : 'have'} no market or a market cap under ${usdShort(h.lowCap.thresholdUsd)}`
      : h.counts.active > 0 || h.counts.dead > 0
        ? `; of those listed, ${count(h.counts.active)} traded in the last 24 hours`
        : '';
  // Many launches in a few days is the pattern: the dates say how fast.
  const dates = (input.timeline ?? [])
    .map((l) => (l.launchedAt ? Date.parse(l.launchedAt) : NaN))
    .filter(Number.isFinite);
  const days =
    dates.length >= 3 ? Math.ceil((Math.max(...dates) - Math.min(...dates)) / 86_400_000) : null;
  const pace =
    days !== null && days <= 7 && dates.length >= 3
      ? `, ${count(dates.length)} of them dated within ${days <= 1 ? 'a day' : `${days} days`}, this one included`
      : '';
  return {
    id: 'serial',
    weight: n >= 10 ? 82 : n >= 3 ? 66 : 42,
    text: `${lead} has ${atLeast ? 'at least ' : ''}${plural(n, 'other launch', 'other launches')}${pace}${low}.`,
  };
}

/** Market cap against volume and liquidity: a token that faded, a thin pool under a large cap. */
function marketLines(report: TokenReport, input: FiguresInput): TraderLine[] {
  const m = report.market.data;
  if (report.market.completeness === 'unavailable') return [];
  const out: TraderLine[] = [];
  const mcap = m.marketCapUsd ?? m.fdvUsd ?? null;
  const vol = m.volumeUsd?.h24 ?? null;
  const g = report.graduation?.data;
  const onCurve = g?.graduated === false;
  const curveSol = onCurve && g.raised && g.raised.mint === null ? solOf(g.raised.raw) : null;
  const liquidity = m.liquidityUsd ?? m.curveLiquidityUsd ?? null;
  const curveWords = onCurve
    ? `${g.progress !== null ? `; the curve is ${pct(g.progress)} of the way to graduation` : '; it is still on its curve'}${curveSol !== null ? ` and holds ${solWords(curveSol)}` : ''}`
    : '';
  if (mcap !== null && vol !== null && vol >= 5 * mcap && mcap < 25_000) {
    out.push({
      id: 'market',
      weight: 84,
      text: `Market cap is ${usdShort(mcap)} against ${usdShort(vol)} traded in the last 24 hours${curveWords}.`,
    });
  } else if (mcap !== null) {
    out.push({
      id: 'market',
      weight: 30,
      text: `Market cap is ${usdShort(mcap)}${liquidity !== null ? ` with ${usdShort(liquidity)} of liquidity${m.liquidityToMarketCap != null ? ` (${pct(m.liquidityToMarketCap)} of it)` : ''}` : ''}${vol !== null ? `, and ${usdShort(vol)} traded in the last 24 hours` : ''}${curveWords}.`,
    });
  }
  const ratio = m.liquidityToMarketCap ?? (mcap && liquidity !== null ? liquidity / mcap : null);
  if (
    !onCurve &&
    mcap !== null &&
    mcap >= 100_000 &&
    liquidity !== null &&
    ratio !== null &&
    ratio < 0.05
  ) {
    out.push({
      id: 'liquidity',
      weight: 83,
      text: `Liquidity is ${usdShort(liquidity)} under a ${usdShort(mcap)} market cap, ${pct(ratio)} of it: a sale of 1% of the supply is about ${usdShort(mcap * 0.01)}.`,
    });
  } else if (liquidity !== null && liquidity < 1_000 && !onCurve) {
    out.push({
      id: 'liquidity',
      weight: 80,
      text: `Its pool holds only ${usdShort(liquidity)} of liquidity: a sale of a few hundred dollars moves its price.`,
    });
  }
  if (m.quiet && m.quiet.hours >= 1) {
    out.push({
      id: 'quiet',
      weight: 62,
      text: `No trade on any listed pair in the last ${m.quiet.hours === 1 ? 'hour' : `${m.quiet.hours} hours`}.`,
    });
  }
  void input;
  return out;
}

/** The largest wallets, of the whole supply, pools, curves and locks left out. */
function concentrationLine(report: TokenReport): TraderLine | null {
  const h = report.holders;
  if (h.completeness === 'unavailable' || h.data.method === 'none') return null;
  const top1 = h.data.ofSupply.largestWallet;
  const top10 = h.data.ofSupply.top10Wallets;
  if (top1 === null || top10 === null) return null;
  const wallets = (h.data.top as readonly SolanaHolder[]).filter(
    (x) => x.kind === 'wallet' || x.kind === 'contract',
  );
  const floor = h.data.method === 'largest-accounts' ? ' (from the 20 largest accounts)' : '';
  // Near-equal bags: ten wallets within a quarter of one another.
  const ten = wallets.slice(0, 10).map((x) => x.ofSupply);
  const equal =
    ten.length >= 10 && top10 >= 0.1 && Math.min(...ten) >= Math.max(...ten) * 0.75
      ? `, in near-equal bags of ${pct(Math.min(...ten))} to ${pct(Math.max(...ten))} each`
      : '';
  const largest = wallets[0];
  const who =
    largest &&
    largest.owner.name &&
    largest.owner.name !== 'wallet' &&
    largest.owner.kind !== 'wallet'
      ? largest.owner.name
      : 'one wallet';
  if (top10 >= 0.3 || equal) {
    return {
      id: 'concentration',
      weight: equal ? 80 : top10 >= 0.5 ? 78 : 64,
      text: `The top 10 wallets hold ${pct(top10)} of the supply${equal}${floor}; the largest${who === 'one wallet' ? '' : `, ${who},`} holds ${pct(top1)}.`,
    };
  }
  if (top1 >= 0.1) {
    return {
      id: 'concentration',
      weight: 68,
      text: `${cap(who)} holds ${pct(top1)} of the supply${floor}.`,
    };
  }
  return null;
}

/** The answers of the questions the facts do not carry: a name taken, a fresh dev wallet. */
function questionLines(specialists?: SpecialistAnswer[]): TraderLine[] {
  const out: TraderLine[] = [];
  const answer = (id: SpecialistAnswer['specialist']) =>
    specialists?.find((a) => a.specialist === id && a.signal === 'concern');
  const name = answer('name-clone');
  if (name?.facts[0]) out.push({ id: 'name', weight: 70, text: name.facts[0] });
  const age = answer('wallet-age');
  if (age?.facts[0]) out.push({ id: 'wallet-age', weight: 56, text: age.facts[0] });
  return out;
}

/** Where the supply went at launch, for a mint no launchpad made: who got it, and who holds it. */
function flowLine(report: TokenReport, input: FiguresInput): TraderLine | null {
  if (readFailed(report.failedReads, 'launch-replay')) return null;
  const flow = input.facts?.supplyFlow;
  if (!flow || flow.launchpad) return null;
  return { id: 'flow', weight: 62, text: flowSentence(flow, report.creator.data.creator) };
}

/** What the mint still lets someone do to holders: first, when there is any. */
function powersLine(input: FiguresInput): TraderLine | null {
  const glance = buildGlance(input);
  const p = glance?.items.find((i) => i.id === 'powers' && i.tone === 'attention');
  return p ? { id: 'powers', weight: 96, text: p.title } : null;
}

/** Clauses for "What is clean": only what tells this token apart from a standard launch. */
function cleanParts(report: TokenReport, input: FiguresInput, lines: TraderLine[]): string[] {
  const out: string[] = [];
  const has = (id: TraderLine['id']) => lines.some((l) => l.id === id);
  // LP burned or locked for good on a graduated or listed pool.
  const pool = report.liquidity.data.pools.find((p) => p.known);
  const gone = pool ? (pool.burnedShare ?? 0) + (pool.lockedShare ?? 0) : 0;
  if (pool && gone >= 0.95) {
    out.push(
      `its main pool's LP is ${pct(gone)} ${pool.burnedShare !== null && pool.burnedShare >= 0.95 ? 'burned' : 'burned or locked for good'}`,
    );
  }
  // Powers: said only when the token is not a launchpad's, whose powers are off by design.
  const pad = report.launchpad.data.launchpad;
  const held = report.powers.some((p) => p.status === 'held' || p.status === 'unknown');
  if (!pad && report.mint.data && !held) {
    out.push('no one can mint more, freeze holders or change its rules');
  }
  const dev = devNumbers(input);
  if (
    dev &&
    dev.hasSold === false &&
    (dev.bought ?? 0) < 0.001 &&
    (dev.holds ?? 0) < 0.001 &&
    report.creatorOnToken?.completeness === 'full'
  ) {
    out.push(
      dev.bought === 0
        ? 'the dev neither bought nor holds any of it'
        : 'the dev holds none of it and has not sold',
    );
  } else if (
    dev &&
    dev.hasSold === false &&
    !has('dev') &&
    report.creatorOnToken?.completeness === 'full'
  ) {
    out.push('the dev has not sold');
  }
  const launch = report.launch;
  const replayFailed = (report.failedReads ?? []).some((f) => f.read === 'launch-replay');
  if (
    !replayFailed &&
    launch.completeness === 'full' &&
    !bundleNumbers(input) &&
    !sniperNumbers(input) &&
    launch.data.creation
  ) {
    out.push('no wallet other than the dev took 1% or more at launch');
  }
  const h = report.holders.data;
  if (
    report.holders.completeness !== 'unavailable' &&
    h.method === 'all-accounts' &&
    h.ofSupply.top10Wallets !== null &&
    h.ofSupply.top10Wallets < 0.2 &&
    (h.holderCount ?? 0) >= 100
  ) {
    out.push(`the top 10 wallets hold only ${pct(h.ofSupply.top10Wallets)} of the supply`);
  }
  const m = report.market.data;
  if (
    report.graduation?.data.graduated !== false &&
    m.liquidityToMarketCap != null &&
    m.liquidityToMarketCap >= 0.1 &&
    (m.marketCapUsd ?? 0) >= 50_000
  ) {
    out.push(`liquidity is ${pct(m.liquidityToMarketCap)} of the market cap`);
  }
  const history = report.creatorHistory;
  if (
    history &&
    history.completeness === 'full' &&
    (history.data.launchesAtLeast ?? history.data.counts.launched) === 0 &&
    !(report.failedReads ?? []).some((f) => f.read === 'creator-launches')
  ) {
    out.push(
      'no other launch by this dev was found on pump.fun’s curves or in its transactions read',
    );
  }
  return out.slice(0, 3);
}

/** The reads that failed, in a few words each. */
function notReadParts(report: TokenReport): string[] {
  return [...new Set((report.failedReads ?? []).map((f) => READ_WORDS[f.read]))];
}

export function traderReading(
  report: TokenReport,
  specialists?: SpecialistAnswer[],
): TraderReading {
  const input = figuresInput(report, specialists);
  specialists = input.specialists;
  const lines = [
    powersLine(input),
    flowLine(report, input),
    ...devLines(report, input),
    launchLine(input),
    serialLine(report, input),
    ...marketLines(report, input),
    concentrationLine(report),
    ...questionLines(specialists),
  ]
    .filter((l): l is TraderLine => l !== null)
    .sort((a, b) => b.weight - a.weight);
  return {
    figures: figuresOf(input),
    standsOut: lines,
    clean: cleanParts(report, input, lines),
    notRead: notReadParts(report),
  };
}

/** "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
