import { readableNote } from '../plain-note';
import type { TokenReport } from '../contracts';
import { isSolanaAddress, shortAddress } from '../solana/address';
import type { SpecialistAnswer } from '../specialists/brief';
import { CREATOR_FROM } from '../specialists/catalog';
import {
  curveName,
  paidWords,
  pct as sharePct,
  shareOf,
  solOf,
  solWords,
} from '../specialists/words';
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

/**
 * What the mint lets someone do: every power someone holds, every rule in
 * force, and what could not be read; the powers nobody holds are summed up
 * in one sentence.
 */
function powersAccount(report: TokenReport): string | null {
  if (report.mint.completeness === 'unavailable' || !report.mint.data) {
    const note = report.mint.sources.find((s) => s.note)?.note;
    return `Mint: not read${note ? ` (${readableNote(note)})` : ''}.`;
  }
  const creator = report.creator.data.creator;
  const said = report.powers
    .filter((p) => p.status !== 'none')
    .map(
      (p) =>
        `${p.sentence}${p.status === 'held' && p.holder ? ` Held by ${short(p.holder)}${p.holder === creator ? ', the creator' : ''}.` : ''}`,
    );
  const none = (kind: string) => report.powers.some((p) => p.power === kind && p.status === 'none');
  const nobody = [
    none('mint') ? 'create new tokens' : '',
    none('freeze') ? 'freeze holders’ tokens' : '',
    none('metadata-update') ? 'change its name, symbol or image' : '',
  ].filter(Boolean);
  const nobodyWords =
    nobody.length > 0
      ? `No one can ${nobody.length === 1 ? nobody[0] : `${nobody.slice(0, -1).join(', ')} or ${nobody[nobody.length - 1]}`}.`
      : '';
  const program = report.mint.data.program === 'token-2022' ? 'Token-2022' : 'SPL Token';
  return `Mint (${program}): ${[nobodyWords, ...said].filter(Boolean).join(' ') || 'no power over the token was read.'}`;
}

