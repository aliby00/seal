import { describe, expect, it } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { findViolations } from '../../src/lib/agent/guardrails';
import { answerAll, briefSpecialists } from '../../src/lib/specialists/brief';
import { CATALOG, NO_REPORT } from '../../src/lib/specialists/catalog';
import { PLAIN_LABEL, shortAnswer } from '../../src/lib/specialists/plain';
import { SPECIALIST_IDS, type SpecialistId } from '../../src/lib/specialists/types';
import type { TokenPower } from '../../src/lib/solana/token-types';
import { COLLECT_TOKENS, loadCollectRecording } from '../collect/recording';
import { CREATOR, HOLDER, solanaReport } from '../helpers/solana-report';

const base = solanaReport();
const ask = (id: SpecialistId, report: TokenReport | undefined) =>
  CATALOG[id].run({ token: report?.token ?? base.token, ...(report ? { report } : {}) });

const power = (p: Partial<TokenPower> & Pick<TokenPower, 'power' | 'status'>): TokenPower => ({
  holder: p.status === 'held' ? CREATOR : null,
  sentence: `The ${p.power} power is ${p.status}.`,
  from: 'mint',
  ...p,
});

describe('the catalogue', () => {
  it('asks ten questions, Code Reuse and Rule Change gone, Token Powers and Transfer Rules in', () => {
    expect(SPECIALIST_IDS).toHaveLength(10);
    expect(Object.keys(CATALOG).sort()).toEqual([...SPECIALIST_IDS].sort());
    expect(Object.keys(PLAIN_LABEL).sort()).toEqual([...SPECIALIST_IDS].sort());
    expect(SPECIALIST_IDS).toEqual(expect.arrayContaining(['token-powers', 'transfer-rules']));
    expect(SPECIALIST_IDS).not.toEqual(expect.arrayContaining(['code-reuse']));
    expect(SPECIALIST_IDS).not.toEqual(expect.arrayContaining(['rule-change']));
    for (const id of SPECIALIST_IDS) expect(CATALOG[id].id).toBe(id);
  });

  it('words every title and question for Solana, with no EVM term and no verdict', () => {
    const text = SPECIALIST_IDS.map(
      (id) => `${CATALOG[id].title} ${CATALOG[id].question} ${PLAIN_LABEL[id]}`,
    ).join(' ');
    expect(text).not.toMatch(
      /robinhood|blockscout|\bpons\b|doppler|uniswap|\bhook\b(?! )|\bv4\b|\bETH\b/i,
    );
    expect(findViolations(text)).toEqual([]);
    expect(new Set(SPECIALIST_IDS.map((id) => CATALOG[id].title)).size).toBe(10);
  });

  it('answers every question "unknown" without a report, and says why', () => {
    for (const id of SPECIALIST_IDS) {
      const finding = ask(id, undefined);
      expect(finding.signal).toBe('unknown');
      expect(finding.limits).toEqual([NO_REPORT]);
    }
  });
});

describe('Token Powers', () => {
  it('files a mint or freeze authority someone holds under attention, and names who', () => {
    const finding = ask(
      'token-powers',
      solanaReport({
        powers: [
          power({
            power: 'mint',
            status: 'held',
            holder: HOLDER,
            sentence: 'Someone can create new tokens (mint authority).',
          }),
          power({ power: 'freeze', status: 'none' }),
        ],
      }),
    );
    expect(finding.signal).toBe('concern');
    expect(finding.facts[0]).toBe(
      `Someone can create new tokens (mint authority). Held by ${HOLDER.slice(0, 4)}…${HOLDER.slice(-4)}.`,
    );
    expect(finding.measures?.powers).toEqual([
      { power: 'mint', status: 'held', byCreator: false },
      { power: 'freeze', status: 'none', byCreator: false },
    ]);
  });

  it('reassures only when nobody can mint or freeze, and calls a metadata authority notable', () => {
    expect(ask('token-powers', base).signal).toBe('reassurance');
    const meta = ask(
      'token-powers',
      solanaReport({ powers: [power({ power: 'metadata-update', status: 'held' })] }),
    );
    expect(meta.signal).toBe('observation');
  });

  it('cannot reassure on a mint with a part it could not decode', () => {
    const finding = ask(
      'token-powers',
      solanaReport({ powers: [power({ power: 'unknown', status: 'unknown' })] }),
    );
    expect(finding.signal).toBe('observation');
    expect(finding.limits.join(' ')).toMatch(/could not be decoded/);
  });

  it('is unknown when the mint could not be read', () => {
    const finding = ask(
      'token-powers',
      solanaReport({
        mint: {
          completeness: 'unavailable',
          sources: [
            {
              name: 'solana-rpc',
              fetchedAt: base.collectedAt,
              note: 'timeout : solana-rpc : request timed out',
            },
          ],
          data: null,
        },
        powers: [],
      }),
    );
    expect(finding.signal).toBe('unknown');
    expect(finding.limits[0]).toBe(
      'the mint could not be read (the source did not answer this time; try again in a minute)',
    );
  });
});

