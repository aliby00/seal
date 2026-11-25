import { describe, expect, it } from 'vitest';
import type { LaunchMove, LaunchSummary } from '../../src/lib/contracts';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { renderLaunch, renderSolanaBlocks } from '../../src/lib/agent/prompt';
import { answerAll } from '../../src/lib/specialists/brief';
import { findViolations } from '../../src/lib/agent/guardrails';
import { solanaReport } from '../helpers/solana-report';

/**
 * What SEAL writes about a launch, on the figures staging served for BONK
 * and AskGrok (25/11/2026): transfers are said as transfers, a sum of
 * purchases as a sum of purchases.
 */

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_CREATOR = '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw';
const ESCROW = 'AqYCkrLuuVqRjehq58KjZkPgBnxnDmreZo3Dh6w2xmM4';

const base = solanaReport();

function summary(over: Partial<LaunchSummary> = {}): LaunchSummary {
  return {
    moves: 25,
    earlySeconds: 10,
    creatorAtLaunch: 1,
    creatorBought: 0,
    creatorSold: 0,
    creatorFirstBuyAt: null,
    creatorLastSaleAt: null,
    creatorTx: null,
    early: { wallets: 0, share: 0, within: 0, heldNow: null, unread: 0, contracts: 0 },
    bundle: null,
    receiptsRead: 30,
    receiptsWanted: 30,
    balancesRead: 1,
    balancesWanted: 1,
    ...over,
  };
}

const lockMove: LaunchMove = {
  kind: 'allocation',
  seconds: 621148,
  block: 1404584,
  actor: ESCROW,
  counterparty: BONK_CREATOR,
  actorKind: 'contract',
  share: 0.009547,
  actorIsCreator: false,
  counterpartyIsCreator: true,
  heldNow: null,
  transaction:
    '3LEjgMEm5nFQjJcdY7ThC61RJ1MvAhE89P77Bw5pqk9k8232b3XTD7CFtWumBa1AMFUHUxXKw2Ejezy2DJJoyWGE',
  lock: 'Streamflow',
};

function withSummary(s: LaunchSummary) {
  return solanaReport({ launch: { ...base.launch, data: { ...base.launch.data, summary: s } } });
}

describe('the creator’s transfers are not sales', () => {
  const sent = summary({ creatorSent: 0.200786, creatorLocked: 0.190952 });

  it('renderLaunch: transferred, with nothing paid back, and through which lock', () => {
    const text = renderLaunch({
      sources: [],
      data: {
        token: BONK,
        launchBlock: 165714665,
        launchedAt: '2022-12-08T20:33:32.000Z',
        windowSeconds: 1039042,
        supply: '10000000000000000000',
        moves: [lockMove],
        movesInWindow: 25,
        summary: sent,
      },
    }).join('\n');
    expect(text).toContain('and sold back 0.00% in the window');
    expect(text).toContain(
      'The creator also transferred 20.08% of the supply to other addresses with no payment read in return, 19.10% of it into or out of a lock or vesting program. These are transfers, not sales',
    );
    expect(text).toContain(
      `0.955% transferred, with no payment read in return, to ${ESCROW} (program account), received from the creator, through Streamflow (a lock or vesting program)`,
    );
    expect(text).not.toMatch(/sold back 20/);
  });

  it('offline: says the transfers, never a sale', () => {
    const out = offlineExplanation(withSummary(sent));
    expect(out).toContain(
      'the creator transferred 20.1 % of the supply to other addresses with no payment read in return (19.1 % of it into or out of a lock or vesting program): transfers, not sales',
    );
    expect(out).not.toMatch(/creator (sold|selling)/);
    expect(findViolations(out)).toEqual([]);
  });
});

describe('the first buyers: a sum of purchases, and what they hold today', () => {
  // AskGrok (6qmo…pump) on staging: 24 addresses, 94.3 % bought in all within 3 s, none of it held today.
  const early = summary({
    earlySeconds: 3,
    creatorAtLaunch: 0.021,
    early: { wallets: 24, share: 0.94337, within: 3, heldNow: 0, unread: 0, contracts: 0 },
  });

  it('offline: a total across their purchases, with what they still hold', () => {
    const out = offlineExplanation(withSummary(early));
    expect(out).toContain(
      'in the first 3 seconds, 24 addresses other than the creator bought a total of 94.3 % of the supply across their purchases, and hold none of it today',
    );
    expect(out).not.toMatch(/addresses other than the creator bought 94\.3 %/);
  });

  it('offline: an unread holding is not said', () => {
    const out = offlineExplanation(
      withSummary(summary({ early: { ...early.early, heldNow: null, unread: 24 } })),
    );
    expect(out).toContain('bought a total of 94.3 % of the supply across their purchases.');
  });
});

describe('what the creator paid for its buys, said only for what SOL paid', () => {
  // AskGrok's creator (b5fb…FGT): 2.79 % bought, 2.10 % of it at launch paid in SPCX.
  const onToken = (over: { bought: string; boughtForSol?: string; solSpent: string }) =>
    solanaReport({
      creatorOnToken: base.creatorOnToken && {
        ...base.creatorOnToken,
        data: { ...base.creatorOnToken.data, ...over },
      },
    });

  it('offline: the SOL price for the part SOL paid, the rest said as paid in another token', () => {
    const out = offlineExplanation(
      onToken({ bought: '27949733952554', boughtForSol: '6949733952554', solSpent: '1002345678' }),
    );
    expect(out).toContain(
      'It bought 2.8% of the supply (0.69% for 1.00 SOL, the rest paid in another token than SOL).',
    );
    expect(out).not.toMatch(/2\.8% of the supply for/);
  });

  it('offline: no SOL price at all when no buy was paid in SOL', () => {
    const out = offlineExplanation(
      onToken({ bought: '21000000000000', boughtForSol: '0', solSpent: '0' }),
    );
    expect(out).toContain('It bought 2.1% of the supply (paid in another token than SOL).');
  });

  it('offline: a price as before when every buy was paid in SOL', () => {
    const out = offlineExplanation(onToken({ bought: '21000000000000', solSpent: '500000000' }));
    expect(out).toContain('It bought 2.1% of the supply for 0.5000 SOL.');
  });

  it('prompt: the same, for the model', () => {
    const report = onToken({
      bought: '27949733952554',
      boughtForSol: '6949733952554',
      solSpent: '1002345678',
    });
    const text = renderSolanaBlocks(report).join('\n');
    expect(text).toContain(
      'Bought 2.8% of the supply (0.69% of the supply for 1.00 SOL, the rest paid in another token than SOL);',
    );
  });

  it('creator-history: the same in the question’s facts', () => {
    const report = onToken({
      bought: '27949733952554',
      boughtForSol: '6949733952554',
      solSpent: '1002345678',
    });
    const answer = answerAll({ token: report.token, report }).find(
      (a) => a.specialist === 'creator-history',
    );
    expect(answer?.facts.join(' ')).toContain(
      'bought 2.8% of the supply (0.69% for 1.00 SOL, the rest paid in another token than SOL)',
    );
  });
});
