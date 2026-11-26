import type { TimelineLaunch } from '@/lib/facts';

/**
 * Where each launch sits on the timeline, 2 % to 98 % of its width, by its
 * launch time: Solana launches have no usable block (0 for most), and by
 * block every mark sat on one dot while this token went off-screen (CAT
 * 4Q2x…, production 26/11/2026). Launches with no date are left out; fewer
 * than two dated launches draw no timeline.
 */
export function timelinePositions(
  launches: readonly TimelineLaunch[],
): { launch: TimelineLaunch; x: number }[] {
  const dated = launches
    .map((launch) => ({ launch, t: launch.launchedAt ? Date.parse(launch.launchedAt) : NaN }))
    .filter((d) => Number.isFinite(d.t))
    .sort((a, b) => a.t - b.t);
  if (dated.length < 2) return [];
  const first = dated[0]!.t;
  const span = Math.max(1, dated.at(-1)!.t - first);
  return dated.map(({ launch, t }) => ({
    launch,
    x: Math.min(98, Math.max(2, 2 + ((t - first) / span) * 96)),
  }));
}