describe('Transfer Rules', () => {
  it('reassures on an SPL Token mint, which has no transfer rules at all', () => {
    const spl = solanaReport({
      mint: { ...base.mint, data: { ...base.mint.data!, program: 'spl-token' } },
    });
    const finding = ask('transfer-rules', spl);
    expect(finding.signal).toBe('reassurance');
    expect(finding.facts[0]).toMatch(/^It is an SPL Token mint/);
  });

  it('files a permanent delegate, a fee charged or a program on transfers under attention', () => {
    for (const p of [
      power({ power: 'permanent-delegate', status: 'held', from: 'permanentDelegate' }),
      power({
        power: 'transfer-fee',
        status: 'fixed',
        sentence: 'Every transfer pays a 2% fee; no one can collect it (no withdraw authority).',
      }),
      power({ power: 'non-transferable', status: 'fixed' }),
    ]) {
      expect(ask('transfer-rules', solanaReport({ powers: [p] })).signal).toBe('concern');
    }
    const fee = ask(
      'transfer-rules',
      solanaReport({
        powers: [
          power({
            power: 'transfer-fee',
            status: 'fixed',
            sentence: 'Every transfer pays a 2% fee; no one can collect it.',
          }),
        ],
      }),
    );
    expect(fee.measures?.rules?.[0]).toMatchObject({
      power: 'transfer-fee',
      active: true,
      fee: '2%',
    });
  });

  it('calls a power someone could use later notable, not yet acting', () => {
    const finding = ask(
      'transfer-rules',
      solanaReport({
        powers: [
          power({ power: 'transfer-fee-change', status: 'held', from: 'transferFeeConfig' }),
        ],
      }),
    );
    expect(finding.signal).toBe('observation');
  });
});

describe('Holder Spread', () => {
  it('files the creator holding 5% of the supply or more under attention', () => {
    const holding = (ofSupply: number) =>
      ask(
        'holder-spread',
        solanaReport({
          holders: {
            ...base.holders,
            data: {
              ...base.holders.data,
              concentration: { top1: 0.1, top10: 0.4 },
              creator: {
                address: CREATOR,
                balance: '1',
                ofSupply,
                share: ofSupply * 5,
                tokenAccounts: 1,
              },
            },
          },
        }),
      ).signal;
    expect(holding(0.05)).toBe('concern');
    expect(holding(0.049)).toBe('quiet');
  });

  it('says how little circulates when the curve holds nearly everything', () => {
    const finding = ask(
      'holder-spread',
      solanaReport({
        holders: { ...base.holders, data: { ...base.holders.data, pooledShare: 0.998 } },
      }),
    );
    expect(finding.signal).toBe('observation');
  });
});

describe('Creator History', () => {
  it('reads "no sale" only from a full read, and a sale from any read', () => {
    const partial = ask(
      'creator-history',
      solanaReport({ creatorOnToken: { ...base.creatorOnToken!, completeness: 'partial' } }),
    );
    expect(partial.facts.join(' ')).not.toMatch(/has not sold/);
    expect(partial.limits.join(' ')).toMatch(
      /no sale was seen, but one may lie in the transactions not read/,
    );
    expect(partial.measures?.creator?.hasSold).toBeNull();
    const sold = ask(
      'creator-history',
      solanaReport({
        creatorOnToken: {
          ...base.creatorOnToken!,
          completeness: 'partial',
          data: {
            ...base.creatorOnToken!.data,
            bought: '100000000000000',
            sold: '100000000000000',
          },
        },
      }),
    );
    expect(sold.signal).toBe('concern');
    expect(sold.measures?.creator).toMatchObject({ hasSold: true, sold: 0.1, bought: 0.1 });
  });

  it('never says the creator has no other token, only that none was found', () => {
    const finding = ask('creator-history', base);
    expect(finding.facts[0]).toMatch(
      /^No other token by this creator was found on pump\.fun’s curves/,
    );
  });

  it('files three dead tokens or more, half of its launches or more, under attention', () => {
    const withCounts = (launched: number, dead: number) =>
      ask(
        'creator-history',
        solanaReport({
          creatorHistory: {
            ...base.creatorHistory!,
            data: {
              ...base.creatorHistory!.data,
              counts: { launched, dead, graduated: 0, active: launched - dead, unknown: 0 },
            },
          },
        }),
      ).signal;
    expect(withCounts(6, 3)).toBe('concern');
    expect(withCounts(7, 3)).toBe('observation');
    expect(withCounts(2, 2)).toBe('observation');
  });
});

