import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  creatorFrom,
  outcomeWord,
  pct,
  powerTitle,
  sol,
  SolanaFacts,
  sortedPowers,
  tokens,
} from '../../src/app/components/SolanaFacts';
import { FactsBoard, launchesComplete } from '../../src/app/components/FactsBoard';
import { LaunchReplay } from '../../src/app/components/LaunchReplay';
import { launchView, toFacts } from '../../src/lib/facts';
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
    // A move that happened is never 0 %.
    expect(shareOf('3', '725520000000000')).toBe(0.000001);
    // Above 2^53: BigInt keeps it right.
    expect(shareOf('3906250000000000000', '7812500000000000000')).toBe(0.5);
  });

  it('turns lamports into SOL', () => {
    expect(solOf('1500000000')).toBe(1.5);
    expect(solOf(null)).toBeNull();
  });

  it('says dust as dust, never in exponent notation', () => {
    expect(sol(solOf('100'))).toBe('<0.001 SOL');
    expect(sol(0.0123)).toBe('0.012 SOL');
    expect(sol(5.626514133)).toBe('5.63 SOL');
  });

  it('formats shares, whole tokens and SOL plainly', () => {
    expect(pct(null)).toBe('not read');
    expect(pct(0)).toBe('0%');
    expect(pct(0.0004)).toBe('<0.1%');
    expect(pct(0.119065)).toBe('12%');
    expect(pct(0.05)).toBe('5.0%');
    // 99.79 % is not the whole supply, and must not read "100%" next to "the other 0.2%".
    expect(pct(0.997896)).toBe('99.8%');
    expect(pct(0.9996)).toBe('>99.9%');
    expect(pct(1)).toBe('100%');
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
    expect(html).toMatch(
      /DexScreener lists no trading pool for this token other than its launch curve: there is no pool liquidity to read/,
    );
    expect(html).not.toMatch(/pools could not be read|could not be listed/);
  });

  it('links each creation to its transaction', () => {
    const { report, view: v } = view('pump-creator-sold');
    expect(render(v)).toContain(
      `https://explorer.solana.com/tx/${report.launch.data.creation!.signature}`,
    );
  });
});

describe('what the screen must not claim', () => {
  const render = (v: SolanaView) =>
    renderToStaticMarkup(createElement(SolanaFacts, { view: v, index: '03' }));
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const at = '2026-11-25T00:00:00.000Z';

  it('does not say a token has no pool when the market read itself failed', () => {
    const base = solanaReport();
    const v = toSolanaView({
      ...base,
      market: {
        ...base.market,
        completeness: 'unavailable',
        sources: [{ name: 'dexscreener-solana', fetchedAt: at, note: 'rate-limit : 429' }],
      },
      failedReads: [{ read: 'market', note: 'rate-limit : 429' }],
    });
    const html = text(render(v));
    expect(html).not.toMatch(/no trading pool|no pool liquidity/i);
    expect(html).toMatch(/pools could not be listed: the market read failed this time/);
  });

  it('says what a launch group holds today only for the wallets read', () => {
    const base = solanaReport();
    const group = {
      wallets: 5,
      share: 0.2,
      transactions: 5,
      heldNow: 0.03,
      unread: 2,
      soldInWindow: 0,
      solSpent: 1,
      addresses: [],
    };
    const v = toSolanaView({
      ...base,
      launch: { ...base.launch, data: { ...base.launch.data, sameSlot: group } },
    });
    expect(v.launch.data.sameSlot?.unread).toBe(2);
    const html = text(render(v));
    expect(html).toMatch(/today 3\.0% is held by the 3 of them read \(2 not read\)/);
    expect(html).not.toMatch(/they hold 3\.0% today/);
  });

  it('says the other tokens are from what could be read when the history was read in part', () => {
    const base = solanaReport();
    const v = toSolanaView({
      ...base,
      creatorHistory: {
        ...base.creatorHistory!,
        completeness: 'partial',
        sources: [
          {
            name: 'solana-rpc',
            fetchedAt: at,
            note: "12 of the creator's 13 transactions listed were read for launches outside pump.fun",
          },
        ],
      },
    });
    expect(text(render(v))).toMatch(/0 other tokens found, from what could be read/);
    // The creator card says the same: its launch count is a floor.
    expect(launchesComplete(toFacts(base).creator, v)).toBe(false);
    expect(launchesComplete(toFacts(base).creator, toSolanaView(base))).toBe(true);
  });

  it('draws no launch count when nothing names a creator', () => {
    const base = solanaReport();
    const report = {
      ...base,
      creator: { ...base.creator, data: { ...base.creator.data, creator: null, from: null } },
      creatorHistory: null,
      creatorOnToken: null,
      linkedWallets: null,
    };
    const html = text(
      renderToStaticMarkup(
        createElement(FactsBoard, { facts: toFacts(report), solana: toSolanaView(report) }),
      ),
    );
    expect(html).toMatch(/Nothing on the chain names a creator for this token/);
    expect(html).not.toMatch(/tokens? launched, this one included/);
  });
});

