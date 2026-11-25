/**
 * Numbers as the questions write them: shares of the supply, SOL, dates,
 * addresses. Plain and exact, never rounded into a different fact ("0.03%"
 * is not "0%"). No import: the report page uses some of these.
 */

/** "42.7%", "0.09%", "<0.01%". */
export function pct(value: number): string {
  if (value > 0 && value < 0.0001) return '<0.01%';
  const x = value * 100;
  return `${x.toFixed(x < 1 ? 2 : 1)}%`;
}

/**
 * A raw amount as a share of a raw supply, to twelve places, so one token of
 * a billion is a tiny share, never 0; `null` when either is unknown.
 */
export function shareOf(
  raw: string | null | undefined,
  supply: string | null | undefined,
): number | null {
  if (raw === null || raw === undefined || !supply) return null;
  try {
    const total = BigInt(supply);
    if (total <= 0n) return null;
    return Number((BigInt(raw) * 1_000_000_000_000n) / total) / 1e12;
  } catch {
    return null;
  }
}

/** "pump.fun bonding curve", "Meteora Dynamic Bonding Curve": a launchpad's curve, named once. */
export function curveName(launchpad: string): string {
  return /curve/i.test(launchpad) ? launchpad : `${launchpad} bonding curve`;
}

/** Lamports (a decimal string, maybe signed) as SOL. */
export function solOf(lamports: string | null | undefined): number | null {
  if (lamports === null || lamports === undefined) return null;
  try {
    return Number(BigInt(lamports)) / 1e9;
  } catch {
    return null;
  }
}

/** "3.80 SOL", "0.0590 SOL". */
export function solWords(sol: number): string {
  const a = Math.abs(sol);
  return `${a.toFixed(a >= 1 ? 2 : a >= 0.01 ? 4 : 6)} SOL`;
}

/**
 * What a wallet's buys cost, priced in SOL only for what SOL paid: " for 1.01
 * SOL"; " (0.69% for 1.00 SOL, the rest paid in another token than SOL)";
 * " (paid in another token than SOL)". `part` writes a raw amount as a share.
 */
export function paidWords(
  d: { bought: string; boughtForSol?: string; solSpent: string },
  part: (raw: string) => string,
): string {
  const spent = solOf(d.solSpent);
  const forSol = d.boughtForSol ?? d.bought;
  if (forSol === d.bought) return spent ? ` for ${solWords(spent)}` : '';
  if (forSol === '0') return ' (paid in another token than SOL)';
  return ` (${part(forSol)}${spent ? ` for ${solWords(spent)}` : ' paid in SOL'}, the rest paid in another token than SOL)`;
}

/** "Nov 25, 2026", in UTC, from Unix seconds. */
export function dayOf(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "44 minutes", "5 hours", "3 days": a duration in seconds, said plainly. */
export function durationWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} minutes`;
  const h = Math.round(s / 3600);
  if (h < 48) return `${h} hours`;
  return `${Math.round(s / 86_400)} days`;
}

/**
 * "D234…ChDH", as solana/address.ts writes it: kept here so the summary,
 * which the report page builds in the browser, needs no Solana module.
 */
export const short = (address: string) =>
  address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;

/** "1 wallet", "3 wallets". */
export const count = (n: number, word: string, plural = `${word}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? word : plural}`;
