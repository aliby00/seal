import { describe, expect, it } from 'vitest';
import { toTimeline } from '../../src/lib/facts';
import { makeReport } from '../specialists/helpers';

const TOKEN = '0x2222222222222222222222222222222222222222';

const launch = (address: string, block: number, sold: boolean | null, pulled: boolean | null) => ({
  address,
  pool: '0xpool',
  launchedAtBlock: block,
  launchedAt: `2026-10-0${block}T00:00:00.000Z`,
  outcome: 'abandoned' as const,
  graduationProgress: 0.1,
  creatorDumped: sold,
  liquidityPulled: pulled,
});

describe('toTimeline', () => {
  it('orders the launches in time and marks the token being read', () => {
    const report = makeReport(TOKEN, (r) => {
      r.creator.data.tokens = [
        launch(TOKEN, 3, null, null),
        launch('0xaaaa', 1, true, false),
        launch('0xbbbb', 2, false, true),
      ];
    });
    const timeline = toTimeline(report);
    expect(timeline.map((t) => t.block)).toEqual([1, 2, 3]);
    expect(timeline.map((t) => t.current)).toEqual([false, false, true]);
    expect(timeline[0]).toMatchObject({ sold: true, pulled: false });
    expect(timeline[1]).toMatchObject({ sold: false, pulled: true });
  });

  it('draws nothing when the creator history was not read', () => {
    const report = makeReport(TOKEN, (r) => {
      r.creator.completeness = 'unavailable';
    });
    expect(toTimeline(report)).toEqual([]);
  });
});
