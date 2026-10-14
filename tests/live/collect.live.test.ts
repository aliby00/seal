import { describe, expect, it } from 'vitest';
import { collect } from '../../src/lib/collect';

/**
 * Acceptance run against the real chain (T3.12). Only with SEAL_LIVE=1 —
 * never in CI, where the public RPC cuts off quickly.
 *
 *   SEAL_LIVE=1 npx vitest run tests/live/collect.live.test.ts
 *
 * Tokens picked on 14/10/2026 by reading the pons factories directly.
 */
const live = process.env.SEAL_LIVE === '1';

const CASES = [
  // pons, 0xf4fc factory, launched ~29 M blocks ago, never graduated.
  { name: 'abandoned', token: '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b', pons: true },
  // pons, 0xa24d factory: the most recent launch at the time of writing.
  { name: 'recent', token: '0x6587e8bdf0f6a55e13c013e158bb66a949bbe250', pons: true },
  // pons, deployer with 76 launches: the detail cap must kick in.
  { name: 'serial creator', token: '0x1329d3df5c17a0eb1008c06e2b30207ef719bfbe', pons: true },
  // Not a pons token: a Uniswap v4 market (« HOOD »).
  { name: 'not pons', token: '0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f', pons: false },
] as const;

describe.skipIf(!live)('collect on the chain', () => {
  for (const c of CASES) {
    it(c.name, { timeout: 90_000 }, async () => {
      const t0 = Date.now();
      const report = await collect(c.token);
      const creator = report.creator;
      process.stderr.write(
        JSON.stringify({
          case: c.name,
          ms: Date.now() - t0,
          completeness: report.completeness,
          creator: {
            completeness: creator.completeness,
            creator: creator.data.creator,
            counts: creator.data.counts,
            note: creator.sources[0]?.note,
          },
          holders: {
            completeness: report.holders.completeness,
            note: report.holders.sources[0]?.note,
          },
          market: {
            completeness: report.market.completeness,
            priceUsd: report.market.data.priceUsd,
            liquidityUsd: report.market.data.liquidityUsd,
            graduation: report.market.data.graduation,
            note: report.market.sources[0]?.note,
          },
        }) + '\n',
      );
      if (c.pons) {
        expect(creator.completeness).not.toBe('unavailable');
        expect(creator.data.counts.launched).toBeGreaterThan(0);
      } else {
        expect(creator.sources[0]?.note).toMatch(/not a pons launch/);
      }
      // A source is never starved by another one any more.
      expect(report.market.sources[0]?.note ?? '').not.toMatch(/budget/);
    });
  }

  it('rejects an invalid address', async () => {
    await expect(collect('0x1234')).rejects.toThrow();
  });
});
