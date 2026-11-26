import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FactsBoard, wholeParts } from '../../src/app/components/FactsBoard';
import { SolanaFacts } from '../../src/app/components/SolanaFacts';
import { toSolanaView } from '../../src/app/components/solana-view';
import { toFacts } from '../../src/lib/facts';
import { shortAnswer } from '../../src/lib/specialists/plain';
import type { SpecialistAnswer } from '../../src/lib/specialists/brief';
import { CREATOR, HOLDER, solanaReport } from '../helpers/solana-report';

/** Text of the markup, tags dropped. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&#x27;|&#39;/g, "'");

describe('shares that add up', () => {
  it('rounds to tenths that sum to the whole (POPCAT read 18 + 23 + 60 = 101 %)', () => {
    const parts = wholeParts([0.1756, 0.2254, 0.599]);
    expect(parts.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    expect(parts).toEqual([0.176, 0.225, 0.599]);
  });
});

describe('the creator panels', () => {
  const base = solanaReport();
  const onToken = base.creatorOnToken!;

  it('measures the creator’s moves against what was minted, not today’s supply (GIGA, 104 %)', () => {
    const report = solanaReport({
      creatorOnToken: {
        ...onToken,
        data: {
          ...onToken.data,
          received: '1000000000000000',
          holdsNow: '0',
          // 1e15 minted, 9.6e14 today.
          supply: '960000000000000',
          shareBase: '1000000000000000',
        },
      },
    });
    const view = toSolanaView(report);
    expect(view.onToken?.data.received).toBe(1);
    const html = text(renderToStaticMarkup(createElement(SolanaFacts, { view, index: '03' })));
    expect(html).toContain('Received 100%');
    expect(html).not.toMatch(/104/);
  });

  it('says a minor sale as a fact, without "0.00%"', () => {
    const report = solanaReport({
      creatorOnToken: {
        ...onToken,
        data: { ...onToken.data, sold: '19000000', saleSize: 'minor' },
      },
    });
    const view = toSolanaView(report);
    expect(view.onToken?.data.saleSize).toBe('minor');
    const html = text(renderToStaticMarkup(createElement(SolanaFacts, { view, index: '03' })));
    expect(html).toContain('A minor sale');
    expect(html).not.toContain('0.00%');
  });

  it('names the address the curve gives when another one signed the creation', () => {
    const report = solanaReport({
      creator: {
        ...base.creator,
        data: {
          ...base.creator.data,
          named: { address: HOLDER, from: 'pump-curve', signerShare: 0.2 },
        },
      },
    });
    const view = toSolanaView(report);
    expect(view.creator.data.named).toBe(HOLDER);
    const html = text(
      renderToStaticMarkup(
        createElement(FactsBoard, { facts: toFacts(report), solana: view, index: '02' }),
      ),
    );
    expect(html).toMatch(
      /The pump\.fun curve names \S+ as creator, but that address neither signed/,
    );
    expect(CREATOR).not.toBe(HOLDER);
  });
});

describe('the ten checks, one line each', () => {
  const answer = (measures: SpecialistAnswer['measures']): SpecialistAnswer =>
    ({
      specialist: 'creator-history',
      title: '',
      question: '',
      signal: 'observation',
      facts: [],
      limits: [],
      measures,
    }) as unknown as SpecialistAnswer;

  it('never prints "0.00%" for a dust sale, and a minor sale is not the line', () => {
    expect(
      shortAnswer(
        answer({ creator: { bought: null, sold: 0.000019, hasSold: true, holdsNow: 0 } }),
      ),
    ).toBe('The creator sold <0.01% of the supply');
    expect(
      shortAnswer(
        answer({
          creator: { bought: null, sold: 0.000019, hasSold: true, holdsNow: 0, minorSale: true },
        }),
      ),
    ).toBe('The creator sold only a few tokens of it');
  });
});