/** The creator, its other tokens, what it did with this one, and the wallets it funded. */
function creatorAccount(report: TokenReport): string {
  const { creator, creatorHistory: history, creatorOnToken: onToken, linkedWallets } = report;
  const address = creator.data.creator as string;
  const supply = report.mint.data?.supply ?? report.holders.data.supply ?? null;
  const sentences: string[] = [
    `Creator: ${short(address)}${creator.data.from ? `, ${CREATOR_FROM[creator.data.from]}` : ''}.`,
  ];
  if (history && history.completeness !== 'unavailable') {
    const c = history.data.counts;
    // As the Creator History question counts them: a floor unless every curve and transaction was read.
    const atLeast =
      readFailed(report.failedReads, 'creator-launches') ||
      history.completeness !== 'full' ||
      !history.data.scanned.pumpCurvesListed
        ? 'at least '
        : '';
    sentences.push(
      c.launched === 0
        ? history.data.scanned.transactionsRead === 0 && history.data.scanned.transactionsListed > 0
          ? 'No other token by this address was found on pump.fun’s curves; none of its own transactions could be read.'
          : 'No other token by this address was found on pump.fun’s curves or in its transactions read.'
        : `This address launched ${atLeast}${c.launched} other token${c.launched === 1 ? '' : 's'}: ${c.graduated} graduated from their curve, ${c.active} traded in the last 24 hours, ${c.dead} launched over a day ago with no trade in the last 24 hours, ${c.unknown} not determined.`,
    );
  } else if (history) {
    sentences.push('Its other tokens could not be read this time.');
  }
  if (onToken && onToken.completeness !== 'unavailable') {
    const d = onToken.data;
    const bought = shareOf(d.bought, supply);
    if (d.bought !== '0' && bought !== null) {
      const part = (raw: string) => sharePct(shareOf(raw, supply) ?? 0);
      sentences.push(`It bought ${sharePct(bought)} of the supply${paidWords(d, part)}.`);
    }
    // A sale read is a sale; "did not sell" only when every move was read.
    if (d.sold !== '0') {
      const sold = shareOf(d.sold, supply);
      sentences.push(
        `In the transactions read, the creator sold ${sold !== null ? `${sharePct(sold)} of the supply` : 'some of this token'}.`,
      );
    } else {
      sentences.push(
        onToken.completeness === 'full'
          ? d.transactions.read === 0
            ? 'The creator has no move on this token: it did not sell any.'
            : `The creator did not sell this token in the ${d.transactions.read} transaction${d.transactions.read === 1 ? '' : 's'} on its token accounts, all of them read.`
          : d.transactions.read === 0 && d.transactions.listed > 0
            ? `None of the ${d.transactions.listed} transactions on the creator’s token accounts could be read this time: whether it sold is not known.`
            : `No sale by the creator was seen in the ${d.transactions.read} of ${d.transactions.listed} transactions read: not all of them, so a sale may be among the others.`,
      );
    }
    if (d.holdsNow !== null) {
      const holds = shareOf(d.holdsNow, supply) ?? d.holdsNowShare;
      sentences.push(
        d.holdsNow === '0' || holds === null
          ? d.holdsNow === '0'
            ? 'It holds none of it today.'
            : ''
          : `It holds ${sharePct(holds)} of the supply today.`,
      );
    }
  } else if (onToken) {
    // Unread is said: silence would read as "nothing to say".
    sentences.push('What it did with this token could not be read this time.');
  }
  if (linkedWallets && linkedWallets.completeness !== 'unavailable') {
    const l = linkedWallets.data;
    if (l.firstFunding) {
      const sol = solOf(l.firstFunding.lamports);
      sentences.push(
        `Its first SOL came from ${short(l.firstFunding.from)}${sol !== null ? ` (${solWords(sol)})` : ''}; who is behind that address is not read.`,
      );
    }
    const traded = l.funded.filter(
      (f) => f.onToken && (f.onToken.bought !== '0' || f.onToken.sold !== '0'),
    );
    if (l.funded.length > 0) {
      const sold = l.funded.reduce((n, f) => n + (shareOf(f.onToken?.sold, supply) ?? 0), 0);
      // Some funded wallets' trades not read: what is said holds for those read.
      const complete = l.funded.every((f) => f.onToken?.complete === true);
      const within = complete ? '' : ' in what was read';
      sentences.push(
        `Around the launch it sent SOL to ${l.funded.length} wallet${l.funded.length === 1 ? '' : 's'}; ${traded.length === 0 ? `none of them traded this token${within}` : `${traded.length} of them traded this token${sold > 0 ? `, selling ${complete ? '' : 'at least '}${sharePct(sold)} of the supply` : ''}${within}`}. A transfer links the addresses; it does not show who controls them.`,
      );
    }
  }
  return sentences.join(' ');
}

