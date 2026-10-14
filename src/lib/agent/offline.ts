import type { TokenReport } from '../contracts';
import { volumePerTrade } from '../market';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

/** Plain factual fallback. Explicitly does not claim to perform agent reasoning. */
export function offlineExplanation(report: TokenReport): string {
  const parts: string[] = [
    'This account is produced without the reasoning agent: it lists the observed facts without cross-examining or interpreting them.',
  ];
  const { creator, holders, market } = report;
  const creatorNote = creator.sources[0]?.note;
  if (creator.completeness === 'unavailable') {
    // Say why: "not a pons launch" and "the node did not answer" are different facts.
    parts.push(
      creatorNote?.startsWith('not a pons launch')
        ? 'Creator history: this token was not launched through pons, so there is no launch record to read a creator history from.'
        : `Creator history could not be read${creatorNote ? ` (${creatorNote})` : ''}.`,
    );
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
    const perTrade = volumePerTrade(market);
    if (perTrade !== null && m.txns) {
      const trades = m.txns.h24.buys + m.txns.h24.sells;
      parts.push(
        `Over 24 hours: ${m.volumeUsd?.h24.toFixed(2)} USD in volume across ${trades} trades, averaging ${perTrade.toFixed(2)} USD per trade.`,
      );
    }
  }
  if (report.completeness !== 'full')
    parts.push(
      'Not all sources responded. This is a partial view, and some observations cannot be verified here.',
    );
  return parts.join('\n\n');
}
