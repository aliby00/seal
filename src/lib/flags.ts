import { FLAG_RULES as R } from './flag-rules';
import { share } from './figures';
import { usdShort } from './glance';

/**
 * The report's first lines: one fact each, flagged red, orange or green by
 * fixed rules (flag-rules.ts), in a trader's words. Each flag judges its own
 * fact; nothing adds them up, and no word judges the token as a whole.
 *
 * The flags are drawn from `FlagInputs`, plain numbers the server works out
 * from the collected report (agent/trader-text.ts): the page draws them
 * again when the live market or holders change (liquidity over market cap,
 * what the dev holds), with the same rules.
 */
export type FlagTone = 'red' | 'orange' | 'green';

export type Flag = {
  id: string;
  tone: FlagTone;
  /** "Dev sold", "Bundle": the fact's name, said first. */
  label: string;
  /** What was measured, short. */
  text: string;
};

export type FlagInputs = {
  launchpad: string | null;
  /** Powers someone still holds over holders, as verb phrases ("freeze holders’ tokens"). */
  livePowers: string[];
  /** The mint and freeze authorities are both off. */
  mintFreezeOff: boolean;
  dev: {
    /** What it bought (or got at creation), sold and holds, shares of the supply; `null` when unread. */
    got: number | null;
    verb: 'bought' | 'got';
    sold: number | null;
    hasSold: boolean | null;
    minorSale: boolean;
    holds: number | null;
    /** "within 4 minutes", when its first buy and last sale were read. */
    within: string | null;
    locked: number | null;
    lockProgram: string | null;
    unlocks: string | null;
    provided: number | null;
    /** Every move of the dev on this token was read. */
    complete: boolean;
  } | null;
  bundle: {
    wallets: number;
    share: number;
    heldNow: number | null;
    where: 'creation slot' | 'one transaction' | 'dev-paid';
  } | null;
  snipers: {
    wallets: number;
    share: number;
    heldNow: number | null;
    seconds: number;
    afterOpen: boolean;
  } | null;
  /** The launch window was read in full and no group took 1% or more. */
  noBundle: boolean;
  serial: {
    others: number;
    atLeast: boolean;
    checked: number;
    dead: number;
    deadUnderUsd: number | null;
  } | null;
  noOtherLaunch: boolean;
  market: {
    mcap: number | null;
    liquidity: number | null;
    /** The liquidity is what the bonding curve holds. */
    onCurve: boolean;
    ratio: number | null;
    volume24h: number | null;
    quietHours: number | null;
  };
  holders: {
    top10: number | null;
    top1: number | null;
    /** What the largest wallet is, when the chain says more than "a wallet". */
    top1Name: string | null;
    holders: number | null;
    /** Only the 20 largest accounts were read. */
    floor: boolean;
    equalBags: { min: number; max: number } | null;
  } | null;
  lp: { gone: number; burned: boolean; withdrawable: number | null } | null;
  linkedBought: number | null;
  /** The question answers that flag on their own: a name taken, a fresh dev wallet. */
  nameClone: string | null;
  freshWallet: string | null;
};

/** What the page reads live, laid over the inputs: the same rules then draw the flags. */
export type LiveValues = {
  mcap?: number | null;
  liquidity?: number | null;
  ratio?: number | null;
  volume24h?: number | null;
  top10?: number | null;
  top1?: number | null;
  holders?: number | null;
  devHolds?: number | null;
};

export function withLive(inputs: FlagInputs, live: LiveValues | null | undefined): FlagInputs {
  if (!live) return inputs;
  const pick = <T>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;
  const mcap = pick(live.mcap, inputs.market.mcap);
  const liquidity = inputs.market.onCurve
    ? inputs.market.liquidity
    : pick(live.liquidity, inputs.market.liquidity);
  return {
    ...inputs,
    market: {
      ...inputs.market,
      mcap,
      liquidity,
      ratio: inputs.market.onCurve
        ? mcap && liquidity !== null
          ? liquidity / mcap
          : inputs.market.ratio
        : pick(live.ratio, inputs.market.ratio),
      volume24h: pick(live.volume24h, inputs.market.volume24h),
    },
    holders: inputs.holders
      ? {
          ...inputs.holders,
          top10: pick(live.top10, inputs.holders.top10),
          top1: pick(live.top1, inputs.holders.top1),
          holders: pick(live.holders, inputs.holders.holders),
        }
      : inputs.holders,
    dev: inputs.dev ? { ...inputs.dev, holds: pick(live.devHolds, inputs.dev.holds) } : inputs.dev,
  };
}

