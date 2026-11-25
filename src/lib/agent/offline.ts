import { readableNote } from '../plain-note';
import type { TokenReport } from '../contracts';
import { isSolanaAddress, shortAddress } from '../solana/address';
import type { SpecialistAnswer } from '../specialists/brief';
import { volumePerTrade } from '../market';
import { READ_WORDS, readFailed } from '../failed-reads';
import { toFacts } from '../facts';
import { flowSentence } from '../supply-flow';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

/** "D234…X4e2": a full address in a sentence is read as noise, not as a fact. */
function short(address: string): string {
  return isSolanaAddress(address) ? shortAddress(address) : address;
}

/** "14,580", not "14580". */
const count = (n: number) => n.toLocaleString('en-US');

/** "$73.80", "$0.0012", "$0.0₉2303" — never "2.303e-10 USD". */
export function usdWords(value: number): string {
  if (value >= 1)
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value <= 0) return '$0';
  if (value >= 0.0001) return `$${Number(value.toPrecision(3))}`;
  // The zeros after the decimal point, written small as DexScreener does: 0.0₉2303.
  const zeros = Math.ceil(-Math.log10(value)) - 1;
  const digits = Math.round(value * 10 ** (zeros + 4))
    .toString()
    .replace(/0+$/, '');
  const sub = String(zeros).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]!);
  return `$0.0${sub}${digits}`;
}

/** Where the creator was read, in plain words. */
const FROM_WORDS = {
  'pump-curve': 'named by its pump.fun bonding curve',
  'creation-transaction': 'the fee payer of the transaction that created the mint',
  'metadata-update-authority':
    'the address that can update its metadata (the creator’s choice at launch, not proof of authorship)',
} as const;

/**
 * The creator, its other tokens and what it did with this one, as read.
 * TODO-SOLANA: a stand-in for the agent's rewrite; facts only.
 */
function creatorAccount(report: TokenReport): string {
  const { creator, creatorHistory: history, creatorOnToken: onToken } = report;
  const address = creator.data.creator as string;
  const sentences: string[] = [
    `Creator: ${short(address)}${creator.data.from ? `, ${FROM_WORDS[creator.data.from]}` : ''}.`,
  ];
  if (history && history.completeness !== 'unavailable') {
    const c = history.data.counts;
    const atLeast =
      readFailed(report.failedReads, 'creator-launches') || history.completeness === 'partial'
        ? 'at least '
        : '';
    sentences.push(
      c.launched === 0
        ? 'No other token by this address was found on pump.fun’s curves or in its recent transactions.'
        : `This address launched ${atLeast}${c.launched} other token${c.launched === 1 ? '' : 's'}: ${c.graduated} graduated from their curve, ${c.active} traded in the last 24 hours, ${c.dead} launched over a day ago with no trade in the last 24 hours, ${c.unknown} not determined.`,
    );
  } else if (history) {
    sentences.push('Its other tokens could not be read this time.');
  }
  if (onToken && onToken.completeness !== 'unavailable') {
    const sold = onToken.data.sold !== '0';
    sentences.push(
      sold
        ? 'In the transactions read, the creator sold some of this token.'
        : `The creator did not sell this token in the ${onToken.data.transactions.read} transaction${onToken.data.transactions.read === 1 ? '' : 's'} read${onToken.completeness === 'partial' ? ', not all of them' : ''}.`,
    );
    if (onToken.data.holdsNowShare !== null) {
      sentences.push(`It holds ${pct(onToken.data.holdsNowShare)} of the supply today.`);
    }
  }
  return sentences.join(' ');
}

/** Plain factual fallback. Explicitly does not claim to perform agent reasoning. */
const noteOf = (note: string | undefined) => (note ? readableNote(note) : undefined);

