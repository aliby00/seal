import { describe, expect, it } from 'vitest';
import { flagLine, flagsOf, withLive, type FlagInputs } from '../../src/lib/flags';
import { findViolations } from '../../src/lib/agent/guardrails';
import { flagInputsOf } from '../../src/lib/agent/trader-text';
import { liveFacts, liveValues } from '../../src/app/components/live-merge';
import { toFacts } from '../../src/lib/facts';
import { solanaReport } from '../helpers/solana-report';

/** A token as SEAL reads it, nothing notable: each test sets what it is about. */
function inputs(over: Partial<FlagInputs> = {}): FlagInputs {
  return {
    launchpad: 'pump.fun',
    livePowers: [],
    mintFreezeOff: true,
    dev: null,
    bundle: null,
    snipers: null,
    noBundle: false,
    serial: null,
    noOtherLaunch: false,
    market: {
      mcap: 80_000,
      liquidity: 18_700,
      onCurve: false,
      ratio: 0.24,
      volume24h: 40_000,
      quietHours: null,
    },
    holders: null,
    lp: { gone: 1, burned: true, withdrawable: 0 },
    linkedBought: null,
    nameClone: null,
    freshWallet: null,
    ...over,
  };
}

const dev = (over: Partial<NonNullable<FlagInputs['dev']>>): NonNullable<FlagInputs['dev']> => ({
  got: 0.215,
  verb: 'bought',
  sold: 0,
  hasSold: false,
  minorSale: false,
  holds: 0.215,
  within: null,
  locked: null,
  lockProgram: null,
  unlocks: null,
  provided: null,
  complete: true,
  ...over,
});

const lines = (i: FlagInputs) => flagsOf(i).map((f) => `${f.tone} ${flagLine(f)}`);

