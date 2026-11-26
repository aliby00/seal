import { describe, expect, it } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { launchView, toFacts, toTimeline } from '../../src/lib/facts';
import { buildGlance, type Glance } from '../../src/lib/glance';
import { findViolations } from '../../src/lib/agent/guardrails';
import { answerAll } from '../../src/lib/specialists/brief';
import type { SolanaLaunchGroup } from '../../src/lib/solana/launch-types';
import type { TokenPower } from '../../src/lib/solana/token-types';
import {
  CREATOR_HOLDS_SHARE,
  DEAD_LAUNCHES_MIN,
  GROUP_SHARE,
} from '../../src/lib/specialists/thresholds';
import { CREATOR, HOLDER, solanaReport } from '../helpers/solana-report';

/**
 * "In short", built as the report page builds it: the facts, the creator's
 * launches, the launch replay and the ten questions' answers, all from one
 * Solana report.
 */
function glanceOf(report: TokenReport): Glance {
  const view = launchView(report.launch);
  return buildGlance({
    facts: toFacts(report),
    timeline: toTimeline(report),
    ...(view ? { launch: view } : {}),
    specialists: answerAll({ token: report.token, report, creator: report.creator.data.creator }),
  })!;
}

const base = solanaReport();
const SUPPLY = 1_000_000_000_000_000n;
/** A share of the supply, in raw units. */
const raw = (share: number) => ((SUPPLY * BigInt(Math.round(share * 1e6))) / 1_000_000n).toString();

const power = (p: Partial<TokenPower> & Pick<TokenPower, 'power' | 'status'>): TokenPower => ({
  holder: p.status === 'held' ? CREATOR : null,
  sentence: `${p.power} ${p.status}.`,
  from: 'mint',
  ...p,
});

/** The creator's moves on this token. */
function onToken(
  over: Partial<NonNullable<TokenReport['creatorOnToken']>['data']>,
  completeness: 'full' | 'partial' = 'full',
) {
  return {
    ...base.creatorOnToken!,
    completeness,
    data: { ...base.creatorOnToken!.data, ...over },
  };
}

const group = (wallets: number, share: number): SolanaLaunchGroup => ({
  wallets,
  share,
  transactions: wallets,
  heldNow: 0,
  unread: 0,
  soldInWindow: 0,
  solSpent: 1.5,
  addresses: [],
});

function withLaunch(over: Partial<TokenReport['launch']['data']>): TokenReport['launch'] {
  return { ...base.launch, data: { ...base.launch.data, ...over } };
}

describe('In short: what the mint still allows comes first', () => {
  it('leads with the powers someone holds over every holder', () => {
    const glance = glanceOf(
      solanaReport({
        powers: [
          power({ power: 'mint', status: 'none' }),
          power({ power: 'freeze', status: 'held' }),
          power({ power: 'permanent-delegate', status: 'held', from: 'permanentDelegate' }),
        ],
      }),
    );
    expect(glance.items[0]).toMatchObject({
      id: 'powers',
      tone: 'attention',
      title:
        'The creator can still freeze any holder’s tokens and take or burn any holder’s tokens.',
      href: '#question-token-powers',
    });
    expect(glance.headline).toBe(glance.items[0]!.title);
  });

  it('says "someone" when another address than the creator holds a power', () => {
    const glance = glanceOf(
      solanaReport({ powers: [power({ power: 'mint', status: 'held', holder: HOLDER })] }),
    );
    expect(glance.items[0]?.title).toBe('Someone can still create new tokens.');
  });

  it('states the rules in force on every transfer before what someone can change', () => {
    const glance = glanceOf(
      solanaReport({
        powers: [
          power({
            power: 'transfer-fee',
            status: 'fixed',
            sentence:
              'Every transfer pays a 5% fee; no one can collect it (no withdraw authority).',
            from: 'transferFeeConfig',
          }),
          power({ power: 'transfer-fee-change', status: 'held', from: 'transferFeeConfig' }),
        ],
      }),
    );
    expect(glance.items[0]).toMatchObject({
      id: 'powers',
      tone: 'attention',
      title: 'Every transfer pays a 5% fee. The creator can still change the transfer fee.',
      href: '#question-transfer-rules',
    });
  });

  it('tells a transfer program running today from one someone could add', () => {
    const hooked = (programId: string | null) =>
      glanceOf(
        solanaReport({
          mint: {
            ...base.mint,
            data: {
              ...base.mint.data!,
              extensions: [{ extension: 'transferHook', state: { authority: CREATOR, programId } }],
            },
          },
          powers: [power({ power: 'transfer-hook', status: 'held', from: 'transferHook' })],
        }),
      ).items[0]?.title;
    expect(hooked(HOLDER)).toBe(
      'Every transfer runs a program that can refuse it. The creator can still change the program transfers run.',
    );
    expect(hooked(null)).toBe('The creator can still add a program that can refuse transfers.');
  });

  it('says plainly when nobody can mint, freeze or act on transfers', () => {
    const glance = glanceOf(
      solanaReport({
        powers: [
          power({ power: 'mint', status: 'none' }),
          power({ power: 'freeze', status: 'none' }),
        ],
        holders: { ...base.holders, completeness: 'unavailable' },
        market: { ...base.market, completeness: 'unavailable' },
        creatorHistory: null,
        creatorOnToken: null,
      }),
    );
    expect(glance.items.find((i) => i.id === 'powers')).toMatchObject({
      tone: 'reassuring',
      title:
        'No one can create more tokens or freeze holders’ tokens, and no rule of the mint acts on transfers.',
    });
  });

  it('lists the mint among what was not measured when it could not be read', () => {
    const glance = glanceOf(
      solanaReport({ mint: { ...base.mint, completeness: 'unavailable', data: null }, powers: [] }),
    );
    expect(glance.unseen).toContain('what the mint lets someone do');
    expect(glance.items.find((i) => i.id === 'powers')).toBeUndefined();
  });
});