const count = (n: number) => n.toLocaleString('en-US');
const left = (heldNow: number | null) =>
  heldNow === null ? '' : heldNow === 0 ? ' · 0% left' : ` · ${share(heldNow)} still held`;

function devFlags(d: NonNullable<FlagInputs['dev']>, out: Flag[], green: string[]) {
  const got = d.got ?? 0;
  if (d.hasSold === true && !d.minorSale && got >= R.devMin) {
    const sold = d.sold ?? 0;
    const all = sold >= got * 0.95;
    // Holds none of it, its sales not all read: it is out, how is not all seen (100x).
    const out0 = !all && d.holds === 0 && !d.complete;
    const part = got > 0 ? sold / got : 1;
    out.push({
      id: 'dev-sold',
      tone: all || out0 || part >= R.devSoldRed ? 'red' : 'orange',
      label: all ? 'Dev sold everything' : out0 ? 'Dev out' : 'Dev sold',
      text: all
        ? `${d.verb} ${share(got)}, sold it all${d.within ? ` ${d.within}` : ''}`
        : out0
          ? `${d.verb} ${share(got)}, holds 0% now`
          : `${share(sold)} of the ${share(got)} it ${d.verb}${d.within ? `, ${d.within}` : ''} · holds ${d.holds === null ? '?' : share(d.holds)}`,
    });
  } else if (
    d.hasSold === null &&
    d.holds === 0 &&
    got >= R.devMin &&
    // A supply minted to the dev and put in its pool (GIGA) left as liquidity, not in a sale.
    (d.provided ?? 0) < got * 0.5
  ) {
    out.push({
      id: 'dev-sold',
      tone: 'red',
      label: 'Dev out',
      text: `${d.verb} ${share(got)} at launch, holds 0% now`,
    });
  } else if (d.hasSold === false && d.complete) {
    green.push('dev has not sold');
  }
  const free = d.holds ?? 0;
  if (free >= R.devHoldsOrange && !(d.hasSold === true && !d.minorSale && got >= R.devMin)) {
    out.push({
      id: 'dev-holds',
      tone: free >= R.devHoldsRed ? 'red' : 'orange',
      label: 'Dev holds',
      text: `${share(free)} of the supply`,
    });
  }
  if (d.locked !== null && d.locked >= R.devMin) {
    out.push({
      id: 'dev-lock',
      tone: 'orange',
      label: 'Dev bag locked',
      text: `${share(d.locked)} in ${d.lockProgram ?? 'a lock'} · ${d.unlocks ? `unlocks ${d.unlocks}` : 'unlock date unknown'}`,
    });
  }
}

function launchFlags(i: FlagInputs, out: Flag[], green: string[]) {
  const b = i.bundle;
  if (b && b.share >= R.bundleOrange) {
    const where =
      b.where === 'creation slot'
        ? 'in the creation block'
        : b.where === 'dev-paid'
          ? 'in transactions the dev paid for'
          : 'in one transaction';
    out.push({
      id: 'bundle',
      tone: b.share >= R.bundleRed || (b.heldNow ?? 0) >= R.stillHeldRed ? 'red' : 'orange',
      label: 'Bundle',
      text: `${count(b.wallets)} wallets took ${share(b.share)} ${where}${left(b.heldNow)}`,
    });
  }
  const s = i.snipers;
  if (s && s.share >= R.snipersOrange) {
    const window = s.seconds <= 1 ? 'first second' : `first ${s.seconds} s`;
    out.push({
      id: 'snipers',
      tone: s.share >= R.snipersRed || (s.heldNow ?? 0) >= R.stillHeldRed ? 'red' : 'orange',
      label: 'Snipers',
      text: `${count(s.wallets)} wallets bought ${s.share >= 1 ? 'the equivalent of the whole supply' : share(s.share)} in the ${window}${s.afterOpen ? ' of trading' : ''}${left(s.heldNow)}`,
    });
  }
  if (i.noBundle) green.push('no bundle');
}

