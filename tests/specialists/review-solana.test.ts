import { describe, expect, it } from 'vitest';
import { findViolations } from '../../src/lib/agent/guardrails';
import { findClaims } from '../../src/lib/agent/claims';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { renderReport } from '../../src/lib/agent/prompt';
import type { TokenReport } from '../../src/lib/contracts';
import { toFacts } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';
import type { TokenPower } from '../../src/lib/solana/token-types';
import { answerAll } from '../../src/lib/specialists/brief';
import { CATALOG } from '../../src/lib/specialists/catalog';
import { shortAnswer } from '../../src/lib/specialists/plain';
import type { SpecialistId } from '../../src/lib/specialists/types';
import { loadCollectRecording } from '../collect/recording';
import { CREATOR, HOLDER, MINT, solanaReport } from '../helpers/solana-report';

/**
 * The cases an adversarial read of the Solana questions, the summary and the
 * texts found wrong: each sentence must hold on the facts it is given, a
 * read that failed is never said as an absence, and a fact never goes unsaid
 * because a figure next to it is missing.
 */

const base = solanaReport();
const ask = (id: SpecialistId, report: TokenReport) =>
  CATALOG[id].run({ token: report.token, report, creator: report.creator.data.creator });
const answersOf = (report: TokenReport) =>
  answerAll({ token: report.token, report, creator: report.creator.data.creator });
const glanceOf = (report: TokenReport) =>
  buildGlance({ facts: toFacts(report), specialists: answersOf(report) })!;

const UNDECODED: TokenPower = {
  power: 'unknown',
  status: 'unknown',
  holder: null,
  sentence: 'The mint carries an extension SEAL cannot read (type 99): what it allows is unknown.',
  from: 'unknown',
};

/** The creator block, read or not, without a creator. */
const noCreator = (completeness: 'full' | 'unavailable') =>
  solanaReport({
    creator: {
      completeness,
      sources: [
        {
          name: 'solana-rpc',
          fetchedAt: base.collectedAt,
          ...(completeness === 'unavailable' ? { note: 'timeout : solana-rpc : timed out' } : {}),
        },
      ],
      data: { ...base.creator.data, creator: null, from: null },
    },
    creatorHistory: null,
    creatorOnToken: null,
    linkedWallets: null,
  });

describe('a creator question with no creator', () => {
  it('says the creator could not be read when the read failed, never that nobody is named', () => {
    for (const id of ['wallet-age', 'funding-trace', 'creator-history'] as const) {
      const failed = ask(id, noCreator('unavailable'));
      expect(failed.signal).toBe('unknown');
      expect(failed.limits.join(' ')).toMatch(/^the creator could not be read/);
      expect(failed.limits.join(' ')).not.toMatch(/no creator is named/);
      const none = ask(id, noCreator('full'));
      expect(none.limits.join(' ')).toMatch(/no creator is named on the chain/);
    }
  });
});

describe('a creator question with no creator, the creation found by the launch replay', () => {
  const PAYER = 'JUPhop9E8ZfdJ5FNHhxQt4uAih822Vs4QpqsWcewFbq';
  const withCreation = (report: TokenReport): TokenReport => ({
    ...report,
    launch: {
      ...report.launch,
      data: {
        ...report.launch.data,
        creation: {
          signature:
            '4h5iBF43PvG9SuKZyJiJ2mEUddsNd71uVW7X7Lz5RYzMJYqPeoPqLyNtz2fH9nd9FWKxqKXhmXtK3F9QqptzbZ',
          slot: 243989543,
          launchedAt: '2024-01-25T08:54:00.000Z',
          payer: PAYER,
          signers: [PAYER],
          foundBy: 'creation-time',
        },
      },
    },
  });
  // JUP as staging served it (25/11/2026): the creator read answered, without a creator.
  const jup = withCreation(
    solanaReport({
      creator: {
        completeness: 'unavailable',
        sources: [
          {
            name: 'solana-rpc',
            fetchedAt: base.collectedAt,
            note: 'the mint has more than 3000 transactions: its creation was not reached; no curve, creation transaction or metadata authority names a creator',
          },
        ],
        data: { ...base.creator.data, creator: null, from: null },
      },
      creatorHistory: null,
      creatorOnToken: null,
      linkedWallets: null,
    }),
  );
  const said =
    'no creator is named on the chain (no pump.fun curve or metadata authority names one); JUPh…wFbq paid for the creation (transaction 4h5i…tzbZ)';

  it('says who paid for the creation, never that no creation transaction names one', () => {
    for (const id of ['wallet-age', 'funding-trace', 'creator-history'] as const) {
      for (const report of [jup, withCreation(noCreator('full'))]) {
        const finding = ask(id, report);
        expect(finding.signal).toBe('unknown');
        expect(finding.limits).toEqual([said]);
        expect(finding.limits.join(' ')).not.toMatch(/creation transaction or metadata/);
        expect(findViolations(finding.limits.join(' '))).toEqual([]);
      }
      // A creator read that failed still says so.
      expect(ask(id, withCreation(noCreator('unavailable'))).limits.join(' ')).toMatch(
        /^the creator could not be read/,
      );
    }
  });
});

