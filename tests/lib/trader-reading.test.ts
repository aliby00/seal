import { describe, expect, it } from 'vitest';
import { traderReading } from '../../src/lib/agent/trader-text';
import { offlineExplanation } from '../../src/lib/agent/offline';
import {
  findClaims,
  quantities,
  unsupportedNumber,
  withoutClaims,
} from '../../src/lib/agent/claims';
import { renderReport } from '../../src/lib/agent/prompt';
import { ageWords, figuresOf, share } from '../../src/lib/figures';
import { toFacts, type TimelineLaunch } from '../../src/lib/facts';
import { timelinePositions } from '../../src/app/components/timeline';
import { PAIR_HINT, addressHint, tokenFromInput } from '../../src/app/components/analyze-request';
import { buildGlance } from '../../src/lib/glance';
import { solanaReport } from '../helpers/solana-report';

const MINT = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
const base = solanaReport();

function move(kind: 'buy' | 'sell', blockTime: number) {
  return {
    signature: 'x',
    slot: 1,
    blockTime,
    kind,
    amount: '18000000000000',
    share: 0.018,
    sol: '0',
    otherTokens: [],
    counterparties: [],
  };
}

/** fair 3C1f…pump as production read it on 26/11/2026: the dev bought and sold within minutes, a bundle took 41.9%. */
const fair = solanaReport({
  creatorOnToken: base.creatorOnToken && {
    ...base.creatorOnToken,
    data: {
      ...base.creatorOnToken.data,
      bought: '18000000000000',
      sold: '18000000000000',
      solSpent: '1290000000',
      holdsNow: '0',
      saleSize: 'material',
      moves: [move('buy', 1795552482), move('sell', 1795552482 + 235)],
    },
  },
  launch: {
    ...base.launch,
    data: {
      ...base.launch.data,
      sameSlot: {
        wallets: 3,
        share: 0.419,
        transactions: 3,
        heldNow: 0,
        unread: 0,
        soldInWindow: 3,
        solSpent: 20,
        addresses: [],
      },
    },
  },
});

describe('the trader reading', () => {
  it('leads with what the dev did, in trader words, and never with the mint authorities', () => {
    const reading = traderReading(fair);
    const all = reading.standsOut.map((l) => l.text).join(' ');
    expect(all).toContain(
      'The dev bought 1.8% of the supply for 1.29 SOL, then sold all of it within 4 minutes',
    );
    expect(all).toContain(
      'Bundled launch: 3 wallets other than the dev took 41.9% of the supply in the creation slot',
    );
    expect(offlineExplanation(fair)).not.toMatch(/mint authority|freeze authority|revoked/i);
  });

  it('never calls a launchpad token clean for what every launchpad token has', () => {
    // pump.fun: the mint and freeze authorities are off by design.
    expect(traderReading(base).clean.join(' ')).not.toMatch(/mint more|freeze/);
  });
});

describe('the figures row', () => {
  it('shows only what was measured, never a dash', () => {
    const figures = figuresOf({ facts: toFacts(base), collectedAt: '2026-11-25T03:00:00.000Z' });
    for (const f of figures) expect(f.value).not.toMatch(/^—$|undefined|NaN/);
    expect(figures.map((f) => f.id)).toContain('mcap');
  });

  it('one rule for shares', () => {
    expect(share(0)).toBe('0%');
    expect(share(1)).toBe('100%');
    expect(share(0.419)).toBe('41.9%');
    expect(share(0.0092)).toBe('0.92%');
    expect(share(0.00001)).toBe('<0.01%');
  });

  it('says the age plainly', () => {
    expect(ageWords(42 * 60_000)).toBe('42 min');
    expect(ageWords(5 * 3_600_000)).toBe('5 h');
    expect(ageWords(3 * 86_400_000)).toBe('3 days');
  });
});

