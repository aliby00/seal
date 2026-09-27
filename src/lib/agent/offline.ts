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
  if (creator.completeness === 'unavailable') {
    parts.push('Creator history could not be read.');
  } else {
    const c = creator.data.counts;
    const scope =
      creator.completeness === 'partial'
        ? ` within the observed range (blocks ${creator.data.scannedRange.fromBlock} to ${creator.data.scannedRange.toBlock}; earlier history is not covered)`
        : '';
    parts.push(
      `Creator: ${c.launched} token${c.launched === 1 ? '' : 's'} launched${scope}, including ${c.graduated} graduated and ${c.abandoned} abandoned.`,
    );
  }
  if (holders.completeness === 'unavailable') {
    parts.push(
      `Holder concentration: not measured (${holders.sources[0]?.note ?? 'source unavailable'}).`,
    );
  } else {
    parts.push(
      `Holders: the largest holds ${pct(holders.data.concentration.top1)} of circulating supply; the top 10 hold ${pct(holders.data.concentration.top10)} combined. Liquidity pools and burn addresses are excluded from this calculation.`,
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
