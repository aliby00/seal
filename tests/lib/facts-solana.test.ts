import { describe, expect, it } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { toFacts, toTimeline } from '../../src/lib/facts';
import { MINT, solanaReport } from '../helpers/solana-report';

/** The base report with what the creator did with the token replaced. */
function withOnToken(
  completeness: 'full' | 'partial' | 'unavailable',
  sold: string,
  listed = 16,
  read = 16,
): TokenReport {
  const base = solanaReport();
  const onToken = base.creatorOnToken!;
  return solanaReport({
    creatorOnToken: {
      ...onToken,
      completeness,
      data: { ...onToken.data, sold, transactions: { listed, read } },
    },
  });
}

const current = (report: TokenReport) => toTimeline(report).find((t) => t.current)!;

describe('the creator selling this token, from the Solana report', () => {
  it('is a sale when a sale was read, even in a partial read', () => {
    const report = withOnToken('partial', '1000', 16, 2);
    expect(toFacts(report).creator.soldIntoPool).toBe(1);
    expect(current(report).sold).toBe(true);
  });

  it('is "no sale" only when every move of the creator was read', () => {
    const report = withOnToken('full', '0');
    expect(toFacts(report).creator.salesChecked).toBe(1);
    expect(toFacts(report).creator.soldIntoPool).toBe(0);
    expect(current(report).sold).toBe(false);
  });

  // Meteora DBC 8xKZ…, public node, 25/11/2026: 2 of the creator's 16
  // transactions were read, none a sale. That is not "the creator did not sell".
  it('stays unknown when a partial read saw no sale', () => {
    const report = withOnToken('partial', '0', 16, 2);
    const facts = toFacts(report);
    expect(facts.creator.salesChecked).toBe(0);
    expect(facts.creator.soldIntoPool).toBe(0);
    expect(facts.creator.ownSales).toBeUndefined();
    expect(current(report).sold).toBeNull();
  });

  it('stays unknown when the read failed', () => {
    const report = withOnToken('unavailable', '0', 0, 0);
    expect(toFacts(report).creator.salesChecked).toBe(0);
    expect(current(report).sold).toBeNull();
  });
});

describe('the graduation step, from the Solana report', () => {
  it('is not called "not applicable" when the launchpad could not be read', () => {
    const base = solanaReport();
    const report = solanaReport({
      launchpad: {
        completeness: 'unavailable',
        sources: [{ name: 'solana-rpc', fetchedAt: base.collectedAt, note: 'unexpected error' }],
        data: { mint: MINT, launchpad: null, account: null, foundBy: null },
      },
      graduation: null,
    });
    expect(toFacts(report).creator.graduation).toBe('not-measured');
  });

  it('is "not applicable" when the launchpad was read and there is none', () => {
    const base = solanaReport();
    const report = solanaReport({
      launchpad: { ...base.launchpad, data: { ...base.launchpad.data, launchpad: null } },
      graduation: null,
    });
    expect(toFacts(report).creator.graduation).toBe('not-applicable');
  });
});