describe('an extension SEAL cannot decode', () => {
  const report = solanaReport({ powers: [...base.powers, UNDECODED] });

  it('keeps Transfer Rules from saying no extension acts on transfers', () => {
    const finding = ask('transfer-rules', report);
    expect(finding.signal).toBe('observation');
    expect(finding.facts.join(' ')).not.toMatch(/without any extension/);
    expect(finding.limits.join(' ')).toMatch(/cannot read: whether it acts on transfers/);
    expect(shortAnswer({ ...finding, title: '', question: '' })).not.toBe(
      'No rule acts on transfers',
    );
  });

  it('keeps Sell Path from saying nothing in the mint can stop a sale', () => {
    const finding = ask('sell-path', report);
    expect(finding.facts.join(' ')).not.toMatch(/^Nothing in the mint/m);
    expect(finding.facts).toContain(
      'Nothing SEAL can read in the mint can stop a sale: no freeze authority, no permanent delegate, no transfer hook, no pause.',
    );
    expect(finding.signal).toBe('observation');
  });
});

describe('Sell Path', () => {
  it('says what stops a sale today first, so its one line is that fact', () => {
    const paused = solanaReport({
      mint: {
        ...base.mint,
        data: {
          ...base.mint.data!,
          extensions: [{ extension: 'pausableConfig', state: { authority: null, paused: true } }],
        },
      },
      powers: [
        ...base.powers,
        {
          power: 'pause',
          status: 'fixed',
          holder: null,
          sentence: 'Transfers, minting and burning are paused, and no one can resume them.',
          from: 'pausableConfig',
        },
      ],
    });
    const finding = ask('sell-path', paused);
    expect(finding.signal).toBe('concern');
    expect(finding.facts[0]).toBe(
      'Transfers, minting and burning are paused, and no one can resume them.',
    );
    expect(shortAnswer({ ...finding, title: '', question: '' })).toMatch(/^Transfers, minting/);
  });
});

describe('Creator History', () => {
  it('says what the creator bought even when the supply is not known', () => {
    const report = solanaReport({
      mint: { completeness: 'unavailable', sources: base.mint.sources, data: null },
      holders: {
        ...base.holders,
        completeness: 'unavailable',
        data: { ...base.holders.data, supply: '' },
      },
      creatorOnToken: {
        ...base.creatorOnToken!,
        data: { ...base.creatorOnToken!.data, bought: '5000', supply: null },
      },
    });
    const facts = ask('creator-history', report).facts.join(' ');
    expect(facts).not.toMatch(/neither bought nor received/);
    expect(facts).toMatch(/the creator bought some/);
  });

  it('says what the creator passed on outside any market', () => {
    const report = solanaReport({
      creatorOnToken: {
        ...base.creatorOnToken!,
        data: {
          ...base.creatorOnToken!.data,
          received: '300000000000000',
          sends: {
            recipients: [{ address: HOLDER, value: '250000000000000' }],
            distinct: 1,
            burned: '0',
            total: '250000000000000',
          },
        },
      },
    });
    expect(ask('creator-history', report).facts[1]).toMatch(
      /received 30\.0% from other addresses, sent 25\.0% to 1 other address outside any market/,
    );
  });
});

