import type { TokenReport } from '../contracts';
import { readFailed } from '../failed-reads';
import { shortAddress } from '../solana/address';
import type { SpecialistAnswer } from '../specialists/brief';
import { joinAnd, traderReading, type TraderLine } from './trader-text';

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

/** Lines of "What stands out", at most. */
const STANDS_OUT_MAX = 4;
/** Below this weight a line is context: said only when nothing stronger is. */
const STANDS_OUT_MIN = 45;

/** What only the offline text has to say for itself: a mint not read, a dev not named. */
function gapLines(report: TokenReport): TraderLine[] {
  const out: TraderLine[] = [];
  if (report.mint.completeness === 'unavailable' || !report.mint.data) {
    out.push({
      id: 'powers',
      weight: 90,
      text: 'The mint itself could not be read: what it lets someone do to holders is not known.',
    });
  }
  if (report.creator.data.creator === null && !readFailed(report.failedReads, 'creator')) {
    const found = report.launch.data.creation;
    out.push({
      id: 'dev',
      weight: 50,
      text: found
        ? `No curve or metadata authority names a dev; ${shortAddress(found.payer)} paid for the creation.`
        : 'No curve, creation transaction or metadata authority names a dev.',
    });
  }
  // Unread is said: silence would read as "nothing to say".
  const onToken = report.creatorOnToken;
  if (report.creator.data.creator && onToken && !readFailed(report.failedReads, 'creator-sales')) {
    if (onToken.completeness === 'unavailable') {
      out.push({
        id: 'dev',
        weight: 47,
        text: 'What the dev did with this token could not be read this time.',
      });
    } else if (onToken.data.transactions.read === 0 && onToken.data.transactions.listed > 0) {
      out.push({
        id: 'dev',
        weight: 47,
        text: `None of the ${onToken.data.transactions.listed} transactions on the dev’s token accounts could be read this time: whether it sold is not known.`,
      });
    }
  }
  // A failed read is said once, in the closing line.
  if (
    (report.holders.completeness === 'unavailable' || report.holders.data.method === 'none') &&
    !readFailed(report.failedReads, 'holders')
  ) {
    out.push({ id: 'concentration', weight: 46, text: 'Who holds it could not be read.' });
  }
  return out;
}

/**
 * The reading without the model, in the same shape as the model's: what
 * stands out about this token, strongest first; what is clean about it in
 * one sentence; and what could not be read, in one line. Facts only, worded
 * the same way every time.
 */
export function offlineExplanation(report: TokenReport, specialists?: SpecialistAnswer[]): string {
  const reading = traderReading(report, specialists);
  const all = [...reading.standsOut, ...gapLines(report)].sort((a, b) => b.weight - a.weight);
  let stands = all.filter((l) => l.weight >= STANDS_OUT_MIN).slice(0, STANDS_OUT_MAX);
  if (stands.length === 0) stands = all.slice(0, 2);
  const parts: string[] = [];
  parts.push('What stands out');
  parts.push(
    stands.length > 0
      ? stands.map((l) => l.text).join(' ')
      : 'No single fact sets it apart in what was read.',
  );
  if (reading.clean.length > 0) {
    // Semicolons: a clause may hold its own list ("mint more, freeze holders or change its rules").
    const clean = reading.clean.join('; ');
    parts.push('What is clean', `${clean.charAt(0).toUpperCase()}${clean.slice(1)}.`);
  }
  if (reading.notRead.length > 0) {
    parts.push(`Not read this time: ${joinAnd(reading.notRead)}. Try again in a minute.`);
  }
  return parts.join('\n\n');
}
