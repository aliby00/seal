import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  creatorFrom,
  outcomeWord,
  pct,
  powerTitle,
  SolanaFacts,
  sortedPowers,
  tokens,
} from '../../src/app/components/SolanaFacts';
import {
  shareOf,
  solOf,
  toSolanaView,
  type SolanaView,
} from '../../src/app/components/solana-view';
import { findViolations } from '../../src/lib/agent/guardrails';
import { loadCollectRecording } from '../collect/recording';
import { CREATOR, MINT, solanaReport } from '../helpers/solana-report';

/**
 * The report screen's view of the Solana blocks, built from three reports
 * recorded on mainnet on 25/11/2026 (tests/fixtures/solana/collect): what the
 * screen draws must be what the report says, addresses in their own case, and
 * an absence left unknown when the read was partial.
 */

const view = (slug: string) => {
  const { report } = loadCollectRecording(slug);
  return { report, view: toSolanaView(report) };
};

/** Every base58 string of 32 to 88 characters in a JSON text. */
const base58Strings = (json: string) =>
  [...json.matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,88})"/g)].map((m) => m[1]!);

describe('the Solana view, on recorded reports', () => {
  it('pump.fun, creator sold: the creator bought at launch and sold it all, read in full', () => {
    const { report, view: v } = view('pump-creator-sold');
    expect(v.creator.data.address).toBe(report.creator.data.creator);
    expect(v.creator.data.from).toBe('pump-curve');
    expect(v.onToken?.read).toBe('full');
    expect(v.onToken?.data.bought).toBeGreaterThan(0);
    expect(v.onToken?.data.sold).toBe(v.onToken?.data.bought);
    expect(v.onToken?.data.holdsNow).toBe(0);
    expect(v.mint.data?.program).toBe('token-2022');
    expect(v.mint.data?.extensions).toEqual(['metadataPointer', 'tokenMetadata']);
    expect(v.mint.data?.metadata?.name).toBe('The Poor Bull');
    expect(v.launchpad.data?.name).toBe('pump.fun');
    expect(v.graduation?.data.graduated).toBe(false);
    expect(v.holders.data.setAside).toContainEqual({
      address: 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2',
      role: 'curve',
      share: 0.997896,
      name: 'pump.fun bonding curve',
    });
    // The curve is set aside, never listed as a holder.
    expect(
      v.holders.data.top.every((h) => h.owner === 'wallet' || h.owner === 'program-account'),
    ).toBe(true);
    expect(v.launch.data.creation?.slot).toBe(473491200);
  });

  it('Meteora DBC: a partial read that saw no sale leaves the sale unknown, never "none"', () => {
    const { report, view: v } = view('meteora-dbc');
    expect(report.creatorOnToken?.completeness).toBe('partial');
    expect(report.creatorOnToken?.data.sold).toBe('0');
    expect(v.onToken?.data.sold).toBeNull();
    expect(v.onToken?.data.bought).toBeGreaterThan(0);
    expect(v.launchpad.data?.name).toBe('Meteora Dynamic Bonding Curve');
    expect(v.graduation?.data.progress).toBeCloseTo(0.49, 2);
    expect(v.launch.data.sameSlot?.wallets).toBe(3);
  });

  it('PYUSD: the powers its extensions keep, held first, and pools whose holders are not read', () => {
    const { view: v } = view('pyusd');
    expect(v.powers.filter((p) => p.status === 'held').map((p) => p.power)).toContain(
      'permanent-delegate',
    );
    expect(sortedPowers(v.powers)[0]?.status).toBe('held');
    expect(v.liquidity.data.pools).toHaveLength(3);
    expect(v.liquidity.data.pools.every((p) => !p.known && p.burned === null)).toBe(true);
    expect(v.holders.data.method).toBe('none');
    expect(v.failed.map((f) => f.read)).toContain('holders');
    expect(v.launchpad.data).toBeNull();
  });

  it.each(['pump-creator-sold', 'meteora-dbc', 'pyusd'])(
    '%s: every address in the view is one the report holds, in the same case',
    (slug) => {
      const { report, view: v } = view(slug);
      const known = new Set(base58Strings(JSON.stringify(report)));
      const shown = base58Strings(JSON.stringify(v));
      expect(shown.length).toBeGreaterThan(0);
      for (const address of shown) expect(known.has(address)).toBe(true);
    },
  );

  it.each(['pump-creator-sold', 'meteora-dbc', 'pyusd'])('%s: stays small', (slug) => {
    expect(JSON.stringify(view(slug).view).length).toBeLessThan(20_000);
  });
});

