import { describe, expect, it } from 'vitest';
import type { LaunchReplayData } from '../../src/lib/contracts/launch';
import type { ReportFacts, TimelineLaunch } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';

const creator = '0x00000000000000000000000000000000000000c1';

function facts(overrides: Partial<ReportFacts['creator']> = {}): ReportFacts {
  return {
    creator: {
      measured: true,
      address: creator,
      launched: 4,
      detailed: 4,
      graduated: 0,
      abandoned: 0,
      undetermined: 0,
      active: 4,
      checked: 4,
      soldIntoPool: 4,
      liquidityPulled: 0,
      salesChecked: 4,
      liquidityChecked: 4,
      source: 'pons',
      role: null,
      launchContract: null,
      launchesListed: true,
      transactionCount: 16,
      ...overrides,
    },
    holders: {
      measured: true,
      holderCount: 3,
      pooled: null,
      top1: 0.7,
      top10: 1,
      top: [{ address: creator, share: 0.7, kind: 'wallet' }],
    },
    market: {
      measured: false,
      note: 'no pair indexed by DexScreener for this token',
      priceUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      buys24h: null,
      sells24h: null,
      fdvUsd: null,
      graduation: { progress: 0.0004, thresholdEth: 4.2, graduated: false },
    },
  };
}

const day = (d: number) => new Date(Date.UTC(2026, 8, 25 + d)).toISOString();
const timeline: TimelineLaunch[] = [0, 1, 2, 2].map((d, i) => ({
  address: `0x${String(i).padStart(40, '0')}`,
  launchedAt: day(d),
  block: i,
  outcome: 'active',
  progress: 0,
  sold: true,
  pulled: false,
  current: i === 2,
}));

describe('buildGlance', () => {
  it('leads with what deserves attention, said as a sentence', () => {
    const glance = buildGlance({ facts: facts(), timeline })!;
    expect(glance.headline).toBe('The creator sold into the pool on all 4 launches checked.');
    expect(glance.items[0]).toMatchObject({ id: 'sales', tone: 'attention', figure: '4/4' });
    // Four launches in three days is a pattern.
    expect(glance.items.find((i) => i.id === 'record')).toMatchObject({
      tone: 'attention',
      title: 'This creator launched 4 tokens in 2 days. None of the 4 read in detail graduated.',
    });
    expect(glance.items.length).toBeLessThanOrEqual(4);
  });

  it('says plainly when the creator never sold or pulled liquidity', () => {
    const glance = buildGlance({ facts: facts({ soldIntoPool: 0 }) })!;
    const sales = glance.items.find((i) => i.id === 'sales');
    expect(sales).toMatchObject({ tone: 'reassuring', figure: '0/4' });
    expect(sales?.title).toBe(
      'The creator did not sell into the pool on any of the 4 launches checked.',
    );
  });

  it('restates holder shares against the whole supply when most of it is pooled', () => {
    const f = facts();
    f.holders.pooled = 0.9994;
    const glance = buildGlance({ facts: f })!;
    expect(glance.items.find((i) => i.id === 'supply')?.title).toBe(
      '>99.9% of the supply is still in the launch pool: only <0.1% has reached wallets so far.',
    );
  });

  it('names the creator as the largest holder, outside the pool', () => {
    const f = facts();
    f.holders.pooled = 0.5;
    const supply = buildGlance({ facts: f })!.items.find((i) => i.id === 'supply');
    expect(supply?.title).toBe(
      'The creator holds 70% of the tokens held outside the pool (35% of the whole supply).',
    );
  });

  it('counts the wallets that bought in the launch block', () => {
    const move = (actor: string, share: number) => ({
      kind: 'buy' as const,
      seconds: 0,
      block: 0,
      actor,
      counterparty: '0xpool',
      actorKind: 'wallet' as const,
      share,
      actorIsCreator: false,
      counterpartyIsCreator: false,
      heldNow: 0,
      transaction: '0x1',
    });
    const launch: LaunchReplayData = {
      token: '0xt',
      launchBlock: 1,
      launchedAt: null,
      windowSeconds: 600,
      supply: '1',
      moves: [move('0xa', 0.04), move('0xb', 0.03), move('0xa', 0.01)],
      movesInWindow: 3,
    };
    const glance = buildGlance({ facts: facts({ salesChecked: 0, checked: 0 }), launch })!;
    expect(glance.items.find((i) => i.id === 'launch-buys')).toMatchObject({
      tone: 'attention',
      title: '2 wallets bought 8.0% of the supply in the very block the token was created.',
    });
    // Dust buys are left out; later ones say when.
    launch.moves = [{ ...launch.moves[0]!, share: 0.002 }];
    expect(
      buildGlance({ facts: facts(), launch })!.items.find((i) => i.id === 'launch-buys'),
    ).toBeUndefined();
    launch.moves = [{ ...launch.moves[0]!, share: 0.063, seconds: 14 }];
    expect(
      buildGlance({ facts: facts({ salesChecked: 0, checked: 0 }), launch })!.items.find(
        (i) => i.id === 'launch-buys',
      ),
    ).toMatchObject({
      title: '1 wallet bought 6.3% of the supply within 14 seconds of its launch.',
    });
  });

  it('counts the launch pool’s trades when no pair is listed', () => {
    const f = facts({ measured: false });
    f.holders.measured = false;
    f.market = {
      ...f.market,
      measured: true,
      note: 'no pair indexed by DexScreener for this token',
      buys24h: 30,
      sells24h: 12,
      poolActivity: {
        buys24h: 30,
        sells24h: 12,
        traders24h: 25,
        volume24hEth: 2.5,
        lastTradeAt: null,
        coveredFrom: null,
      },
    };
    const item = buildGlance({ facts: f })!.items.find((i) => i.id === 'market');
    expect(item).toMatchObject({
      tone: 'neutral',
      figure: '42',
      title: '30 buys and 12 sells by 25 wallets in the last 24 hours.',
    });
    // Without a trade in the day, the graduation line is the one shown.
    f.market.poolActivity = { ...f.market.poolActivity!, buys24h: 0, sells24h: 0, traders24h: 0 };
    expect(buildGlance({ facts: f })!.items.find((i) => i.id === 'market')?.title).toMatch(
      /needed to graduate/,
    );
  });

  it('lists what was not measured instead of hiding it', () => {
    expect(buildGlance({ facts: facts() })!.unseen).toEqual(['live trading on an open market']);
  });

  it('never scores the token', () => {
    const text = JSON.stringify(buildGlance({ facts: facts(), timeline }));
    expect(text).not.toMatch(/score|\/10\b|\/100\b|\bsafe\b|risky|scam|rug/i);
  });

  it('has nothing to say without facts', () => {
    expect(buildGlance({})).toBeNull();
  });
});

describe('graduation outside pons', () => {
  it('does not say none graduated where graduation was never read', () => {
    const glance = buildGlance({
      facts: facts({ source: 'deployer', graduation: 'not-measured', launchpad: 'flap.sh' }),
    });
    const record = glance?.items.find((i) => i.id === 'record');
    expect(record?.title).toMatch(/launched 4 tokens/);
    expect(record?.title).not.toMatch(/graduat/);
  });
});
