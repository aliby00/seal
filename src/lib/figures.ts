import type { GlanceInput } from './glance';
import { usdShort } from './glance';
import type { Measures } from './specialists/types';

/**
 * The figures a trader reads first, in one row above the text: market cap,
 * liquidity against it, holders, the top 10, what the dev holds and sold,
 * the launch's bundle and snipers, the dev's other launches and the token's
 * age. Taken from the facts, the same way on the page, in the share card and
 * in what the model and the offline text are given; never written by the
 * model. Only what was measured is shown: a figure not read is left out,
 * never drawn as "—" or as zero.
 */
export type Figure = {
  id:
    | 'mcap'
    | 'liquidity'
    | 'volume'
    | 'holders'
    | 'top10'
    | 'dev'
    | 'bundle'
    | 'snipers'
    | 'launches'
    | 'curve'
    | 'age';
  label: string;
  value: string;
  /** A few words under the value: what it is measured against. */
  sub?: string;
};

export type FiguresInput = GlanceInput & {
  /** When the reading was made: the token's age is counted to it. */
  collectedAt?: string;
};

/** "41.9%", "0.92%", "<0.01%": one rule everywhere in the row. */
export function share(value: number): string {
  if (value === 0) return '0%';
  if (value === 1) return '100%';
  if (value > 0 && value < 0.0001) return '<0.01%';
  const x = value * 100;
  if (x >= 99.95 && value < 1) return '>99.9%';
  return `${x.toFixed(x < 1 ? 2 : 1)}%`;
}

const count = (n: number) => n.toLocaleString('en-US');

