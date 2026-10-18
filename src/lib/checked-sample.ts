import type { CreatorHistoryData } from './contracts';

/**
 * Which of the creator's other launches had their sales and liquidity
 * checked, launchpad by launchpad, and what was seen on them. "Sold on 0 of
 * the 10 checked" said nothing of which ten: on AI (staging, 18/10/2026)
 * they were its ten latest Doppler launches, while the creator had sold into
 * the pools of 3 of its latest pons launches, none of them checked.
 */
export type CheckedLaunchpad = {
  /** The launchpad's name, as on each launch. */
  launchpad: string;
  /** The creator's other launches listed there (the analysed token not counted). */
  listed: number;
  /** How many of those, the most recent, were checked. */
  checked: number;
  /** Launches checked for sales, and how many showed one. */
  salesChecked: number;
  sold: number;
  /** Launches checked for liquidity removals, and how many showed one. */
  liquidityChecked: number;
  pulled: number;
};

/** How a launch with no launchpad named is grouped (deployer.ts' OTHER_LAUNCHES). */
const OTHER = 'its launch contract';

/**
 * The checks per launchpad, over the other launches only. A history that
 * says how many launches each launchpad has (`checkedSample`) gives the
 * totals; an older one, or a pons read, is counted over the launches read in
 * detail, its pons launches over all those listed.
 */
export function checkedByLaunchpad(
  data: Pick<CreatorHistoryData, 'tokens' | 'counts' | 'checkedSample' | 'origin'>,
  token: string,
): CheckedLaunchpad[] {
  const own = token.toLowerCase();
  const others = data.tokens.filter((t) => String(t.address).toLowerCase() !== own);
  const pons = !data.origin || data.origin.source === 'pons';
  const nameOf = (t: (typeof others)[number]) => t.launchpad ?? (pons ? 'pons' : OTHER);
  const groups = new Map<string, typeof others>();
  for (const t of others) groups.set(nameOf(t), [...(groups.get(nameOf(t)) ?? []), t]);
  const sample = data.checkedSample;
  const names = sample ? sample.map((s) => s.launchpad) : [...groups.keys()];
  const rows = names.map((launchpad): CheckedLaunchpad => {
    const list = groups.get(launchpad) ?? [];
    const sales = list.filter((t) => t.creatorDumped !== null);
    const liquidity = list.filter((t) => t.liquidityPulled !== null);
    const checked = list.filter((t) => t.creatorDumped !== null || t.liquidityPulled !== null);
    const fromSample = sample?.find((s) => s.launchpad === launchpad);
    // A pons read lists every pons launch; only some are read in detail.
    const listed =
      fromSample?.listed ??
      (pons && launchpad === 'pons'
        ? Math.max(
            list.length,
            data.counts.launched -
              (data.tokens.length - others.length) -
              (others.length - list.length),
          )
        : list.length);
    return {
      launchpad,
      listed,
      checked: Math.max(checked.length, fromSample?.checked ?? 0),
      salesChecked: sales.length,
      sold: sales.filter((t) => t.creatorDumped === true).length,
      liquidityChecked: liquidity.length,
      pulled: liquidity.filter((t) => t.liquidityPulled === true).length,
    };
  });
  return rows.filter((r) => r.listed > 0);
}

/** "pons", "launchpad 0x7ed5…": a name without its parenthesis, which reads double in a sentence. */
function where(launchpad: string): string {
  if (launchpad === OTHER) return 'through the same launch contract';
  return `on ${launchpad.replace(/\s*\([^)]*\)$/, '')}`;
}

const launches = (n: number) => `${n} launch${n === 1 ? '' : 'es'}`;

/**
 * Each launchpad's checks in words, for one signal, said of the creator's
 * other launches: "3 of the 10 most recent of its 21 launches on pons", "0
 * of its 2 launches on flap.sh", "none of its 4 launches on metricpad
 * checked".
 */
export function checkedWords(
  rows: readonly CheckedLaunchpad[],
  signal: 'sales' | 'liquidity',
): string[] {
  return rows.map((r) => {
    const n = signal === 'sales' ? r.salesChecked : r.liquidityChecked;
    const seen = signal === 'sales' ? r.sold : r.pulled;
    if (n === 0) return `none of its ${launches(r.listed)} ${where(r.launchpad)} checked`;
    if (n >= r.listed) return `${seen} of its ${launches(r.listed)} ${where(r.launchpad)}`;
    return `${seen} of the ${n} most recent of its ${launches(r.listed)} ${where(r.launchpad)}`;
  });
}

/** The list said as one clause: "a, b and c". */
export function joinClauses(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