describe('In short: the creator’s part and its sales', () => {
  it('files a creator sale under attention, with what it sold and holds', () => {
    const glance = glanceOf(
      solanaReport({
        creatorOnToken: onToken({
          bought: raw(0.12),
          sold: raw(0.12),
          holdsNow: '0',
          holdsNowShare: 0,
        }),
      }),
    );
    expect(glance.items.find((i) => i.id === 'sales')).toMatchObject({
      tone: 'attention',
      figure: '12%',
      title: 'The creator sold 12% of the supply, all it had bought, and holds none of it today.',
    });
  });

  it('adds what the wallets it sent SOL to around the launch did with the token', () => {
    const glance = glanceOf(
      solanaReport({
        linkedWallets: {
          ...base.linkedWallets!,
          data: {
            ...base.linkedWallets!.data,
            window: { from: 1795552000, to: 1795560000 },
            funded: [
              {
                wallet: HOLDER,
                transfers: [],
                lamports: '2000000000',
                onToken: {
                  bought: raw(0.04),
                  sold: raw(0.03),
                  holdsNow: raw(0.01),
                  sales: [],
                  complete: true,
                },
              },
            ],
          },
        },
      }),
    );
    const sales = glance.items.find((i) => i.id === 'sales');
    expect(sales?.tone).toBe('attention');
    expect(sales?.title).toBe(
      'The creator has not sold this token; it holds none of it today. 1 wallet the creator sent SOL to around the launch bought 4% of the supply and sold 3%; the wallets it funded hold 1% today.',
    );
  });

  it(`files a creator holding ${CREATOR_HOLDS_SHARE * 100}% of the supply or more under attention`, () => {
    const holding = (share: number) =>
      glanceOf(
        solanaReport({ creatorOnToken: onToken({ holdsNow: raw(share), holdsNowShare: share }) }),
      ).items.find((i) => i.id === 'sales');
    expect(holding(CREATOR_HOLDS_SHARE)).toMatchObject({ tone: 'attention', figure: '5%' });
    expect(holding(0.049)?.tone).toBe('reassuring');
  });

  it('never says "has not sold" when not every move was read', () => {
    const sales = glanceOf(solanaReport({ creatorOnToken: onToken({}, 'partial') })).items.find(
      (i) => i.id === 'sales',
    );
    expect(sales?.tone).toBe('neutral');
    expect(sales?.title).toMatch(
      /^No sale by the creator was seen in the transactions read \(not all of them\)/,
    );
    expect(sales?.title).not.toMatch(/has not sold/);
  });

  it('says the sales could not be read when that read failed', () => {
    const glance = glanceOf(
      solanaReport({
        creatorOnToken: { ...base.creatorOnToken!, completeness: 'unavailable' },
        failedReads: [
          { read: 'creator-sales', note: 'rate-limit : solana-rpc : request limit reached' },
        ],
        // Fewer findings, so the line said after them is among the four.
        holders: { ...base.holders, completeness: 'unavailable' },
        market: { ...base.market, completeness: 'unavailable' },
      }),
    );
    expect(glance.items.find((i) => i.id === 'sales')).toMatchObject({
      unread: true,
      title: 'Whether the creator sold this token could not be read this time.',
    });
    expect(glance.partial).toEqual(['what the creator did with this token']);
  });
});