describe('Holder Spread', () => {
  it('says a dust balance of the creator as "<0.01%", never "none"', () => {
    const report = solanaReport({
      holders: {
        ...base.holders,
        data: {
          ...base.holders.data,
          creator: {
            address: CREATOR,
            balance: '5000000',
            ofSupply: 0,
            share: 0,
            tokenAccounts: 1,
          },
        },
      },
    });
    const facts = ask('holder-spread', report).facts.join(' ');
    expect(facts).toContain('The creator holds <0.01% of the supply (<0.01% of what circulates).');
    expect(facts).not.toMatch(/holds none/);
  });
});

describe('Wallet Age', () => {
  it('does not call a wallet funded after the creation "funded less than a day before"', () => {
    const report = solanaReport({
      linkedWallets: {
        ...base.linkedWallets!,
        data: {
          ...base.linkedWallets!.data,
          funding: 'found',
          firstFunding: {
            from: HOLDER,
            to: CREATOR,
            lamports: '1000000000',
            how: 'system-transfer',
            signature: 'x',
            slot: 1,
            blockTime: base.creator.data.creation!.blockTime! + 600,
          },
        },
      },
    });
    const finding = ask('wallet-age', report);
    expect(finding.facts[0]).toMatch(/after the token was created/);
    expect(finding.signal).toBe('observation');
    expect(shortAnswer({ ...finding, title: '', question: '' })).not.toMatch(/less than a day/);
  });
});

describe('Name Clone', () => {
  it('says which of name and symbol is borrowed', () => {
    const report = solanaReport({
      mint: {
        ...base.mint,
        data: {
          ...base.mint.data!,
          metadata: { ...base.mint.data!.metadata!, name: 'Moon Dog', symbol: 'USDC' },
        },
      },
    });
    const fact = ask('name-clone', report).facts[0]!;
    expect(fact).toMatch(/^Its symbol "USDC" uses that of USD Coin \(USDC\)/);
    expect(fact).not.toMatch(/Its name "Moon Dog" and symbol/);
  });

  it('says the metadata could not be read, never that the mint carries none', () => {
    const report = solanaReport({
      mint: {
        ...base.mint,
        data: {
          ...base.mint.data!,
          metadata: null,
          gaps: ['the metadata account X the pointer names could not be read (timeout)'],
        },
      },
    });
    const finding = ask('name-clone', report);
    expect(finding.signal).toBe('unknown');
    expect(finding.facts).toEqual([]);
  });

  it('says the token is the well-known mint itself, never that its name matches none', () => {
    // PYUSD, recorded on mainnet (tests/fixtures/solana/collect/pyusd.json.gz).
    const { report } = loadCollectRecording('pyusd');
    const finding = ask('name-clone', report);
    expect(finding.facts[0]).toBe(
      'This is the mint of PayPal USD (PYUSD) itself, one of the well-known tokens SEAL compares names with.',
    );
    expect(finding.facts.join(' ')).not.toMatch(/match(?:es|ed)? none|another mint/);
    expect(finding.limits.join(' ')).not.toMatch(/short list/);
    expect(finding.signal).toBe('quiet');

    // The real USDC, named as it is on chain.
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const real = solanaReport({
      mint: {
        ...base.mint,
        data: {
          ...base.mint.data!,
          metadata: { ...base.mint.data!.metadata!, name: 'USD Coin', symbol: 'USDC' },
        },
      },
    });
    const facts = ask('name-clone', { ...real, token: usdc }).facts;
    expect(facts[0]).toMatch(/^This is the mint of USD Coin \(USDC\) itself/);
    expect(facts.join(' ')).not.toMatch(/match(?:es|ed)? none|another mint/);
  });

  it('does not claim the creator’s launches were compared when they were not read', () => {
    const report = solanaReport({
      creatorHistory: { ...base.creatorHistory!, completeness: 'unavailable' },
    });
    const finding = ask('name-clone', report);
    expect(finding.facts[0]).not.toMatch(/creator’s other launches/);
    expect(finding.limits.join(' ')).toMatch(/other launches were not read/);
  });
});