describe('Wallet Age, Funding Trace', () => {
  const funded = (secondsBefore: number) =>
    solanaReport({
      linkedWallets: {
        ...base.linkedWallets!,
        data: {
          ...base.linkedWallets!.data,
          funding: 'found',
          firstFunding: {
            from: HOLDER,
            to: CREATOR,
            lamports: '1500000000',
            how: 'system-transfer',
            signature: 'sig',
            slot: 1,
            blockTime: base.creator.data.creation!.blockTime! - secondsBefore,
          },
        },
      },
    });

  it('files a wallet first funded less than a day before the creation under attention', () => {
    const fresh = ask('wallet-age', funded(240));
    expect(fresh.signal).toBe('concern');
    expect(fresh.facts[0]).toMatch(
      /first received SOL on .+, 4 minutes before the token was created\./,
    );
    expect(ask('wallet-age', funded(3 * 86_400)).signal).toBe('observation');
    expect(ask('wallet-age', funded(30 * 86_400)).signal).toBe('quiet');
  });

  it('names who first sent SOL, and never says who is behind it', () => {
    const finding = ask('funding-trace', funded(240));
    expect(finding.facts[0]).toMatch(
      /^The creator’s first SOL came from 9WzD…AWWM: 1\.50 SOL on .+, by a transfer\.$/,
    );
    expect(finding.limits).toContain(
      'who is behind the funding address is not read: an exchange, a service or a person',
    );
    expect(finding.funding).toEqual({
      kind: 'unknown',
      linkedCreators: 0,
      launches: null,
      depth: 1,
      path: [{ address: HOLDER, kind: 'unknown', name: null, txCount: null }],
    });
  });

  it('files wallets the creator funded around the launch that traded the token under attention', () => {
    const report = funded(240);
    report.linkedWallets!.data.window = { from: 1795552000, to: 1795560000 };
    report.linkedWallets!.data.funded = [
      {
        wallet: HOLDER,
        transfers: [],
        lamports: '1000000000',
        onToken: {
          bought: '50000000000000',
          sold: '20000000000000',
          holdsNow: '30000000000000',
          sales: [],
          complete: true,
        },
      },
    ];
    const finding = ask('funding-trace', report);
    expect(finding.signal).toBe('concern');
    expect(finding.facts).toContain(
      '1 of them traded this token: they bought 5.0% of the supply and sold 2.0%; they hold 3.0% today.',
    );
    expect(finding.measures?.linked).toEqual({
      wallets: 1,
      buyers: 1,
      sellers: 1,
      bought: 0.05,
      sold: 0.02,
      heldNow: 0.03,
      complete: true,
    });
  });
});

describe('Volume Reality, Sell Path, Liquidity Move, Name Clone', () => {
  it('files a group that got 5% or more in the creation slot under attention', () => {
    const report = solanaReport({
      launch: {
        ...base.launch,
        data: {
          ...base.launch.data,
          sameSlot: {
            wallets: 3,
            share: 0.258,
            transactions: 3,
            heldNow: 0,
            unread: 0,
            soldInWindow: 3,
            solSpent: 10.6,
            addresses: [],
          },
        },
      },
    });
    const finding = ask('volume-reality', report);
    expect(finding.signal).toBe('concern');
    expect(finding.facts[0]).toBe(
      'In the creation slot, 3 wallets other than the creator got 25.8% of the supply in 3 transactions, 3 of them sold in the window read; they hold none of it today.',
    );
  });

  it('files many trades for few holders under attention', () => {
    const finding = ask(
      'volume-reality',
      solanaReport({
        market: {
          ...base.market,
          data: {
            ...base.market.data,
            txns: { h1: { buys: 1, sells: 1 }, h24: { buys: 447, sells: 427 } },
          },
        },
        holders: { ...base.holders, data: { ...base.holders.data, holderCount: 4 } },
      }),
    );
    expect(finding.signal).toBe('concern');
    expect(finding.facts).toContain(
      'That is more than 10 trades in a day for each wallet holding it now.',
    );
  });

  it('reassures on selling only when nothing in the mint can stop a sale and sales went through', () => {
    expect(ask('sell-path', base).signal).toBe('reassurance');
    const frozen = ask(
      'sell-path',
      solanaReport({ powers: [power({ power: 'freeze', status: 'held' })] }),
    );
    expect(frozen.signal).toBe('observation');
    const blocked = ask(
      'sell-path',
      solanaReport({ powers: [power({ power: 'non-transferable', status: 'fixed' })] }),
    );
    expect(blocked.signal).toBe('concern');
  });

  it('does not apply the pool question to a token still on its curve', () => {
    const finding = ask('liquidity-move', base);
    expect(finding.notApplicable).toBe(true);
    expect(shortAnswer({ ...finding, title: 'Liquidity Move', question: '' })).toBe(
      'Not applicable: the token is still on its pump.fun bonding curve, which has no pool shares to withdraw yet',
    );
  });

  it('reassures when every pool read has its liquidity burned', () => {
    const graduated = solanaReport({
      graduation: { ...base.graduation!, data: { ...base.graduation!.data, graduated: true } },
      liquidity: {
        completeness: 'full',
        sources: [],
        data: {
          mint: base.token,
          pools: [
            {
              pool: HOLDER,
              program: null,
              kind: 'pumpswap',
              programName: 'PumpSwap',
              known: true,
              burnedShare: 1,
              lockedShare: 0,
              withdrawableShare: 0,
              holders: [],
              holdersCount: null,
              note: null,
            },
          ],
        },
      },
    });
    const finding = ask('liquidity-move', graduated);
    expect(finding.signal).toBe('reassurance');
    expect(finding.facts[0]).toBe('PumpSwap 9WzD…AWWM: 100.0% burned, 0.00% withdrawable.');
  });

  it('flags a symbol taken from a well-known token under another mint', () => {
    const clone = solanaReport({
      mint: {
        ...base.mint,
        data: {
          ...base.mint.data!,
          metadata: { ...base.mint.data!.metadata!, name: 'USD Coin', symbol: 'USDC' },
        },
      },
    });
    const finding = ask('name-clone', clone);
    expect(finding.signal).toBe('concern');
    expect(finding.facts[0]).toMatch(
      /use those of USD Coin \(USDC\), whose mint is EPjF…Dt1v; this token is another mint\./,
    );
  });
});