function serialFlag(i: FlagInputs, out: Flag[], green: string[]) {
  const s = i.serial;
  if (!s) {
    if (i.noOtherLaunch) green.push('no other launch by the dev');
    return;
  }
  const deadShare = s.checked > 0 ? s.dead / s.checked : null;
  const mostlyDead = deadShare !== null && deadShare >= R.mostlyDead;
  const launched = `${count(s.others + 1)}${s.atLeast ? '+' : ''} tokens launched`;
  const dead =
    s.checked === 0
      ? ''
      : s.checked >= 10
        ? ` · ${Math.round((deadShare ?? 0) * 100)}% of those checked dead`
        : ` · ${s.dead === s.checked ? `all ${s.checked}` : `${s.dead} of ${s.checked}`} checked dead`;
  if (s.others >= R.serialOrange) {
    out.push({
      id: 'serial',
      tone: s.others >= R.serialRed && mostlyDead ? 'red' : 'orange',
      label: 'Serial launcher',
      text: `${launched}${dead}`,
    });
  } else if (s.others >= R.fewLaunchesMin && mostlyDead) {
    out.push({ id: 'serial', tone: 'orange', label: 'Dev relaunches', text: `${launched}${dead}` });
  }
}

/** A large cap carries a smaller pool for the same depth: its thresholds are lower. */
const large = (mcap: number) => mcap >= R.largeCapUsd;
const redUnder = (mcap: number) => (large(mcap) ? R.largeCapLiquidityRed : R.liquidityRed);
const orangeUnder = (mcap: number) => (large(mcap) ? R.largeCapLiquidityOrange : R.liquidityOrange);

function marketFlags(i: FlagInputs, out: Flag[], green: string[]) {
  const m = i.market;
  if (m.mcap !== null && m.volume24h !== null) {
    if (m.mcap < R.deadMcapUsd && m.volume24h >= R.deadVolumeFactor * m.mcap) {
      out.push({
        id: 'chart',
        tone: 'red',
        label: 'Chart dead',
        text: `mcap ${usdShort(m.mcap)} after ${usdShort(m.volume24h)} traded in 24 h`,
      });
    } else if (m.mcap < R.fadingMcapUsd && m.volume24h >= R.fadingVolumeFactor * m.mcap) {
      out.push({
        id: 'chart',
        tone: 'orange',
        label: 'Fading',
        text: `mcap ${usdShort(m.mcap)} after ${usdShort(m.volume24h)} traded in 24 h`,
      });
    }
  }
  if (!m.onCurve && m.liquidity !== null) {
    if (m.liquidity < R.emptyPoolUsd) {
      out.push({
        id: 'liquidity',
        tone: 'red',
        label: 'Pool nearly empty',
        text: `${usdShort(m.liquidity)} of liquidity`,
      });
    } else if (m.ratio !== null && m.mcap !== null && m.ratio < orangeUnder(m.mcap)) {
      out.push({
        id: 'liquidity',
        tone: m.ratio < redUnder(m.mcap) ? 'red' : 'orange',
        label: 'Thin liquidity',
        text: `${usdShort(m.liquidity)} under a ${usdShort(m.mcap)} mcap (${share(m.ratio)})`,
      });
    } else if (m.ratio !== null && (m.mcap ?? 0) >= R.liquidityGreenMinMcapUsd) {
      green.push(`liquidity ${share(m.ratio)} of mcap`);
    }
  }
  if (m.quietHours !== null && m.quietHours >= R.quietHours) {
    out.push({
      id: 'quiet',
      tone: 'orange',
      label: 'No trades',
      text: `none in the last ${m.quietHours === 1 ? 'hour' : `${m.quietHours} h`}`,
    });
  }
}

