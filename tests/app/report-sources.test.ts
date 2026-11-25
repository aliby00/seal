import { describe, expect, it } from 'vitest';
import { sourceLimits, sourceName } from '../../src/app/components/report-sources';

/**
 * "Sources & limitations", from what /api/analyze served on staging on
 * 25/11/2026 (~/sol-e2e/1039): USDC and Bouncer (BOUNCER, pump.fun).
 */

const USDC_SOURCES = [
  { name: 'solana-rpc' },
  {
    name: 'solana-rpc',
    note: 'the mint has more than 3000 transactions: its creation was not reached',
  },
  {
    name: 'solana-rpc',
    note: "too many token accounts to read them all; only the 20 largest token accounts were read: the holder count is a floor, and an owner's smaller accounts are not added",
  },
  { name: 'dexscreener-solana' },
];

const BOUNCER_SOURCES = [
  { name: 'solana-rpc' },
  { name: 'solana-rpc' },
  { name: 'solana-rpc' },
  {
    name: 'dexscreener-solana',
    note: "DexScreener gives no liquidity figure for the main pair (pumpfun); the main pair trades against XMR, not SOL, USDC or USDT: its USD figures go through that token's price",
  },
];
const BOUNCER_LAUNCH_NOTE =
  '60 transactions read from the creation on, covering 26 slots (6 seconds by block time); 14 of them changed balances of this token; later transactions are not read (at most 60); 151 failed transactions in the window moved nothing; the window read ends before 10 seconds: later buys are not counted among the first buyers';
const BOUNCER_VIEW = {
  mint: { read: 'full' as const, data: null },
  creator: { read: 'full' as const, data: null },
  holders: { read: 'full' as const, data: null },
  market: { read: 'partial' as const, note: BOUNCER_SOURCES[3]!.note, data: null },
  launchpad: { read: 'full' as const, data: null },
  graduation: { read: 'full' as const, data: null },
  liquidity: { read: 'unavailable' as const, note: 'no pool to read', data: null },
  launch: { read: 'partial' as const, note: BOUNCER_LAUNCH_NOTE, data: null },
  onToken: null,
  history: null,
  linked: null,
};

describe('Sources & limitations', () => {
  it('groups the reads by source, under a plain name, each limit once', () => {
    const groups = sourceLimits(USDC_SOURCES);
    expect(groups).toEqual([
      {
        source: 'solana-rpc',
        name: 'Solana',
        limits: [USDC_SOURCES[1]!.note, USDC_SOURCES[2]!.note],
      },
      { source: 'dexscreener-solana', name: 'DexScreener', limits: [] },
    ]);
  });

  it('never says "no limitations" for a source that reported one elsewhere', () => {
    const solana = sourceLimits(USDC_SOURCES).find((g) => g.source === 'solana-rpc');
    expect(solana?.limits.length).toBeGreaterThan(0);
  });

  it('adds the partial reads of the Solana view, the launch among them', () => {
    const groups = sourceLimits(BOUNCER_SOURCES, BOUNCER_VIEW);
    expect(groups.map((g) => g.name)).toEqual(['Solana', 'DexScreener']);
    // The three Solana reads said nothing, but the launch was only partly read.
    expect(groups[0]!.limits).toEqual([BOUNCER_LAUNCH_NOTE]);
    // The market note is in the sources already: said once.
    expect(groups[1]!.limits).toEqual([BOUNCER_SOURCES[3]!.note]);
    // "no pool to read" is not a partial read: it is not a limitation.
    expect(JSON.stringify(groups)).not.toContain('no pool to read');
  });

  it('writes each limit in plain words, and drops the duplicates that gives', () => {
    const plain = (note: string) =>
      /busy|rate-limit/.test(note) ? 'The chain node was busy.' : note;
    const groups = sourceLimits(
      [
        { name: 'solana-rpc', note: 'rate-limit : too many requests' },
        { name: 'solana-rpc', note: 'busy node' },
      ],
      null,
      plain,
    );
    expect(groups).toEqual([
      { source: 'solana-rpc', name: 'Solana', limits: ['The chain node was busy.'] },
    ]);
  });

  it('names the sources in plain words, and keeps an unknown name as given', () => {
    expect(sourceName('solana-rpc')).toBe('Solana');
    expect(sourceName('dexscreener-solana')).toBe('DexScreener');
    expect(sourceName('other')).toBe('other');
  });
});