describe('the ten questions, replayed on the tokens recorded on mainnet', () => {
  for (const { slug } of COLLECT_TOKENS) {
    it(`${slug}: every line passes the guardrails, and the answers match the recorded facts`, () => {
      const report = loadCollectRecording(slug).report;
      const answers = answerAll({
        token: report.token,
        report,
        creator: report.creator.data.creator,
      });
      expect(answers.map((a) => a.specialist)).toEqual([...SPECIALIST_IDS]);
      for (const a of answers) {
        expect(findViolations([...a.facts, ...a.limits, shortAnswer(a)].join('\n'))).toEqual([]);
        expect(a.facts.join(' ')).not.toMatch(
          /robinhood|blockscout|\bpons\b|doppler|uniswap|\bETH\b/i,
        );
      }
      const by = Object.fromEntries(answers.map((a) => [a.specialist, a]));
      if (slug === 'pump-creator-sold') {
        // Read on chain: the creator bought 11.9 % at the creation, sold it all, holds none.
        expect(by['creator-history']!.signal).toBe('concern');
        expect(by['creator-history']!.facts[1]).toBe(
          'On this token, the creator bought 11.9% of the supply for 3.80 SOL, sold 11.9% for 4.00 SOL (2 of 2 transactions on its token accounts read).',
        );
        expect(by['volume-reality']!.measures?.launch?.sameSlot).toMatchObject({
          wallets: 2,
          share: 0.395332,
        });
        expect(by['liquidity-move']!.notApplicable).toBe(true);
        expect(by['token-powers']!.signal).toBe('reassurance');
      }
      if (slug === 'meteora-dbc') {
        // 15 of 16 transactions read: no sale seen, never "has not sold".
        expect(by['creator-history']!.measures?.creator?.hasSold).toBeNull();
        expect(by['transfer-rules']!.facts[0]).toMatch(/^It is an SPL Token mint/);
        expect(by['wallet-age']!.signal).toBe('concern');
      }
      if (slug === 'pyusd') {
        // PYUSD keeps a permanent delegate, a freeze and a mint authority.
        expect(by['token-powers']!.signal).toBe('concern');
        expect(by['transfer-rules']!.signal).toBe('concern');
        expect(by['transfer-rules']!.measures?.rules?.map((r) => r.power)).toContain(
          'permanent-delegate',
        );
        expect(by['holder-spread']!.signal).toBe('unknown');
        // Its own name is not borrowed: the mint is PayPal USD's.
        expect(by['name-clone']!.signal).toBe('quiet');
      }
    });
  }

  it('briefs the questions from the report, with the token’s own name', async () => {
    const report = loadCollectRecording('pyusd').report;
    const brief = await briefSpecialists(report.token, report);
    expect(brief.answers).toHaveLength(10);
    expect(brief.unanswered).toEqual([]);
    expect(brief.name).toBe('PayPal USD');
    expect(
      brief.answers.find((a) => a.specialist === 'token-powers')?.measures?.powers,
    ).toBeDefined();
  });
});