function holderFlag(i: FlagInputs, out: Flag[], green: string[]) {
  const h = i.holders;
  if (!h || h.top10 === null) return;
  const floor = h.floor ? ' (20 largest read)' : '';
  if (h.equalBags) {
    out.push({
      id: 'holders',
      tone: 'red',
      label: 'Cluster',
      text: `top 10 hold ${share(h.equalBags.min)}–${share(h.equalBags.max)} each, ${share(h.top10)} together`,
    });
    return;
  }
  const top1Tone =
    h.top1 === null ? null : h.top1 >= R.top1Red ? 'red' : h.top1 >= R.top1Orange ? 'orange' : null;
  const top10Tone = h.top10 >= R.top10Red ? 'red' : h.top10 >= R.top10Orange ? 'orange' : null;
  const tone = top1Tone === 'red' || top10Tone === 'red' ? 'red' : (top1Tone ?? top10Tone);
  if (tone) {
    const who = h.top1Name ? `${h.top1Name} holds` : 'largest wallet';
    out.push({
      id: 'holders',
      tone,
      label: 'Concentrated',
      text: `top 10 hold ${share(h.top10)} of the supply${h.top1 !== null ? ` · ${who} ${share(h.top1)}` : ''}${floor}`,
    });
  } else if (h.top10 < R.top10Green && (h.holders ?? 0) >= R.top10GreenMinHolders) {
    green.push(`top 10 hold ${share(h.top10)}`);
  }
}

const ORDER: Record<FlagTone, number> = { red: 0, orange: 1, green: 2 };

/** The flags, red first, then orange, then one green line. */
export function flagsOf(i: FlagInputs): Flag[] {
  const out: Flag[] = [];
  const green: string[] = [];
  if (i.livePowers.length > 0) {
    out.push({
      id: 'powers',
      tone: 'red',
      label: 'Live mint powers',
      text: `someone can still ${i.livePowers.join(', ')}`,
    });
  }
  if (i.dev) devFlags(i.dev, out, green);
  launchFlags(i, out, green);
  serialFlag(i, out, green);
  marketFlags(i, out, green);
  holderFlag(i, out, green);
  if (i.linkedBought !== null && i.linkedBought >= R.linkedOrange) {
    out.push({
      id: 'linked',
      tone: 'orange',
      label: 'Dev-funded wallets',
      text: `wallets the dev sent SOL to bought ${share(i.linkedBought)}`,
    });
  }
  if (i.nameClone)
    out.push({ id: 'name', tone: 'orange', label: 'Copied name', text: i.nameClone });
  if (i.freshWallet)
    out.push({ id: 'wallet', tone: 'orange', label: 'Fresh dev wallet', text: i.freshWallet });
  if (i.lp) {
    if (i.lp.gone >= R.lpGreen) green.unshift(i.lp.burned ? 'LP burned' : 'LP locked');
    else if ((i.lp.withdrawable ?? 0) >= R.lpWithdrawableRed && !i.market.onCurve) {
      out.push({
        id: 'lp',
        tone: 'red',
        label: 'LP not locked',
        text: `${share(i.lp.withdrawable!)} of the main pool can be pulled`,
      });
    }
  }
  if (i.mintFreezeOff && i.livePowers.length === 0) green.push('mint and freeze revoked');
  const shown = out
    .map((f, n) => ({ f, n }))
    .sort((a, b) => ORDER[a.f.tone] - ORDER[b.f.tone] || a.n - b.n)
    .slice(0, R.maxLines)
    .map(({ f }) => f);
  if (green.length > 0) {
    const text = green.join(' · ');
    shown.push({
      id: 'clean',
      tone: 'green',
      label: text.charAt(0).toUpperCase() + text.slice(1),
      text: '',
    });
  }
  return shown;
}

/** A flag as one line of text, for the model, the offline text and the share card. */
export function flagLine(f: Flag): string {
  return f.text ? `${f.label}: ${f.text}` : f.label;
}

/**
 * The flags of a reading, with live values laid over its numbers when there
 * are some: the one call a page makes, whatever it refreshes.
 */
export function computeFlags(inputs: FlagInputs, live?: LiveValues | null): Flag[] {
  return flagsOf(withLive(inputs, live));
}