/** Wallets that got tokens together at launch, as the replay counted them. */
function launchAccount(report: TokenReport): string | null {
  const d = report.launch.data;
  const parts: string[] = [];
  const held = (x: number | null) =>
    x === null ? 'an unread share' : x === 0 ? 'none of it' : pct(x);
  if (d.sameSlot && d.sameSlot.share >= 0.001) {
    parts.push(
      `in the creation slot, ${d.sameSlot.wallets} wallet${d.sameSlot.wallets === 1 ? '' : 's'} other than the creator got ${pct(d.sameSlot.share)} of the supply and hold ${held(d.sameSlot.heldNow)} today`,
    );
  }
  if (d.payerGroup && d.payerGroup.share >= 0.001) {
    parts.push(
      `${d.payerGroup.wallets} wallet${d.payerGroup.wallets === 1 ? '' : 's'} got ${pct(d.payerGroup.share)} of the supply in transactions paid by the creator or the creation’s fee payer, and hold ${held(d.payerGroup.heldNow)} today`,
    );
  }
  const early = d.summary?.early;
  if (early && early.wallets > 0) {
    // A sum of purchases, not a holding: some sold back within seconds.
    parts.push(
      `in the first ${d.summary!.earlySeconds} seconds, ${early.wallets} address${early.wallets === 1 ? '' : 'es'} other than the creator bought a total of ${pct(early.share)} of the supply across their purchases${
        early.heldNow === null
          ? ''
          : `, and hold ${held(early.heldNow)} today${early.unread ? ` (${early.unread} not read)` : ''}`
      }`,
    );
  }
  // Passed on with nothing paid back: transfers, never sales.
  const sent = d.summary?.creatorSent ?? 0;
  if (sent >= 0.001) {
    const locked = d.summary?.creatorLocked ?? 0;
    parts.push(
      `the creator transferred ${pct(sent)} of the supply to other addresses with no payment read in return${
        locked >= 0.001 ? ` (${pct(locked)} of it into or out of a lock or vesting program)` : ''
      }: transfers, not sales`,
    );
  }
  if (parts.length === 0) return null;
  return `Launch: ${parts.join('; ')}.`;
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
  // Where the supply went at launch, by role, comes first when the launch
  // handed it out beyond its curve: it is what the rest is read against.
  // Not when the replay failed: "nobody bought" would state an absence it did not read.
  const flow = readFailed(failedReads, 'launch-replay') ? undefined : toFacts(report).supplyFlow;
  if (flow) parts.push(`Launch: ${flowSentence(flow, report.creator.data.creator)}`);
  const powers = powersAccount(report);
  if (powers) parts.push(powers);
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
  if (holders.completeness === 'unavailable' || holders.data.method === 'none') {
    parts.push(
      `Holder concentration: not measured (${noteOf(holders.sources[0]?.note) ?? 'source unavailable'}).`,
    );
  } else {
    const h = holders.data;
    const setAside = h.pooledShare ?? null;
    const largest = h.top.find((x) => x.kind === 'wallet' || x.kind === 'contract');
    const aside =
      setAside !== null && setAside > 0
        ? ` ${pct(setAside)} of the supply sits on bonding curves, in pools, locks or with the incinerator, and is left out of these shares.`
        : '';
    parts.push(
      `Holders: ${h.holderCount !== null ? `${count(h.holderCount)} in all` : `at least ${count(h.holdersAtLeast)}`}; the largest${largest?.name ? `, ${largest.name},` : ''} holds ${pct(h.concentration.top1)} of what circulates${h.method === 'largest-accounts' ? ' (from the largest token accounts only)' : ''}; the top 10 hold ${pct(h.concentration.top10)} combined.${aside}`,
    );
  }
  const launch = launchAccount(report);
  if (launch) parts.push(launch);
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
    else if (graduation && graduation.progress !== null) {
      const sol = graduation.raised?.mint === null ? solOf(graduation.raised.raw) : null;
      bits.push(
        `${pct(graduation.progress)} of the way along its ${pad ? curveName(pad) : 'launch curve'}${sol !== null ? `, which holds ${solWords(sol)}` : ''}`,
      );
    }
    if (bits.length) parts.push(`Market: ${bits.join(', ')}.`);
    const perTrade = volumePerTrade(market);
    if (perTrade !== null && m.txns) {
      const trades = m.txns.h24.buys + m.txns.h24.sells;
      parts.push(
        `Over 24 hours: ${usdWords(m.volumeUsd?.h24 ?? 0)} in volume across ${count(trades)} trade${trades === 1 ? '' : 's'}, averaging ${usdWords(perTrade)} per trade.`,
      );
    }
  }
  // What only the questions work out: the creator wallet's age at launch,
  // and a name taken from a well-known token.
  const answer = (id: SpecialistAnswer['specialist']) =>
    specialists?.find((a) => a.specialist === id && a.signal !== 'unknown');
  const age = answer('wallet-age');
  if (age && age.facts[0]) parts.push(`Creator’s wallet: ${age.facts[0]}`);
  const name = answer('name-clone');
  if (name && (name.signal === 'concern' || name.signal === 'observation')) {
    parts.push(`Name: ${name.facts.join(' ')}`);
  }
  // A failed read is already said at the top. Otherwise "not full" only means
  // a read covered part of the data by design (a page limit), stated above:
  // never "not all sources responded" when every source did.
  if (report.completeness !== 'full' && failedReads.length === 0)
    parts.push('Some reads cover only part of the data; their limits are stated above.');
  return parts.join('\n\n');
}