describe('Liquidity Move', () => {
  const graduated = (pools: NonNullable<TokenReport['liquidity']>['data']['pools']) =>
    solanaReport({
      graduation: { ...base.graduation!, data: { ...base.graduation!.data, graduated: true } },
      liquidity: {
        completeness: 'full',
        sources: base.liquidity.sources,
        data: { mint: MINT, pools },
      },
    });

  it('says no pool was listed, not that what the pools hold could not be read', () => {
    const finding = ask('liquidity-move', graduated([]));
    expect(finding.limits[0]).toMatch(/^no trading pool of this token was listed/);
  });

  it('names the creator’s share of a pool’s liquidity, first, when it is not the largest', () => {
    const pool = (id: string, holders: { owner: string; share: number }[]) => ({
      pool: id,
      program: null,
      kind: 'raydium-cpmm' as const,
      programName: 'Raydium CPMM',
      known: true,
      burnedShare: 0,
      lockedShare: null,
      withdrawableShare: 1,
      holders: holders.map((h) => ({ account: h.owner, kind: 'wallet' as const, ...h })),
      holdersCount: null,
      note: null,
    });
    const finding = ask(
      'liquidity-move',
      graduated([
        pool('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWW1', [{ owner: HOLDER, share: 0.3 }]),
        pool('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWW2', [
          { owner: HOLDER, share: 0.6 },
          { owner: CREATOR, share: 0.1 },
        ]),
      ]),
    );
    expect(finding.signal).toBe('concern');
    expect(finding.facts[0]).toMatch(/AWW2: .*; the creator has 10\.0%\.$/);
  });
});

describe('Volume Reality, one line', () => {
  it('says where each group got its tokens: the creation slot, or transactions the creator paid for', () => {
    const answer = (sameSlot: number | null, paid: number | null) =>
      shortAnswer({
        specialist: 'volume-reality',
        title: '',
        question: '',
        signal: 'concern',
        facts: [],
        limits: [],
        measures: {
          launch: {
            sameSlot:
              sameSlot === null
                ? null
                : { wallets: 2, share: sameSlot, heldNow: 0, soldInWindow: 0 },
            payerGroup:
              paid === null ? null : { wallets: 3, share: paid, heldNow: 0, soldInWindow: 0 },
            roundTrips: null,
          },
        },
      });
    expect(answer(0.3, 0.02)).toBe('At launch, 2 wallets got 30% in the creation slot');
    expect(answer(0.02, 0.3)).toBe(
      'At launch, 3 wallets got 30% in transactions the creator paid for',
    );
  });
});

describe('In short', () => {
  it('never says no rule acts on transfers while a fee is scheduled', () => {
    const report = solanaReport({
      powers: [
        ...base.powers,
        {
          power: 'transfer-fee',
          status: 'fixed',
          holder: null,
          sentence: 'Transfers pay no fee today; from epoch 900 they pay 5%.',
          from: 'transferFeeConfig',
        },
      ],
    });
    const item = glanceOf(report).items.find((i) => i.id === 'powers');
    expect(item?.tone).toBe('neutral');
    expect(item?.title).not.toMatch(/no rule of the mint acts on transfers/);
  });

  it('says what the funded wallets bought as a floor when their trades were not all read', () => {
    const report = solanaReport({
      linkedWallets: {
        ...base.linkedWallets!,
        data: {
          ...base.linkedWallets!.data,
          window: { from: 1795550000, to: 1795560000 },
          funded: [
            {
              wallet: HOLDER,
              transfers: [],
              lamports: '1000000000',
              onToken: {
                bought: '40000000000000',
                sold: '0',
                holdsNow: '40000000000000',
                sales: [],
                complete: false,
              },
            },
          ],
        },
      },
    });
    const sales = glanceOf(report).items.find((i) => i.id === 'sales');
    expect(sales?.title).toMatch(/bought at least 4% of the supply/);
  });

  it('says burned supply without "still" or "so far"', () => {
    const report = solanaReport({
      holders: {
        ...base.holders,
        data: {
          ...base.holders.data,
          pooledShare: 0.95,
          setAside: [{ address: HOLDER, role: 'burn', share: 0.95 }],
        },
      },
    });
    const supply = glanceOf(report).items.find((i) => i.id === 'supply');
    expect(supply?.title).toBe(
      '95% of the supply is in the incinerator: only 5% is held outside it.',
    );
  });
});