describe('In short: wallets that got tokens together at launch', () => {
  it(`files a group in the creation slot at ${GROUP_SHARE * 100}% of the supply or more under attention`, () => {
    const item = (share: number) =>
      glanceOf(solanaReport({ launch: withLaunch({ sameSlot: group(3, share) }) })).items.find(
        (i) => i.id === 'launch-buys',
      );
    expect(item(0.258)).toMatchObject({
      tone: 'attention',
      figure: '25.8%',
      title:
        'In the creation slot, 3 wallets other than the creator got 25.8% of the supply; they hold none of it today.',
    });
    expect(item(GROUP_SHARE)?.tone).toBe('attention');
    expect(item(0.049)?.tone).toBe('neutral');
    // Dust is not a line.
    expect(item(0.009)).toBeUndefined();
  });

  it('says the larger group: paid by the creator, or got in the creation slot', () => {
    const paidMore = glanceOf(
      solanaReport({
        launch: withLaunch({
          sameSlot: group(2, 0.12),
          payerGroup: { ...group(4, 0.3), payers: [CREATOR] },
        }),
      }),
    ).items.find((i) => i.id === 'launch-buys');
    expect(paidMore?.title).toBe(
      '4 wallets got 30% of the supply in transactions paid by the creator or by the creation’s fee payer; they hold none of it today.',
    );
    // 2% paid by the creator never hides 30% got in the creation slot.
    const slotMore = glanceOf(
      solanaReport({
        launch: withLaunch({
          sameSlot: group(2, 0.3),
          payerGroup: { ...group(4, 0.02), payers: [CREATOR] },
        }),
      }),
    ).items.find((i) => i.id === 'launch-buys');
    expect(slotMore?.tone).toBe('attention');
    expect(slotMore?.title).toBe(
      'In the creation slot, 2 wallets other than the creator got 30% of the supply; they hold none of it today.',
    );
  });
});

describe('In short: a market with next to nothing in it', () => {
  /** A token on its pump.fun curve holding `sol`, SOL at $200. */
  const onCurve = (sol: number) =>
    solanaReport({
      market: {
        ...base.market,
        data: { ...base.market.data, liquidityUsd: null, priceUsd: 0.0002, priceNative: 0.000001 },
      },
      graduation: {
        ...base.graduation!,
        data: {
          ...base.graduation!.data,
          raised: { mint: null, raw: String(Math.round(sol * 1e9)) },
        },
      },
    });

  it('leads with a curve that holds almost nothing, in SOL and at the token’s own SOL price', () => {
    const glance = glanceOf(onCurve(0.05));
    expect(glance.items.find((i) => i.id === 'market')).toMatchObject({
      tone: 'attention',
      figure: '0.0500 SOL',
      title:
        'Its market is all but empty: its pump.fun bonding curve holds 0.0500 SOL (about $10). 70 trades in the last 24 hours.',
    });
  });

  it('says a thin curve moves on a modest sale, and a fuller one how far it is to graduation', () => {
    expect(glanceOf(onCurve(3)).items.find((i) => i.id === 'market')?.title).toBe(
      'Its pump.fun bonding curve holds only 3.00 SOL (about $600): a sale of a few hundred dollars moves its price.',
    );
    expect(glanceOf(onCurve(40)).items.find((i) => i.id === 'market')).toMatchObject({
      tone: 'neutral',
      figure: '20%',
      title:
        'It is 20% of the way to graduation; its pump.fun bonding curve holds 40.0 SOL (about $8.0k).',
    });
  });

  it('puts the powers first, then the empty market', () => {
    const report = onCurve(0.05);
    report.powers = [power({ power: 'freeze', status: 'held' })];
    const ids = glanceOf(report).items.map((i) => i.id);
    expect(ids.slice(0, 2)).toEqual(['powers', 'market']);
  });
});

