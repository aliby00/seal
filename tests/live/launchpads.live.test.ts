import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { collect } from '../../src/lib/collect';
import type { TokenReport } from '../../src/lib/contracts';

/**
 * What the collection returns for live tokens of every launchpad seen on
 * Robinhood Chain (docs/launchpads.md). Only with SEAL_LIVE=1, never in CI:
 *
 *   SEAL_LIVE=1 SEAL_LIVE_OUT=/tmp/launchpads.json npx vitest run tests/live/launchpads.live.test.ts
 *
 * Tokens picked on 17/10/2026 from DexScreener (24 h volume, recent pairs).
 */
const live = process.env.SEAL_LIVE === '1';

export const LAUNCHPAD_CASES = [
  { name: 'ROBINHOOD', via: 'flap.sh', token: '0xB417A5DAB44C607520bBa70A6e08D826C4c57777' },
  { name: '4663', via: 'flap.sh (tax vault)', token: '0xFB437a37A0B2f4A6AeB234D994669F33A5237777' },
  { name: 'ELON', via: 'flap.sh (tax vault)', token: '0xE747e3E465c04eA44Ce69e2e58d6810cE3817777' },
  { name: 'ROBINHOOD', via: 'curve 0x7ed5', token: '0x008Df4b3E857D06c4603Aeb11F267ccD32ce2005' },
  { name: 'ROBINHOOD', via: 'curve 0x7ed5', token: '0xeEC414174F7dCBA9E3Aa1672A1cf57078E65aE28' },
  { name: 'FRC', via: 'curve 0x7ed5', token: '0x8EA252aA4Ec8bf9E2b0Ff6E7c067CC878d5E615f' },
  { name: 'AGEM', via: 'curve 0x3d6e', token: '0x7c0495053F47Ec52eb4b678c4ad8f572dF745BFE' },
  { name: 'PAYLOAD', via: 'curve 0x3d6e', token: '0x9353AC4DcF13630169E22188894dEB20aBF40E3a' },
  { name: 'Wheel Smith', via: 'v4 0xf05a', token: '0xEB579e280648B6f48A840086A9e6631500A20684' },
  { name: 'MEME', via: 'Doppler (0x22e9)', token: '0x385F4f8ae47651ce5F58F5265395a669f8281e18' },
  {
    name: 'BOTCOIN',
    via: 'Doppler (ERC-4337)',
    token: '0xf5CD1235Da2fd37FA948658746B57cef19A8d09e',
  },
  { name: 'MPAD', via: 'metricpad', token: '0x2fC15e8cAc04540d51eb71b6def2Fe269f4fB25a' },
  {
    name: 'SPATIAL',
    via: 'direct deploy + v4',
    token: '0x691d3189e54C4e5F45d43466314F0290dCcAA695',
  },
  {
    name: 'HIVEMIND',
    via: 'minted by a contract',
    token: '0xc4B794225b4c3e041382BaFee92Fa0Ab78b3fFc3',
  },
  { name: 'JUGGERNAUT', via: 'pons 0xd9ec', token: '0xD7321801CAae694090694Ff55A9323139F043B88' },
] as const;

/** One line per block: what it returned, in a few words. */
export function summarize(report: TokenReport) {
  const creator = report.creator;
  const data = creator.data;
  const origin = data.origin as
    (NonNullable<typeof data.origin> & { launchpad?: { name: string } }) | undefined;
  const sales = data.tokens.filter((t) => t.creatorDumped !== null);
  return {
    creator:
      creator.completeness === 'unavailable' ? null : data.creator === '0x' ? null : data.creator,
    via: origin
      ? `${origin.source}/${origin.role}${origin.launchpad ? `/${origin.launchpad.name}` : ''}`
      : null,
    launched: creator.completeness === 'unavailable' ? null : data.counts.launched,
    listed: origin?.launchesListed ?? (creator.completeness === 'unavailable' ? null : true),
    salesChecked: sales.length,
    sold: sales.filter((t) => t.creatorDumped).length,
    creatorNote:
      creator.sources
        .map((s) => s.note)
        .filter(Boolean)
        .join(' | ') || null,
    replay: report.launch
      ? `${report.launch.data.movesInWindow} moves, ${report.launch.data.moves.filter((m) => m.kind === 'buy' || m.kind === 'sell').length} trades`
      : null,
    market:
      report.market.completeness === 'unavailable'
        ? null
        : `${report.market.data.pair?.slice(0, 10)} vol24h=${report.market.data.volumeUsd?.h24 ?? '-'}`,
    holders: report.holders.completeness,
  };
}

describe.skipIf(!live)('every launchpad, on the chain', () => {
  it('collects each token', { timeout: 1_800_000 }, async () => {
    const rows: Record<string, unknown>[] = [];
    // SEAL_LIVE_ONLY=0xb417,0x008d: a few tokens only, by address prefix.
    const only = (process.env.SEAL_LIVE_ONLY ?? '').toLowerCase().split(',').filter(Boolean);
    const cases = only.length
      ? LAUNCHPAD_CASES.filter((c) => only.some((p) => c.token.toLowerCase().startsWith(p)))
      : LAUNCHPAD_CASES;
    // SEAL_LIVE_PAUSE_MS: a pause between tokens, as between two readers.
    const pause = Number(process.env.SEAL_LIVE_PAUSE_MS ?? 0);
    for (const c of cases) {
      if (pause > 0 && c !== cases[0]) await new Promise((r) => setTimeout(r, pause));
      const t0 = Date.now();
      try {
        const report = await collect(c.token);
        rows.push({ ...c, ms: Date.now() - t0, ...summarize(report) });
        if (process.env.SEAL_LIVE_DEBUG) process.stderr.write(`${JSON.stringify(report)}\n`);
      } catch (error) {
        rows.push({ ...c, ms: Date.now() - t0, error: String(error) });
      }
      process.stderr.write(`${JSON.stringify(rows.at(-1))}\n`);
    }
    if (process.env.SEAL_LIVE_OUT)
      writeFileSync(process.env.SEAL_LIVE_OUT, JSON.stringify(rows, null, 2));
  });
});
