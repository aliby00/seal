import { OTHER_LAUNCH_SALES_DAYS } from '../contracts/creator';
import type { TokenReport } from '../contracts';
import type { SpecialistAnswer } from '../specialists/brief';
import { volumePerTrade } from '../market';
import { READ_WORDS, readFailed } from '../failed-reads';
import { toFacts } from '../facts';
import { flowSentence } from '../supply-flow';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

/** "0x780a…6cba": a full address in a sentence is read as noise, not as a fact. */
function short(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address)
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
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

const ROLE: Record<'deployer' | 'launcher' | 'first-minter', string> = {
  deployer: 'deployed by',
  launcher: 'launched by',
  'first-minter': 'first minted by',
};

/** A token traced back to its first mint: who, through what, and what followed. */
function deployerAccount(report: TokenReport): string {
  const data = report.creator.data;
  const origin = data.origin;
  if (!origin) return '';
  const sentences: string[] = [
    origin.launchpad
      ? origin.creatorFrom === 'launch-record'
        ? `Creator: this token was launched through ${origin.launchpad.name}, whose launch record names ${short(data.creator)}.`
        : `Creator: this token was launched through ${origin.launchpad.name}, in a transaction sent by ${short(data.creator)}.`
      : `Creator: no known launchpad recorded this token. It was ${ROLE[origin.role]} ${short(data.creator)}` +
        (origin.launchContract ? ` through the contract ${short(origin.launchContract)}` : '') +
        '.',
  ];
  if (origin.role === 'first-minter') {
    sentences.push(
      'That address sent the transaction of its first mint, after the contract already existed; this alone does not show who wrote it.',
    );
  }
  if (origin.transactionCount !== null) {
    sentences.push(
      `The wallet has sent ${count(origin.transactionCount)} transaction${origin.transactionCount === 1 ? '' : 's'}.`,
    );
  }
  const launched = data.counts.launched;
  const where = origin.launchpadsRead?.length
    ? `Looking on ${origin.launchpadsRead.join(', ')}`
    : 'Through the same launch contract';
  sentences.push(
    readFailed(report.failedReads, 'creator-launches')
      ? `This address launched at least ${launched} token${launched === 1 ? '' : 's'}; some of its launches could not be read this time.`
      : origin.launchesListed
        ? `${where}, this address launched ${launched} token${launched === 1 ? '' : 's'}.`
        : origin.launchpad
          ? 'Its other launches on this launchpad cannot be listed from the chain.'
          : 'Its other launches cannot be listed from the chain.',
  );
  // Which launchpads cannot be read is listed with the sources: here, a list of
  // names and contract addresses buried the facts (RBCAT, 16/11/2026).
  const sales = data.tokens.filter((t) => t.creatorDumped !== null);
  const liquidity = data.tokens.filter((t) => t.liquidityPulled !== null);
  if (sales.length > 0) {
    const own = sales.find((t) => String(t.address).toLowerCase() === report.token.toLowerCase());
    const window = own?.salesWindow;
    const ownWords = window
      ? window.wholeLife
        ? `this token over its whole life so far${window.days !== null ? ` (${window.days} days)` : ''}`
        : `this token up to day ${window.days ?? '?'} after its launch`
      : null;
    const others = sales.length - (own ? 1 : 0);
    const sold = sales.filter((t) => t.creatorDumped).length;
    if (sales.length === 1 && own && ownWords) {
      const over = ownWords.replace(/^this token /, 'its ');
      sentences.push(
        sold === 1
          ? `The creator sold into this token’s market (sales read over ${over}).`
          : `The creator has not sold into this token’s market (read over ${over}).`,
      );
    } else
      sentences.push(
        `Of ${sales.length} launch${sales.length === 1 ? '' : 'es'} checked, the creator sold into the market on ${sales.filter((t) => t.creatorDumped).length}` +
          (ownWords
            ? ` (sales read for ${ownWords}${others > 0 ? `, and in the first ${OTHER_LAUNCH_SALES_DAYS} days after each other launch` : ''}).`
            : ` within the first ${OTHER_LAUNCH_SALES_DAYS} days after each launch.`),
      );
  }
  if (liquidity.length === 1 && liquidity[0]!.liquidityPulled === false && sales.length <= 1) {
    sentences.push(
      `The creator removed no liquidity in the first ${OTHER_LAUNCH_SALES_DAYS} days after the launch.`,
    );
  } else if (liquidity.length > 0) {
    sentences.push(
      `Of ${liquidity.length} with a market that could be read, liquidity was removed on ${liquidity.filter((t) => t.liquidityPulled).length} in the first ${OTHER_LAUNCH_SALES_DAYS} days after each launch.`,
    );
  }
  const graduated = data.tokens.filter((t) => t.outcome === 'graduated').length;
  sentences.push(
    origin.graduationRead && data.tokens.length > 0
      ? data.tokens.length === 1
        ? `It ${graduated === 1 ? 'graduated' : 'has not graduated'} from its launch curve to an open market.`
        : `${graduated} of the ${data.tokens.length} launches read in detail graduated from their launch curve to an open market.`
      : origin.role === 'deployer' && !origin.launchpad
        ? 'The token was deployed on its own, with no launch curve: graduation does not apply.'
        : 'What became of these launches after their launch curve is not measured here.',
  );
  return sentences.join(' ');
}