describe('the measured cards, on recorded reports', () => {
  const board = (slug: string) => {
    const { report } = loadCollectRecording(slug);
    const html = renderToStaticMarkup(
      createElement(FactsBoard, { facts: toFacts(report), solana: toSolanaView(report) }),
    );
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  };

  it('PYUSD: no holders list was read, so no concentration is drawn', () => {
    const html = board('pyusd');
    expect(html).toMatch(/Not measured/);
    expect(html).not.toMatch(/Largest holder|Concentration: largest/);
    expect(html).toMatch(/the chain node used does not list the largest ones/);
    expect(html).not.toMatch(/upstream|getTokenLargestAccounts/);
  });

  it('PYUSD: says the creator is the metadata authority, which proves nothing', () => {
    expect(board('pyusd')).toMatch(
      /Can edit the token’s name and symbol\. Often a team or a service/,
    );
  });

  it('pump.fun on its curve: the curve’s 99.8 % is not rounded to the whole supply', () => {
    const html = board('pump-creator-sold');
    expect(html).toMatch(/99\.8% of the supply sits in its bonding curve/);
    expect(html).toMatch(/NYqu…Qnb2 , its launch curve/);
  });
});

describe('the launch replay, when no other wallet bought', () => {
  const replay = (partial: boolean) => {
    const { report } = loadCollectRecording('pump-creator-sold');
    const launch = launchView(report.launch)!;
    // Only the creator's own moves: no other buyer in what is drawn.
    const own = { ...launch, moves: launch.moves.filter((m) => m.actorIsCreator) };
    const { summary: _summary, ...withoutSummary } = own;
    void _summary;
    const html = renderToStaticMarkup(
      createElement(LaunchReplay, { launch: withoutSummary, index: '04', partial }),
    );
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  };

  it('says none bought only when the whole window was read, and for that window', () => {
    expect(replay(false)).toMatch(/0 wallets bought in these first/);
    expect(replay(false)).not.toMatch(/first minute /);
  });

  it('leaves it unknown when the replay was read in part', () => {
    expect(replay(true)).toMatch(/the window was not read in full/);
    expect(replay(true)).not.toMatch(/0 wallets bought/);
  });
});

describe('names chosen on chain, on the Solana blocks', () => {
  const render = (v: SolanaView) =>
    renderToStaticMarkup(createElement(SolanaFacts, { view: v, index: '03' }));
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const base = solanaReport();
  const launched = (mint: string, name: string, symbol: string) => ({
    mint,
    launchpad: 'pump.fun',
    name,
    symbol,
    signature: null,
    slot: null,
    launchedAt: null,
    curve: null,
    outcome: 'dead' as const,
    trades24h: 0,
    foundBy: ['pump-curves' as const],
  });
  const QUOTE = '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw';
  // A name a creator can choose: it reads as a verdict, or hides behind a right-to-left override.
  const report = solanaReport({
    mint: {
      ...base.mint,
      data: {
        ...base.mint.data!,
        metadata: { ...base.mint.data!.metadata!, name: 'SAFE 100X', symbol: 'RUG PULL' },
      },
    },
    creatorHistory: {
      ...base.creatorHistory!,
      data: {
        ...base.creatorHistory!.data,
        tokens: [
          launched('8wUEF4ewdQfhZRFY1D4e4MhdMcaHHNhA2Yt8cFxJYhYa', 'Legit Moon', 'SAFE'),
          launched('GZHYAsikiCAAeMzJ6wX2oUx8Z9eh78wKUA9WyabB53tB', '\u202ePUJ', 'J\u200bUP'),
        ],
      },
    },
    market: {
      ...base.market,
      data: { ...base.market.data, pairedWith: { address: QUOTE, symbol: 'SCAM' } },
    },
  });

  it('withholds a name or symbol that reads as a verdict, as the header does', () => {
    const v = toSolanaView(report);
    expect(v.mint.data?.metadata).toMatchObject({ name: null, symbol: null, withheld: true });
    expect(v.history?.data.tokens[0]).toMatchObject({ name: null, symbol: null });
    // Invisible and bidi characters are taken out, the rest kept.
    expect(v.history?.data.tokens[1]).toMatchObject({ name: 'PUJ', symbol: 'J UP' });
    // A pair's symbol withheld: the quote token is named by its address.
    expect(v.market.data.pairedWith).toBe('9AhK…sbkw');

    const html = text(render(v));
    expect(findViolations(html)).toEqual([]);
    expect(html).not.toMatch(/[\u200b-\u200f\u202a-\u202e]/);
    expect(html).toMatch(/reads as a verdict or advice/);
  });

  it('keeps a plain name as it is', () => {
    const v = toSolanaView(base);
    const meta = base.mint.data!.metadata!;
    expect(v.mint.data?.metadata).toMatchObject({
      name: meta.name,
      symbol: meta.symbol,
      withheld: false,
    });
    expect(v.market.data.pairedWith).toBe('SOL');
  });
});