describe('the flags', () => {
  it('a dev who sold its whole bag is red, in trader words', () => {
    expect(
      lines(
        inputs({ dev: dev({ sold: 0.215, hasSold: true, holds: 0, within: 'within 4 minutes' }) }),
      )[0],
    ).toBe('red Dev sold everything: bought 21.5%, sold it all within 4 minutes');
  });

  it('a dev who holds none, its sales not all read, is out (100x: 53.3% bought, 0.92% sales read)', () => {
    expect(
      lines(
        inputs({
          dev: dev({ got: 0.533, sold: 0.0092, hasSold: true, holds: 0, complete: false }),
        }),
      )[0],
    ).toBe('red Dev out: bought 53.3%, holds 0% now');
  });

  it('a dust sale flags nothing', () => {
    const out = lines(
      inputs({
        dev: dev({ got: 0.00002, sold: 0.000001, hasSold: true, minorSale: true, holds: 0 }),
      }),
    );
    expect(out.join(' ')).not.toMatch(/Dev sold|Dev out/);
  });

  it.each([
    [0.419, 'red'],
    [0.12, 'orange'],
    [0.03, null],
  ])('a bundle of %s is %s', (share, tone) => {
    const flag = flagsOf(
      inputs({ bundle: { wallets: 3, share, heldNow: 0, where: 'creation slot' } }),
    ).find((f) => f.id === 'bundle');
    expect(flag?.tone ?? null).toBe(tone);
  });

  it('a bundle still holding is red whatever it got', () => {
    const flag = flagsOf(
      inputs({ bundle: { wallets: 4, share: 0.08, heldNow: 0.06, where: 'creation slot' } }),
    ).find((f) => f.id === 'bundle');
    expect(flag?.tone).toBe('red');
    expect(flag?.text).toContain('6% still held');
  });

  it('a serial launcher with most launches dead is orange, red past a hundred', () => {
    const serial = (others: number) =>
      flagsOf(
        inputs({ serial: { others, atLeast: true, checked: 10, dead: 9, deadUnderUsd: 5000 } }),
      ).find((f) => f.id === 'serial');
    expect(serial(1382)?.tone).toBe('red');
    expect(serial(1382)?.text).toBe('1,383+ tokens launched · 90% of those checked dead');
    expect(serial(18)?.tone).toBe('orange');
  });

  it('a dead chart, thin liquidity and live powers are red', () => {
    const out = lines(
      inputs({
        livePowers: ['freeze holders'],
        market: {
          mcap: 2000,
          liquidity: 12,
          onCurve: true,
          ratio: 0.006,
          volume24h: 38_500,
          quietHours: null,
        },
      }),
    );
    expect(out).toContain('red Live mint powers: someone can still freeze holders');
    expect(out).toContain('red Chart dead: mcap $2.0k after $38.5k traded in 24 h');
    const thin = lines(
      inputs({
        market: {
          mcap: 2_200_000,
          liquidity: 16_200,
          onCurve: false,
          ratio: 0.0075,
          volume24h: 11_900,
          quietHours: null,
        },
      }),
    );
    expect(thin[0]).toBe('red Thin liquidity: $16.2k under a $2.2M mcap (0.75%)');
  });

  it('near-equal bags across the top 10 are a cluster (PCB: 2.2% to 2.4% each)', () => {
    const out = lines(
      inputs({
        holders: {
          top10: 0.228,
          top1: 0.024,
          top1Name: null,
          holders: 55,
          floor: false,
          equalBags: { min: 0.022, max: 0.024 },
        },
      }),
    );
    expect(out[0]).toBe('red Cluster: top 10 hold 2.2%–2.4% each, 22.8% together');
  });

  it('a blue chip is not painted red: POPCAT as read on 26/11/2026', () => {
    const out = flagsOf(
      inputs({
        dev: dev({ got: 0.00002, sold: 0, hasSold: false, holds: 0 }),
        market: {
          mcap: 26_800_000,
          liquidity: 2_300_000,
          onCurve: false,
          ratio: 0.085,
          volume24h: 608_000,
          quietHours: null,
        },
        holders: {
          top10: 0.384,
          top1: 0.168,
          top1Name: null,
          holders: null,
          floor: true,
          equalBags: null,
        },
      }),
    );
    expect(out.filter((f) => f.tone === 'red')).toEqual([]);
    expect(out.at(-1)).toMatchObject({
      tone: 'green',
      label: 'LP burned · dev has not sold · liquidity 8.5% of mcap · mint and freeze revoked',
    });
  });

  it('red first, then orange, at most five, the greens on one line', () => {
    const out = flagsOf(
      inputs({
        dev: dev({ sold: 0.215, hasSold: true, holds: 0 }),
        bundle: { wallets: 7, share: 0.12, heldNow: 0, where: 'creation slot' },
        snipers: { wallets: 9, share: 0.6, heldNow: 0, seconds: 4, afterOpen: false },
        serial: { others: 40, atLeast: true, checked: 6, dead: 6, deadUnderUsd: 5000 },
        nameClone: 'Its name copies a well-known token',
        freshWallet: 'first funded 3 minutes before launch',
        market: {
          mcap: 2000,
          liquidity: 12,
          onCurve: true,
          ratio: 0.006,
          volume24h: 38_500,
          quietHours: 2,
        },
      }),
    );
    const tones = out.map((f) => f.tone);
    expect(tones.filter((t) => t !== 'green')).toHaveLength(5);
    expect(tones).toEqual(
      [...tones].sort(
        (a, b) => ['red', 'orange', 'green'].indexOf(a) - ['red', 'orange', 'green'].indexOf(b),
      ),
    );
    expect(tones.filter((t) => t === 'green')).toHaveLength(1);
  });

  it('every flag passes the guardrails: blunt about a fact, never a verdict on the token', () => {
    const all = flagsOf(
      inputs({
        livePowers: ['mint more', 'freeze holders'],
        dev: dev({ sold: 0.215, hasSold: true, holds: 0, locked: 0.1, lockProgram: 'Streamflow' }),
        bundle: { wallets: 3, share: 0.419, heldNow: 0, where: 'creation slot' },
        snipers: { wallets: 7, share: 0.438, heldNow: 0, seconds: 1, afterOpen: false },
        serial: { others: 1382, atLeast: true, checked: 10, dead: 10, deadUnderUsd: 5000 },
        market: {
          mcap: 2000,
          liquidity: 12,
          onCurve: true,
          ratio: 0.006,
          volume24h: 38_500,
          quietHours: 3,
        },
      }),
    );
    for (const f of all) expect(findViolations(flagLine(f))).toEqual([]);
  });

  it('the live market draws the flags again with the same rules', () => {
    const base = inputs();
    expect(flagsOf(base).some((f) => f.id === 'liquidity')).toBe(false);
    const thin = withLive(base, { liquidity: 3_000, ratio: 0.0375, mcap: 80_000 });
    expect(flagsOf(thin).find((f) => f.id === 'liquidity')?.tone).toBe('red');
  });
});

describe('flag inputs from a report, and live values over the facts', () => {
  it('works out the inputs from the collected report', () => {
    const report = solanaReport();
    const i = flagInputsOf(report);
    expect(i.launchpad).toBe('pump.fun');
    expect(i.market.mcap).not.toBeNull();
  });

  it('lays the live market over the facts, keeping what it does not give', () => {
    const facts = toFacts(solanaReport());
    const live = {
      token: 'x',
      at: '2026-11-26T14:00:00.000Z',
      priceUsd: 0.0001,
      marketCapUsd: 99_000,
      fdvUsd: 99_000,
      liquidityUsd: null,
      liquidityToMarketCap: null,
      volume24hUsd: 5_000,
      buys24h: 10,
      sells24h: 5,
      perTradeUsd24h: 333.33,
    };
    const merged = liveFacts(facts, live, null);
    expect(merged.market.marketCapUsd).toBe(99_000);
    expect(merged.market.liquidityUsd).toBe(facts.market.liquidityUsd);
    expect(liveValues(live, null)).toEqual({ mcap: 99_000, volume24h: 5_000 });
  });
});