describe('the model’s input', () => {
  it('gives no share or zero when no holder list was read', () => {
    const report = solanaReport({
      holders: {
        ...base.holders,
        completeness: 'partial',
        data: {
          ...base.holders.data,
          method: 'none',
          holderCount: null,
          top: [],
          concentration: { top1: 0, top10: 0 },
          creator: { address: CREATOR, balance: '0', ofSupply: 0, share: 0, tokenAccounts: 1 },
        },
      },
    });
    const text = renderReport(report);
    expect(text).toContain(
      'No holder list could be read: who holds it, and how much each holds, is not known.',
    );
    expect(text).not.toMatch(/largest holder 0\.00%/);
    expect(text).toContain('The creator’s own token accounts were read: it holds none of it.');
  });

  it('quotes a name chosen by the creator as data, and withholds one that reads as a verdict', () => {
    const report = solanaReport({
      mint: {
        ...base.mint,
        data: {
          ...base.mint.data!,
          metadata: { ...base.mint.data!.metadata!, name: 'SAFE 100x', symbol: 'SAFE' },
        },
      },
    });
    const text = renderReport(report);
    expect(text).toContain('Name (name withheld: it reads as a verdict or advice)');
    expect(findViolations(text.split('\n').find((l) => l.startsWith('Name '))!)).toEqual([]);
  });

  it('says the funded wallets were looked for in part when the read was partial', () => {
    const report = solanaReport({
      linkedWallets: {
        ...base.linkedWallets!,
        completeness: 'partial',
        data: { ...base.linkedWallets!.data, window: { from: 1795550000, to: 1795560000 } },
      },
    });
    expect(renderReport(report)).toContain(
      'Around the launch, the creator sent SOL to no other wallet outside its trades, in the transactions read (not all of them).',
    );
  });
});

describe('the text written without the model', () => {
  it('says what the creator did with the token could not be read, rather than nothing', () => {
    const report = solanaReport({
      creatorOnToken: { ...base.creatorOnToken!, completeness: 'unavailable' },
    });
    expect(offlineExplanation(report)).toContain(
      'What the dev did with this token could not be read this time.',
    );
  });

  it('counts the creator’s other tokens as a floor when pump.fun’s curves were not all listed', () => {
    const report = solanaReport({
      creatorHistory: {
        ...base.creatorHistory!,
        data: {
          ...base.creatorHistory!.data,
          counts: { launched: 4, graduated: 0, dead: 4, active: 0, unknown: 0 },
          scanned: { ...base.creatorHistory!.data.scanned, pumpCurvesListed: false },
        },
      },
    });
    expect(offlineExplanation(report)).toContain('The dev has at least 4 other launches');
  });
});

describe('claims the facts forbid', () => {
  const partialSales = solanaReport({
    creatorOnToken: {
      ...base.creatorOnToken!,
      completeness: 'partial',
      data: { ...base.creatorOnToken!.data, transactions: { listed: 16, read: 15 } },
    },
  });

  it('cuts "the creator has not sold" when not every move of the creator was read', () => {
    expect(findClaims('The creator has not sold this token.', partialSales)).toEqual([
      { kind: 'no-sale', sentence: 'The creator has not sold this token.' },
    ]);
  });

  it('keeps it when it says the read was partial, and on a complete read', () => {
    expect(
      findClaims('No sale by the creator was seen in the transactions read.', partialSales),
    ).toEqual([]);
    expect(findClaims('The creator has not sold this token.', base)).toEqual([]);
  });
});