/** Plain factual fallback. Explicitly does not claim to perform agent reasoning. */
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
  const creatorNote = creator.sources[0]?.note;
  if (creator.completeness === 'unavailable') {
    // Say why: "not a pons launch" and "the node did not answer" are different facts.
    parts.push(
      creatorNote?.includes('first mint')
        ? 'Creator: not found. No launch record names one, and the transaction of the token’s first mint could not be traced.'
        : creatorNote?.startsWith('not a pons launch') ||
            creatorNote?.startsWith('no launch record')
          ? 'Creator history: no launch record names a creator for this token, so there is no history to read.'
          : `Creator history could not be read${creatorNote ? ` (${creatorNote})` : ''}.`,
    );
  } else if (creator.data.origin?.source === 'deployer') {
    parts.push(deployerAccount(report));
  } else {
    const c = creator.data.counts;
    if (c.launched === 0 && creator.completeness === 'partial') {
      // The launch was found, but the creator's launches could not be read:
      // "0 tokens launched" would contradict the token being analysed.
      parts.push(
        `Creator: ${short(creator.data.creator)}. Their other launches could not be read${creatorNote ? ` (${creatorNote})` : ''}.`,
      );
    } else {
      const detailed = creator.data.tokens.length;
      const outcomes =
        detailed < c.launched
          ? `of the ${detailed} most recent, ${c.graduated} graduated and ${c.abandoned} were abandoned`
          : `including ${c.graduated} graduated and ${c.abandoned} abandoned`;
      parts.push(
        `Creator: ${readFailed(failedReads, 'creator-launches') ? 'at least ' : ''}${c.launched} token${c.launched === 1 ? '' : 's'} launched; ${outcomes}.` +
          (creator.completeness === 'partial' && creatorNote ? ` Limit: ${creatorNote}.` : ''),
      );
    }
  }
  if (holders.completeness === 'unavailable') {
    parts.push(
      `Holder concentration: not measured (${holders.sources[0]?.note ?? 'source unavailable'}).`,
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
    parts.push(`Market: ${market.sources[0]?.note ?? 'no data available'}.`);
  } else {
    const m = market.data;
    const bits: string[] = [];
    if (m.priceUsd !== null) bits.push(`price ${usdWords(m.priceUsd)}`);
    if (m.liquidityUsd !== null && m.liquidityCheck?.current === false) {
      bits.push(
        `a listed liquidity of ${usdWords(m.liquidityUsd)} that is not current: the token’s pools hold ${pct(m.liquidityCheck.poolsShare)} of its supply on chain`,
      );
    } else if (m.liquidityUsd !== null) bits.push(`liquidity ${usdWords(m.liquidityUsd)}`);
    if (m.quiet)
      bits.push(`no trade in the last ${m.quiet.hours === 1 ? 'hour' : `${m.quiet.hours} hours`}`);
    if (m.graduation)
      bits.push(
        `graduation at ${pct(m.graduation.progress)} of the ${m.graduation.thresholdEth} ETH threshold`,
      );
    if (bits.length) parts.push(`Market: ${bits.join(', ')}.`);
    const pool = m.activity;
    if (pool && m.pair === null) {
      parts.push(
        `Over 24 hours, counted from the launch pool’s own trades: ${pool.h24.buys} buys and ${pool.h24.sells} sells by ${pool.h24.traders} wallets (no price, as no trading pair is listed).`,
      );
    }
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