/** "42 min", "5 h", "3 days", "14 months", "2 years". */
export function ageWords(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'under a minute';
  if (min < 120) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  const days = Math.round(h / 24);
  if (days < 60) return `${days} days`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months} months`;
  return `${Math.round(days / 365)} years`;
}

function measuresOf(specialists: GlanceInput['specialists']): Measures {
  const out: Measures = {};
  for (const answer of specialists ?? []) if (answer.measures) Object.assign(out, answer.measures);
  return out;
}

/** What the dev bought, sold and holds, shares of the supply; `null` parts not read. */
export function devNumbers(input: GlanceInput): {
  bought: number | null;
  sold: number | null;
  hasSold: boolean | null;
  holds: number | null;
  minorSale: boolean;
} | null {
  const facts = input.facts;
  if (!facts || !facts.creator.address) return null;
  const c = measuresOf(input.specialists).creator;
  const sm = input.launch?.summary;
  const atLaunch = sm ? Math.max(sm.creatorAtLaunch, sm.creatorBought) : 0;
  const bought = Math.max(c?.bought ?? 0, atLaunch);
  const soldWindow = sm?.creatorSold ?? 0;
  const sold = Math.max(c?.sold ?? 0, soldWindow);
  const hasSold =
    c?.hasSold === true || soldWindow > 0
      ? true
      : c
        ? c.hasSold
        : facts.creator.salesChecked > 0
          ? facts.creator.soldIntoPool > 0
          : null;
  return {
    bought: bought > 0 ? bought : c && c.bought !== null ? 0 : null,
    sold: hasSold ? sold : hasSold === false ? 0 : null,
    hasSold,
    holds: c?.holdsNow ?? null,
    minorSale: facts.creator.saleSize === 'minor',
  };
}

/** The larger of the launch's wallet groups: the creation slot, one transaction, or the dev's own payments. */
export function bundleNumbers(input: GlanceInput): {
  wallets: number;
  share: number;
  heldNow: number | null;
  where: 'creation slot' | 'one transaction' | 'dev-paid';
} | null {
  const m = measuresOf(input.specialists).launch;
  const out: {
    wallets: number;
    share: number;
    heldNow: number | null;
    where: 'creation slot' | 'one transaction' | 'dev-paid';
  }[] = [];
  if (m?.payerGroup) out.push({ ...m.payerGroup, where: 'dev-paid' });
  if (m?.sameSlot) out.push({ ...m.sameSlot, where: 'creation slot' });
  const b = input.launch?.summary?.bundle;
  if (b)
    out.push({ wallets: b.wallets, share: b.share, heldNow: b.heldNow, where: 'one transaction' });
  // One wallet is no bundle: a group is two or more.
  const best = out
    .filter((g) => g.share >= 0.01 && g.wallets >= 2)
    .sort((a, b) => b.share - a.share)[0];
  return best ?? null;
}

/** Buyers of the first seconds (the dev left out), after trading opened when it opened later. */
export function sniperNumbers(input: GlanceInput): {
  wallets: number;
  share: number;
  heldNow: number | null;
  seconds: number;
  openedAt: number | null;
} | null {
  const sm = input.launch?.summary;
  if (!sm || sm.early.wallets === 0 || sm.early.share < 0.01) return null;
  return {
    wallets: sm.early.wallets,
    share: sm.early.share,
    heldNow: sm.early.heldNow,
    seconds: sm.earlySeconds,
    openedAt: sm.tradingOpenedAt ?? null,
  };
}

/** When the token was launched, from the replay or the timeline. */
export function launchedAtOf(input: GlanceInput): string | null {
  return input.launch?.launchedAt ?? input.timeline?.find((l) => l.current)?.launchedAt ?? null;
}

const heldSub = (heldNow: number | null) =>
  heldNow === null ? '' : heldNow === 0 ? ' · 0% left' : ` · ${share(heldNow)} left`;

/** The row, in reading order. */
export function figuresOf(input: FiguresInput): Figure[] {
  const facts = input.facts;
  if (!facts) return [];
  const m = measuresOf(input.specialists);
  const out: Figure[] = [];
  const market = facts.market;
  const mcap = market.marketCapUsd ?? market.fdvUsd ?? null;
  if (market.measured && mcap !== null && mcap > 0) {
    out.push({
      id: 'mcap',
      label: market.marketCapUsd != null ? 'Mcap' : 'FDV',
      value: usdShort(mcap),
    });
  }
  const curveUsd = market.curveLiquidityUsd ?? m.curve?.usd ?? null;
  const liquidity = market.liquidityUsd ?? curveUsd;
  if (market.measured && liquidity !== null) {
    const ratio = market.liquidityToMarketCap ?? (mcap ? liquidity / mcap : null);
    const where = market.liquidityUsd === null && curveUsd !== null ? 'on the curve' : '';
    const sub = [where, ratio !== null && ratio !== undefined ? `${share(ratio)} of mcap` : '']
      .filter(Boolean)
      .join(' · ');
    out.push({
      id: 'liquidity',
      label: 'Liquidity',
      value: usdShort(liquidity),
      ...(sub ? { sub } : {}),
    });
  }
  // A volume DexScreener adds up over pairs that do not give their trades says
  // nothing per trade (LINK: $31 over 11,158 trades): left out then.
  const misleading = market.perTradeUsd24h === null;
  if (market.measured && market.volume24hUsd !== null && !misleading) {
    const trades = (market.buys24h ?? 0) + (market.sells24h ?? 0);
    out.push({
      id: 'volume',
      label: 'Vol 24h',
      value: usdShort(market.volume24hUsd),
      ...(trades > 0 ? { sub: `${count(trades)} trades` } : {}),
    });
  }
  // Holders: an exact count only. "At least 19" for POPCAT read as a fact about it.
  const exact = facts.holders.holderCount ?? (m.spread?.exact ? m.spread.holders : null);
  if (facts.holders.measured && exact !== null && exact > 0) {
    out.push({ id: 'holders', label: 'Holders', value: count(exact) });
  }
  const top10 = facts.holders.top10OfSupply ?? null;
  if (facts.holders.measured && top10 !== null && top10 !== undefined) {
    out.push({
      id: 'top10',
      label: 'Top 10',
      value: share(top10),
      sub: exact === null ? 'of supply · 20 largest read' : 'of supply · pools out',
    });
  }
  const dev = devNumbers(input);
  if (dev && (dev.holds !== null || dev.hasSold !== null)) {
    const sold =
      dev.hasSold === true
        ? dev.minorSale
          ? 'sold a few tokens'
          : dev.bought && dev.sold !== null && dev.sold >= dev.bought * 0.95
            ? 'sold all'
            : dev.holds === 0
              ? ''
              : dev.sold
                ? `sold ${share(dev.sold)}`
                : 'sold some'
        : dev.hasSold === false
          ? 'no sale'
          : '';
    const c = measuresOf(input.specialists).creator;
    const sm = input.launch?.summary;
    const verb =
      (c?.bought ?? 0) >= (dev.bought ?? 0) * 0.95 ||
      (sm?.creatorBought ?? 0) >= (dev.bought ?? 0) * 0.95
        ? 'bought'
        : 'got';
    const bought = dev.bought ? `${verb} ${share(dev.bought)}` : '';
    out.push({
      id: 'dev',
      label: 'Dev holds',
      value: dev.holds === null ? 'not read' : share(dev.holds),
      ...(bought || sold ? { sub: [bought, sold].filter(Boolean).join(' · ') } : {}),
    });
  }
  const bundle = bundleNumbers(input);
  if (bundle) {
    out.push({
      id: 'bundle',
      label: 'Bundle',
      value: share(bundle.share),
      sub: `${count(bundle.wallets)} wallets${bundle.where === 'dev-paid' ? ' · dev-paid' : bundle.where === 'creation slot' ? ' · creation slot' : ' · one tx'}${heldSub(bundle.heldNow)}`,
    });
  }
  const snipers = sniperNumbers(input);
  if (snipers) {
    out.push({
      id: 'snipers',
      label: 'Snipers',
      value: snipers.share >= 1 ? '100%+' : share(snipers.share),
      sub: `${count(snipers.wallets)} ${snipers.wallets === 1 ? 'wallet' : 'wallets'} · first ${snipers.seconds <= 1 ? 'second' : `${snipers.seconds} s`}${heldSub(snipers.heldNow)}`,
    });
  }
  const h = m.history;
  const launches = facts.creator.measured ? facts.creator.launched : 0;
  if (launches >= 2) {
    const atLeast = h ? h.atLeast : !facts.creator.launchesListed;
    out.push({
      id: 'launches',
      label: 'Dev launches',
      value: `${count(launches)}${atLeast ? '+' : ''}`,
      sub: 'this one included',
    });
  }
  const curve = m.curve;
  if (curve && curve.graduated === false && curve.progress !== null) {
    out.push({ id: 'curve', label: 'Curve', value: share(curve.progress), sub: 'to graduation' });
  }
  const at = launchedAtOf(input);
  const pad = facts.creator.launchpad ?? curve?.launchpad ?? null;
  if (at && input.collectedAt) {
    const ms = Date.parse(input.collectedAt) - Date.parse(at);
    if (Number.isFinite(ms) && ms >= 0) {
      const graduated = curve?.graduated === true;
      out.push({
        id: 'age',
        label: 'Launched',
        value: `${ageWords(ms)} ago`,
        ...(pad ? { sub: `${pad}${graduated ? ' · graduated' : ''}` } : {}),
      });
    }
  }
  return out;
}

/** The row as one line of text: "Mcap $36.0k · Liquidity $12.8k (35.0% of mcap) · …". */
export function figuresLine(figures: readonly Figure[]): string {
  return figures.map((f) => `${f.label} ${f.value}${f.sub ? ` (${f.sub})` : ''}`).join(' · ');
}