describe('the In short line on a dust sale', () => {
  it('a minor sale never leads with a warning or a 0.00%', () => {
    const facts = toFacts(base);
    const glance = buildGlance({
      facts: { ...facts, creator: { ...facts.creator, saleSize: 'minor' } },
      specialists: [
        {
          specialist: 'creator-history',
          title: 'Creator History',
          question: '?',
          signal: 'observation',
          facts: [],
          limits: [],
          measures: { creator: { bought: 0, sold: 0.0000002, hasSold: true, holdsNow: 0 } },
        },
      ],
    });
    const sales = glance?.items.find((i) => i.id === 'sales');
    expect(sales?.tone).toBe('neutral');
    expect(sales?.figure).toBeUndefined();
    expect(sales?.title).not.toMatch(/0\.00%/);
  });
});

describe('the model text, checked against what it was given', () => {
  const source = renderReport(fair);

  it('reads every percentage, dollar and SOL amount', () => {
    expect(quantities('41.9% and $2.1k, 1.29 SOL, 1,382 launches').map((q) => q.unit)).toEqual([
      '%',
      '$',
      'SOL',
    ]);
  });

  it('cuts a number that nothing it was given supports', () => {
    expect(unsupportedNumber('The top 10 hold 96.1% of the supply.', source)).toBe(true);
    expect(unsupportedNumber('A bundle took 41.9% of the supply.', source)).toBe(false);
    expect(unsupportedNumber('A bundle took 42% of the supply.', source)).toBe(false);
  });

  it('cuts the pipeline talking about itself', () => {
    const kinds = findClaims(
      'These reads do not agree. I cannot reconcile them from this data. The dev sold.',
      fair,
    ).map((c) => c.kind);
    expect(kinds).toEqual(['internal', 'internal']);
  });

  it('keeps the new headings and what is under them', () => {
    const text =
      'What stands out\n\nThe dev bought 1.8% of the supply, then sold all of it.\n\nWhat is clean\n\nNothing beyond what every launchpad token has.';
    expect(withoutClaims(text, fair, source).text).toBe(text);
  });
});

describe('the creator timeline', () => {
  const at = (iso: string | null, current = false): TimelineLaunch => ({
    address: `${iso}${current}`,
    launchedAt: iso,
    block: 0,
    outcome: 'undetermined',
    progress: 0,
    sold: null,
    pulled: null,
    current,
  });

  it('places launches by time, inside the track, the token read included (CAT, block 0)', () => {
    const marks = timelinePositions([
      at('2026-11-24T00:00:00Z'),
      at('2026-11-25T00:00:00Z'),
      at(null),
      at('2026-11-26T00:00:00Z', true),
    ]);
    expect(marks.map((m) => m.x)).toEqual([2, 50, 98]);
    expect(marks.at(-1)!.launch.current).toBe(true);
  });

  it('draws nothing with fewer than two dated launches', () => {
    expect(timelinePositions([at(null), at('2026-11-26T00:00:00Z', true)])).toEqual([]);
  });
});

describe('a pasted link', () => {
  it.each([
    `https://pump.fun/coin/${MINT}`,
    `pump.fun/coin/${MINT}?include-nsfw=true`,
    `https://solscan.io/token/${MINT}`,
    `https://birdeye.so/token/${MINT}?chain=solana`,
    `https://gmgn.ai/sol/token/abc123_${MINT}`,
    `https://explorer.solana.com/address/${MINT}`,
    ` ${MINT} `,
  ])('gives the token address it carries: %s', (value) => {
    expect(tokenFromInput(value)).toBe(MINT);
  });

  it('a DexScreener link names a pair, and the field says so', () => {
    const link = `https://dexscreener.com/solana/${MINT}`;
    expect(tokenFromInput(link)).toBe(link);
    expect(addressHint(link)).toBe(PAIR_HINT);
  });
});

describe('the closing line on what was not read', () => {
  it('is SEAL’s own, and only for a read that failed', async () => {
    const { withNotRead } = await import('../../src/lib/agent/trader-text');
    const model =
      'What stands out\n\nThe dev sold.\n\nNot read this time: the creator’s first funding.';
    expect(withNotRead(model, base)).toBe('What stands out\n\nThe dev sold.');
    const failed = solanaReport({ failedReads: [{ read: 'holders', note: 'rate-limit' }] });
    expect(withNotRead(model, failed)).toBe(
      'What stands out\n\nThe dev sold.\n\nNot read this time: who holds it. Try again in a minute.',
    );
  });
});