describe('the Solana view, on a made-up report', () => {
  it('keeps a block that was not read as not read', () => {
    const v = toSolanaView(
      solanaReport({
        mint: {
          completeness: 'unavailable',
          sources: [{ name: 'solana-rpc', fetchedAt: '2026-11-25T00:00:00.000Z', note: '429' }],
          data: null,
        },
        creatorHistory: null,
        creatorOnToken: null,
        linkedWallets: null,
        graduation: null,
      }),
    );
    expect(v.mint).toEqual({ read: 'unavailable', note: '429', data: null });
    expect(v.history).toBeNull();
    expect(v.onToken).toBeNull();
    expect(v.linked).toBeNull();
    expect(v.graduation).toBeNull();
    expect(v.creator.data.address).toBe(CREATOR);
  });

  it('caps the lists it draws and says how many were left out', () => {
    const base = solanaReport();
    const tokens = Array.from({ length: 25 }, (_, i) => ({
      mint: MINT,
      launchpad: 'pump.fun',
      name: `T${i}`,
      signature: null,
      slot: null,
      launchedAt: null,
      curve: null,
      outcome: 'dead' as const,
      trades24h: 0,
      foundBy: ['pump-curves' as const],
    }));
    const v = toSolanaView({
      ...base,
      creatorHistory: {
        ...base.creatorHistory!,
        data: { ...base.creatorHistory!.data, tokens },
      },
    });
    expect(v.history?.data.tokens).toHaveLength(20);
    expect(v.history?.data.more).toBe(5);
  });
});

describe('amounts', () => {
  it('turns raw units into shares of the supply, exactly enough for a screen', () => {
    // Rounded down at the sixth place.
    expect(shareOf('119064729176629', '1000000000000000')).toBe(0.119064);
    expect(shareOf('0', '1000')).toBe(0);
    expect(shareOf('5', '0')).toBeNull();
    expect(shareOf(null, '10')).toBeNull();
    expect(shareOf('not a number', '10')).toBeNull();
    // Above 2^53: BigInt keeps it right.
    expect(shareOf('3906250000000000000', '7812500000000000000')).toBe(0.5);
  });

  it('turns lamports into SOL', () => {
    expect(solOf('1500000000')).toBe(1.5);
    expect(solOf(null)).toBeNull();
  });

  it('formats shares, whole tokens and SOL plainly', () => {
    expect(pct(null)).toBe('not read');
    expect(pct(0)).toBe('0%');
    expect(pct(0.0004)).toBe('<0.1%');
    expect(pct(0.119065)).toBe('12%');
    expect(pct(0.05)).toBe('5.0%');
    expect(tokens('1000000000000000', 6)).toBe('1B');
    expect(tokens('983999503236614', 6)).toBe('984M');
  });
});

describe('words', () => {
  it('names each power and each outcome plainly', () => {
    expect(powerTitle('permanent-delegate')).toBe('Move or burn any holder’s tokens');
    expect(outcomeWord('dead')).toBe('no trade in the last 24 h');
    expect(creatorFrom('creation-transaction')).toMatch(/does not prove who made the token/);
    expect(creatorFrom(null)).toBeNull();
  });
});

describe('the Solana blocks, drawn', () => {
  const render = (v: SolanaView) =>
    renderToStaticMarkup(createElement(SolanaFacts, { view: v, index: '03' }));
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it.each(['pump-creator-sold', 'meteora-dbc', 'pyusd'])(
    '%s: links to the Solana Explorer, keeps the case, and says nothing that judges',
    (slug) => {
      const { report, view: v } = view(slug);
      const html = render(v);
      expect(html).toContain('https://explorer.solana.com/address/');
      expect(html).not.toMatch(/blockscout|robinhood/i);
      if (report.creator.data.creator) {
        expect(html).toContain(
          `https://explorer.solana.com/address/${report.creator.data.creator}`,
        );
      }
      expect(findViolations(text(html))).toEqual([]);
    },
  );

  it('says a partial read leaves the creator’s sale unknown', () => {
    const html = render(view('meteora-dbc').view);
    expect(text(html)).toMatch(/Sold not read/);
  });

  it('says a token with no pool has no pool liquidity, not that a read failed', () => {
    const html = text(render(view('pump-creator-sold').view));
    expect(html).toMatch(/No trading pool was found for this token/);
    expect(html).not.toMatch(/pools could not be read/);
  });

  it('links each creation to its transaction', () => {
    const { report, view: v } = view('pump-creator-sold');
    expect(render(v)).toContain(
      `https://explorer.solana.com/tx/${report.launch.data.creation!.signature}`,
    );
  });
});
