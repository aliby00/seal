import type { TokenReport } from '../contracts';
import type { SpecialistAnswer } from '../specialists/brief';
import { volumePerTrade } from '../market';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
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
        ? `Creator: this token was launched through ${origin.launchpad.name}, whose launch record names ${data.creator}.`
        : `Creator: this token was launched through ${origin.launchpad.name}, in a transaction sent by ${data.creator}.`
      : `Creator: no known launchpad recorded this token. It was ${ROLE[origin.role]} ${data.creator}` +
        (origin.launchContract ? ` through the contract ${origin.launchContract}` : '') +
        '.',
  ];
  if (origin.role === 'first-minter') {
    sentences.push(
      'That address sent the transaction of its first mint, after the contract already existed; this alone does not show who wrote it.',
    );
  }
  if (origin.transactionCount !== null) {
    sentences.push(
      `The wallet has sent ${origin.transactionCount} transaction${origin.transactionCount === 1 ? '' : 's'}.`,
    );
  }
  const launched = data.counts.launched;
  const where = origin.launchpadsRead?.length
    ? `Looking on ${origin.launchpadsRead.join(', ')}`
    : 'Through the same launch contract';
  sentences.push(
    origin.launchesListed
      ? `${where}, this address launched ${launched} token${launched === 1 ? '' : 's'}.`
      : 'Its other launches on this launchpad cannot be listed from the chain.',
  );
  if (origin.launchpadsNotRead?.length) {
    sentences.push(`Launches on ${origin.launchpadsNotRead.join(', ')} are not listed.`);
  }
  const sales = data.tokens.filter((t) => t.creatorDumped !== null);
  const liquidity = data.tokens.filter((t) => t.liquidityPulled !== null);
  if (sales.length > 0) {
    sentences.push(
      `Of ${sales.length} launch${sales.length === 1 ? '' : 'es'} checked, the creator sold into the market on ${sales.filter((t) => t.creatorDumped).length} within about 11 days of launch.`,
    );
  }
  if (liquidity.length > 0) {
    sentences.push(
      `Of ${liquidity.length} with a market that could be read, liquidity was removed on ${liquidity.filter((t) => t.liquidityPulled).length} over the same window.`,
    );
  }
  sentences.push(
    origin.role === 'deployer' && !origin.launchpad
      ? 'The token was deployed on its own, with no launch curve: graduation does not apply.'
      : 'Graduation is read on pons launches only, so what became of these launches is not measured here.',
  );
  return sentences.join(' ');
}

/** Plain factual fallback. Explicitly does not claim to perform agent reasoning. */
export function offlineExplanation(report: TokenReport, specialists?: SpecialistAnswer[]): string {
  const parts: string[] = [
    'This account is produced without the reasoning agent: it lists the observed facts without cross-examining or interpreting them.',
  ];
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
        `Creator: ${creator.data.creator}. Their other launches could not be read${creatorNote ? ` (${creatorNote})` : ''}.`,
      );
    } else {
      const detailed = creator.data.tokens.length;
      const outcomes =
        detailed < c.launched
          ? `of the ${detailed} most recent, ${c.graduated} graduated and ${c.abandoned} were abandoned`
          : `including ${c.graduated} graduated and ${c.abandoned} abandoned`;
      parts.push(
        `Creator: ${c.launched} token${c.launched === 1 ? '' : 's'} launched; ${outcomes}.` +
          (creator.completeness === 'partial' && creatorNote ? ` Limit: ${creatorNote}.` : ''),
      );
    }
  }
  if (holders.completeness === 'unavailable') {
    parts.push(
      `Holder concentration: not measured (${holders.sources[0]?.note ?? 'source unavailable'}).`,
    );
  } else {
    parts.push(
      `Holders: the largest holds ${pct(holders.data.concentration.top1)} of ${holders.completeness === 'full' ? 'the supply held outside pools and burn addresses' : 'the supply held by the holders that could be read'}; the top 10 hold ${pct(holders.data.concentration.top10)} combined.`,
    );
  }
  if (market.completeness === 'unavailable') {
    parts.push(`Market: ${market.sources[0]?.note ?? 'no data available'}.`);
  } else {
    const m = market.data;
    const bits: string[] = [];
    if (m.priceUsd !== null) bits.push(`price ${m.priceUsd} USD`);
    if (m.liquidityUsd !== null) bits.push(`liquidity ${m.liquidityUsd.toFixed(2)} USD`);
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
        `Over 24 hours: ${m.volumeUsd?.h24.toFixed(2)} USD in volume across ${trades} trades, averaging ${perTrade.toFixed(2)} USD per trade.`,
      );
    }
  }
  // Who funded the creator, as the funding question says it: an exchange is
  // named as one, so it is never read as a link between creators.
  const funding = specialists?.find((a) => a.specialist === 'funding-trace');
  if (funding && funding.signal !== 'unknown' && funding.facts.length > 0) {
    parts.push(`Funding: ${funding.facts.join(' ')}`);
  }
  if (report.completeness !== 'full')
    parts.push(
      'Not all sources responded. This is a partial view, and some observations cannot be verified here.',
    );
  return parts.join('\n\n');
}
