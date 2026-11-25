import { describe, expect, it } from 'vitest';
import { renderReport } from '../../src/lib/agent/prompt';
import { solanaReport } from '../helpers/solana-report';

/**
 * What the model is told of the market: where each figure was read, so it
 * never says of the whole token what was read on one pair.
 */

const base = solanaReport();
const withMarket = (data: Partial<typeof base.market.data>) =>
  solanaReport({ market: { ...base.market, data: { ...base.market.data, ...data } } });

describe('the market block of the model input', () => {
  it('says the counts are the main pair’s when only it was read', () => {
    const text = renderReport(base);
    expect(text).toContain('Volume and trades below are the main pair’s only');
    expect(text).toContain('Trades on its main pair: 1 h 4 buys and 3 sells');
  });

  it('says how many pairs the counts add up, beside the main pair’s price', () => {
    // JUP, 25/11/2026: 28 pairs counted.
    const text = renderReport(
      withMarket({
        pairsCounted: 28,
        txns: { h1: { buys: 596, sells: 639 }, h24: { buys: 24_319, sells: 23_857 } },
      }),
    );
    expect(text).toContain('Volume and trades below are added up on 28 of its listed pairs');
    expect(text).toContain('Trades on 28 of its listed pairs: 1 h 596 buys and 639 sells');
    expect(text).toContain("FDV 41200 USD (the main pair's)");
  });

  it('says "no trade" of every listed pair', () => {
    const text = renderReport(withMarket({ quiet: { hours: 1 } }));
    expect(text).toContain('No trade on any pair DexScreener lists for the token for at least 1 h');
  });
});