describe('a read of the creator’s moves cut short (PYUSD on the public node, 0 of 2 read)', () => {
  const cut = solanaReport({
    creatorOnToken: {
      ...base.creatorOnToken!,
      completeness: 'partial',
      sources: [
        {
          name: 'solana-rpc',
          fetchedAt: base.collectedAt,
          note: 'transactions read up to 0: solana-rpc : request limit reached, retry in 10 s; 0 of 2 transactions read',
        },
      ],
      data: { ...base.creatorOnToken!.data, transactions: { listed: 2, read: 0 } },
    },
    creatorHistory: {
      ...base.creatorHistory!,
      completeness: 'partial',
      data: {
        ...base.creatorHistory!.data,
        scanned: {
          ...base.creatorHistory!.data.scanned,
          transactionsRead: 0,
          transactionsListed: 117,
        },
      },
    },
  });

  it('Creator History says no absence over transactions it did not read', () => {
    const finding = ask('creator-history', cut);
    const facts = finding.facts.join(' ');
    expect(facts).not.toMatch(/neither bought nor received/);
    expect(facts).not.toMatch(/in the 0 transactions/);
    expect(facts).toContain(
      'No other token by this creator was found on pump.fun’s curves; none of its own transactions could be read.',
    );
    expect(finding.measures?.creator?.hasSold).toBeNull();
  });

  it('the model reads "none seen", never "bought none"', () => {
    const text = renderReport(cut);
    expect(text).toContain(
      'Bought none seen in the transactions read (not all of them); sold none seen in the transactions read (not all of them)',
    );
    expect(text).not.toMatch(/Bought none;/);
  });

  it('the text without the model says whether it sold is not known', () => {
    const text = offlineExplanation(cut);
    expect(text).toContain(
      'None of the 2 transactions on the dev’s token accounts could be read this time: whether it sold is not known.',
    );
  });
});

describe('In short, after a launch replay that failed', () => {
  it('says what the creation slot got as a floor', () => {
    const report = solanaReport({
      failedReads: [
        { read: 'launch-replay', note: '59 of 60 transactions of the window could not be read' },
      ],
      launch: {
        ...base.launch,
        completeness: 'partial',
        data: {
          ...base.launch.data,
          sameSlot: {
            wallets: 2,
            share: 0.395,
            transactions: 2,
            heldNow: null,
            unread: 2,
            soldInWindow: 0,
            solSpent: 24.19,
            addresses: [],
          },
        },
      },
    });
    const item = glanceOf(report).items.find((i) => i.id === 'launch-buys');
    expect(item?.title).toBe(
      'In the creation slot, 2 wallets other than the creator got at least 39.5% of the supply.',
    );
  });
});

describe('the supply handed out at launch, after a replay that failed (JUP on the public node)', () => {
  const minted = (failed: boolean) =>
    solanaReport({
      ...(failed
        ? {
            failedReads: [
              { read: 'launch-replay' as const, note: '59 of 60 transactions could not be read' },
            ],
          }
        : {}),
      launchpad: { ...base.launchpad, data: { ...base.launchpad.data, launchpad: null } },
      graduation: null,
      launch: {
        ...base.launch,
        completeness: failed ? 'partial' : 'full',
        data: {
          ...base.launch.data,
          supply: '1000000000000000',
          launchBlock: 100,
          moves: [
            {
              kind: 'mint',
              seconds: 0,
              block: 0,
              actor: HOLDER,
              counterparty: '',
              actorKind: 'wallet',
              share: 1,
              actorIsCreator: false,
              counterpartyIsCreator: false,
              heldNow: null,
              transaction: 'x',
              amount: '1000000000000000',
              slot: 100,
              payer: HOLDER,
              quote: null,
            },
          ],
          movesInWindow: 1,
        },
      },
    });

  it('says the hand-out when the replay answered, outside any market', () => {
    const glance = glanceOf(minted(false));
    expect(glance.items.find((i) => i.id === 'flow')?.title).toBe(
      '100% handed to a wallet at launch, outside any market.',
    );
    expect(offlineExplanation(minted(false))).toContain(
      'No buy was read in the launch window: the supply was only handed out.',
    );
  });

  it('says no "nobody bought" when the replay failed', () => {
    const report = minted(true);
    expect(glanceOf(report).items.find((i) => i.id === 'flow')).toBeUndefined();
    expect(offlineExplanation(report)).not.toMatch(/only handed out|No buy was read/);
    expect(renderReport(report)).not.toContain('## Where the supply went at launch');
  });
});