describe('In short: the market of a token traded in many pools', () => {
  it('writes counts with separators and says where the trades were counted', () => {
    // USDC, 25/11/2026: "over 141028 trades, none in the last hour", from its main pair alone.
    const report = solanaReport({
      graduation: null,
      market: {
        ...base.market,
        data: {
          ...base.market.data,
          liquidityUsd: 2_237_040.67,
          volumeUsd: { m5: 0, h1: 167_180.78, h6: 450_547.5, h24: 15_693_112.68 },
          txns: { h1: { buys: 128, sells: 73 }, h24: { buys: 94_218, sells: 94_746 } },
          pairsCounted: 25,
          quiet: null,
        },
      },
    });
    const facts = toFacts(report);
    const item = buildGlance({ facts })!.items.find((i) => i.id === 'market');
    expect(item).toMatchObject({
      figure: '$15.7M',
      title: '$15.7M traded in the last 24 hours, over 188,964 trades.',
      detail: 'From DexScreener: its main pair and its other pairs against SOL, USDC or USDT.',
    });
  });
});

describe('In short: the creator’s other tokens', () => {
  const history = (counts: {
    launched: number;
    dead: number;
    graduated?: number;
    active?: number;
  }) =>
    glanceOf(
      solanaReport({
        creatorHistory: {
          ...base.creatorHistory!,
          data: {
            ...base.creatorHistory!.data,
            counts: {
              launched: counts.launched,
              dead: counts.dead,
              graduated: counts.graduated ?? 0,
              active: counts.active ?? 0,
              unknown:
                counts.launched - counts.dead - (counts.graduated ?? 0) - (counts.active ?? 0),
            },
          },
        },
      }),
    ).items.find((i) => i.id === 'record');

  it(`files ${DEAD_LAUNCHES_MIN} or more tokens with no trade left, half of them or more, under attention`, () => {
    expect(history({ launched: 5, dead: 3, graduated: 1 })).toMatchObject({
      tone: 'attention',
      figure: '5',
      title:
        'This creator launched 5 other tokens: 3 were launched over a day ago and had no trade in the last 24 hours and 1 graduated from their curve.',
    });
    expect(history({ launched: 3, dead: 2 })?.tone).toBe('neutral');
    expect(history({ launched: 7, dead: 3 })?.tone).toBe('neutral');
  });

  it('never says the creator has no other token, only that none was found', () => {
    expect(history({ launched: 0, dead: 0 })?.title).toBe(
      'No other token by this creator was found on pump.fun’s curves or in its transactions read.',
    );
  });
});

describe('In short: where the supply sits', () => {
  it('says how little circulates when the curve holds nearly all of it', () => {
    const report = solanaReport({
      holders: { ...base.holders, data: { ...base.holders.data, pooledShare: 0.998 } },
    });
    expect(glanceOf(report).items.find((i) => i.id === 'supply')?.title).toBe(
      '99.8% of the supply is still in its bonding curve: only 0.2% is held outside it so far.',
    );
  });

  it('restates the largest share against the whole supply', () => {
    expect(glanceOf(base).items.find((i) => i.id === 'supply')).toMatchObject({
      tone: 'attention',
      title:
        'One wallet holds 75% of the tokens held outside its bonding curve (15% of the whole supply).',
    });
  });
});

describe('In short: the rules every line keeps', () => {
  it('never scores the token nor words a verdict', () => {
    const report = solanaReport({
      powers: [power({ power: 'permanent-delegate', status: 'held' })],
      creatorOnToken: onToken({ sold: raw(0.1), bought: raw(0.1) }),
      launch: withLaunch({ sameSlot: group(5, 0.4) }),
    });
    const text = JSON.stringify(glanceOf(report));
    expect(findViolations(text)).toEqual([]);
    expect(text).not.toMatch(/score|\/10\b|\/100\b|\bsafe\b|risky|scam|\brug/i);
  });

  it('keeps to four lines', () => {
    const report = solanaReport({
      powers: [power({ power: 'freeze', status: 'held' })],
      creatorOnToken: onToken({ sold: raw(0.1), bought: raw(0.1) }),
      launch: withLaunch({ sameSlot: group(5, 0.4) }),
    });
    expect(glanceOf(report).items.length).toBeLessThanOrEqual(4);
  });

  it('has nothing to say without facts', () => {
    expect(buildGlance({})).toBeNull();
  });
});
