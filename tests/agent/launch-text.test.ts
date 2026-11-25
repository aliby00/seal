import { describe, expect, it } from 'vitest';
import type { LaunchMove, LaunchSummary } from '../../src/lib/contracts';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { renderLaunch } from '../../src/lib/agent/prompt';
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