export function offlineExplanation(report: TokenReport, specialists?: SpecialistAnswer[]): string {
  const parts: string[] = [
    'This account is produced without the reasoning agent: it lists the observed facts without cross-examining or interpreting them.',
  ];
  const failedReads = report.failedReads ?? [];
  if (failedReads.length > 0) {
    parts.push(
      `Partial report: some reads failed this time (${[...new Set(failedReads.map((f) => READ_WORDS[f.read]))].join(', ')}). What they would have shown is not known. Try again in a minute.`,
    );
  }
  // Where the supply went at launch, by role, comes first: it is what the
  // rest is read against (SIRIUS: half to Virtuals' curve, a quarter to its
  // capital-formation wallet, a quarter to the creator's lock).
  const flow = toFacts(report).supplyFlow;
  if (flow) parts.push(`Launch: ${flowSentence(flow, report.creator.data.creator)}`);
  const { creator, holders, market } = report;
  const rawCreatorNote = creator.sources[0]?.note;
  const creatorNote = rawCreatorNote && readableNote(rawCreatorNote);
  if (creator.data.creator === null) {
    // Say why: "nothing names one" and "the node did not answer" are different facts.
    parts.push(
      readFailed(failedReads, 'creator')
        ? `Creator could not be read${creatorNote ? ` (${creatorNote})` : ''}.`
        : 'Creator: no curve, creation transaction or metadata authority on the chain names one.',
    );
  } else {
    parts.push(creatorAccount(report));
  }
  if (holders.completeness === 'unavailable') {
    parts.push(
      `Holder concentration: not measured (${noteOf(holders.sources[0]?.note) ?? 'source unavailable'}).`,
    );
  } else {
    const largest = holders.data.top.find((h) => h.kind === 'wallet' || h.kind === 'contract');
    const locks = (holders.data.setAside ?? []).filter((a) => a.role === 'vesting');
    const lockWords = locks.length
      ? ` ${locks.map((l) => `${l.share !== null ? pct(l.share) : 'Part'} of the supply sits in ${l.name ?? 'a vesting lock'}`).join('; ')}: locked, it is left out of these shares.`
      : '';
    parts.push(
      `Holders: the largest${largest?.name ? `, ${largest.name},` : ''} holds ${pct(holders.data.concentration.top1)} of ${holders.completeness === 'full' ? `the supply held outside pools${locks.length ? ', locks' : ''} and burn addresses` : 'the supply held by the holders that could be read'}; the top 10 hold ${pct(holders.data.concentration.top10)} combined.${lockWords}`,
    );
    const links = holders.data.creatorLinks;
    const linked = holders.data.top.filter((h) => h.fromCreator);
    if (links && (linked.length > 0 || links.distributors.length > 0 || links.burned > 0)) {
      const bits = [
        ...linked
          .slice(0, 3)
          .map(
            (h) =>
              `${short(h.address)} received ${pct(h.fromCreator!.share)} of the supply ${h.fromCreator!.via ? `through ${h.fromCreator!.via}, a contract the creator sent tokens to` : 'directly from the creator'}`,
          ),
        ...links.distributors.map(
          (d) =>
            `the creator sent ${pct(d.share)} of the supply to ${short(d.address)}, which passed it on to ${d.recipients} addresses`,
        ),
        ...(links.burned > 0 ? [`the creator burned ${pct(links.burned)} of the supply`] : []),
      ];
      parts.push(`From the creator’s own transfers: ${bits.join('; ')}.`);
    }
  }
  if (market.completeness === 'unavailable') {
    parts.push(`Market: ${noteOf(market.sources[0]?.note) ?? 'no data available'}.`);
  } else {
    const m = market.data;
    const bits: string[] = [];
    if (m.priceUsd !== null) bits.push(`price ${usdWords(m.priceUsd)}`);
    if (m.liquidityUsd !== null) bits.push(`liquidity ${usdWords(m.liquidityUsd)}`);
    if (m.quiet)
      bits.push(`no trade in the last ${m.quiet.hours === 1 ? 'hour' : `${m.quiet.hours} hours`}`);
    const graduation = report.graduation?.data;
    const pad = report.launchpad.data.launchpad?.name;
    if (graduation?.graduated) bits.push(`graduated from its ${pad ?? 'launch'} curve`);
    else if (graduation && graduation.progress !== null)
      bits.push(`${pct(graduation.progress)} of the way along its ${pad ?? 'launch'} curve`);
    if (bits.length) parts.push(`Market: ${bits.join(', ')}.`);
    const perTrade = volumePerTrade(market);
    if (perTrade !== null && m.txns) {
      const trades = m.txns.h24.buys + m.txns.h24.sells;
      parts.push(
        `Over 24 hours: ${usdWords(m.volumeUsd?.h24 ?? 0)} in volume across ${count(trades)} trade${trades === 1 ? '' : 's'}, averaging ${usdWords(perTrade)} per trade.`,
      );
    }
  }
  // Who funded the creator, as the funding question says it: an exchange is
  // named as one, so it is never read as a link between creators.
  const funding = specialists?.find((a) => a.specialist === 'funding-trace');
  if (funding && funding.signal !== 'unknown' && funding.facts.length > 0) {
    parts.push(`Funding: ${funding.facts.join(' ')}`);
  }
  // A failed read is already said at the top. Otherwise "not full" only means
  // a read covered part of the data by design (a page limit), stated above:
  // never "not all sources responded" when every source did.
  if (report.completeness !== 'full' && failedReads.length === 0)
    parts.push('Some reads cover only part of the data; their limits are stated above.');
  return parts.join('\n\n');
}
