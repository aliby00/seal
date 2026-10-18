import type { SpecialistAnswer } from './brief';
import type { SpecialistId } from './types';

/**
 * The ten questions said the way a non-technical reader would ask them, and
 * each answer cut to one line. The full facts stay one click away; nothing
 * here adds to them or judges the token.
 */

export const PLAIN_LABEL: Record<SpecialistId, string> = {
  'code-reuse': 'Copied trading rules',
  'wallet-age': 'Creator’s wallet',
  'funding-trace': 'Who funded the creator',
  'name-clone': 'Borrowed name',
  'holder-spread': 'Supply held by a few',
  'creator-history': 'Creator’s past tokens',
  'sell-path': 'Can holders sell',
  'volume-reality': 'Real trading',
  'liquidity-move': 'Liquidity pulled',
  'rule-change': 'Rules that can change',
};

const num = (text: string | undefined, pattern: RegExp): string | null =>
  text?.match(pattern)?.[1] ?? null;

const count = (n: string) => Number(n).toLocaleString('en-US');

/** One line, readable without the details. Falls back to the first fact. */
export function shortAnswer(answer: SpecialistAnswer): string {
  const first = answer.facts[0];
  const all = answer.facts.join(' ');
  const signal = answer.signal;
  switch (answer.specialist) {
    case 'wallet-age': {
      const sent = num(all, /has sent (\d+) transaction/);
      if (signal === 'concern') return 'A fresh wallet, with almost no history';
      if (sent) return `An active wallet: ${count(sent)} transactions sent`;
      break;
    }
    case 'funding-trace': {
      const f = answer.funding;
      if (f?.kind === 'service') {
        const busy = (f.path[0]?.txCount ?? 0) >= 50_000;
        return busy
          ? 'Funded from a high-volume service (an exchange, bridge or router)'
          : 'Funded from a contract, which links it to no one';
      }
      if (f?.kind === 'tool') return 'Funded through a batch-sending tool';
      if (f && f.linkedCreators > 0) {
        const launched = f.launches ? `, who launched ${count(String(f.launches))} tokens` : '';
        return `Its funder also funded ${count(String(f.linkedCreators))} other creators${launched}`;
      }
      if (f?.kind === 'wallet') return 'Funded by a wallet linked to no other creator';
      break;
    }
    case 'holder-spread': {
      const top1 = num(all, /largest holder(?: \([^)]*\))? has ([\d.]+)%/);
      const top10 = num(all, /top 10 have ([\d.]+)%/);
      if (top1 && top10) return `Largest holder ${top1}% · top 10 ${top10}% (pools left out)`;
      break;
    }
    case 'creator-history': {
      const other = num(all, /launched (\d+) other token/);
      const sold = num(all, /(\d+) saw the creator sell/);
      const graduated = num(all, /(\d+) graduated/);
      if (other === '0') return 'No earlier token from this creator';
      if (other) {
        const parts = [`${count(other)} earlier tokens`];
        if (sold !== null) parts.push(`sold on ${sold}`);
        if (graduated !== null) parts.push(`${graduated} graduated`);
        return parts.join(' · ');
      }
      break;
    }
    case 'sell-path': {
      if (signal === 'concern') return 'Selling may be blocked';
      if (signal === 'reassurance') return 'Nothing in its rules can block selling';
      const sells = num(all, /(\d+) sell\(s\)/);
      if (sells && Number(sells) > 0) return `${count(sells)} sales went through in 24 hours`;
      if (signal === 'observation') return 'Sales go through, but its rules can step in';
      break;
    }
    case 'volume-reality': {
      if (signal === 'concern') return 'Most trading comes from a few addresses';
      const trades = num(all, /(\d+) trades in 24 hours/);
      if (trades) return `${count(trades)} trades in 24 hours`;
      break;
    }
    case 'liquidity-move':
      if (signal === 'concern') return 'Liquidity was pulled out';
      if (signal === 'quiet' || signal === 'reassurance') return 'No liquidity pulled out';
      break;
    case 'rule-change':
      if (signal === 'concern') return 'Its rules can be rewritten after people buy';
      if (signal === 'reassurance') return 'Its rules cannot be upgraded';
      if (/\bAnother pool of this token \([^)]*\) runs trading rules\b/.test(all))
        return 'Its main pool has no special trading rules; another pool has';
      if (/no trading rules/i.test(all)) return 'No special trading rules';
      break;
    case 'code-reuse': {
      const otherHooked = /\bAnother pool of this token \([^)]*\) runs trading rules\b/.test(all);
      if (/no hook|without trading rules/i.test(all.split('Another pool')[0] ?? all))
        return otherHooked
          ? 'Its main pool has no special trading rules; another pool has'
          : 'No special trading rules';
      const markets = num(all, /used by (\d+) market/);
      if (markets !== null && Number(markets) <= 1) return 'Its trading rules are its own';
      if (markets !== null) return `Its trading rules are used by ${count(markets)} markets`;
      const recent = num(all, /(\d+) other markets?(?:\(s\))? use the trading rules/);
      if (recent === '0') return 'No other recent market uses its trading rules';
      if (recent !== null)
        return `Its trading rules are used by ${count(recent)} other recent markets`;
      if (signal === 'observation' || signal === 'concern')
        return 'Its trading rules are used by other markets too';
      break;
    }
    case 'name-clone':
      if (signal === 'concern') return 'Its name or symbol is taken from another token';
      if (signal === 'quiet') return 'No borrowed name found';
      break;
  }
  const text = first ?? answer.limits[0] ?? '';
  return text.length > 96 ? `${text.slice(0, 93).trimEnd()}…` : text;
}
