import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LaunchReplay } from '../../src/app/components/LaunchReplay';
import type { LaunchMove, LaunchReplayData, LaunchSummary } from '../../src/lib/contracts';

/**
 * The launch panel, rendered to HTML, on the figures staging served for JUP
 * (25/11/2026): a window of 295,183 seconds, the first buyers counted over 10
 * seconds, one later buyer of a dust share. It read "THE FIRST 4920 MINUTES"
 * and "0 wallets bought in these first 4920 minutes" above that buyer.
 */

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const BUYER = 'Fg85CHpeZFxpQ5thhgr3DcTP7HYsNuHWkrfWzAqiVqF8';

const move = (over: Partial<LaunchMove>): LaunchMove => ({
  kind: 'buy',
  seconds: 0,
  block: 0,
  actor: BUYER,
  counterparty: 'CbU4oSEGnLUoNP2GsT1KnF9UuMCVhhmL1RvdHLvSjeD8',
  actorKind: 'wallet',
  share: 0,
  actorIsCreator: false,
  counterpartyIsCreator: false,
  heldNow: null,
  transaction: 'tx',
  ...over,
});

const summary: LaunchSummary = {
  moves: 6,
  earlySeconds: 10,
  creatorAtLaunch: 0,
  creatorBought: 0,
  creatorSold: 0,
  creatorFirstBuyAt: null,
  creatorLastSaleAt: null,
  creatorTx: null,
  early: { wallets: 0, share: 0, within: 0, heldNow: null, unread: 0, contracts: 0 },
  bundle: null,
  receiptsRead: 6,
  receiptsWanted: 6,
  balancesRead: 1,
  balancesWanted: 1,
};

const jup: LaunchReplayData = {
  token: JUP,
  launchBlock: 243989543,
  launchedAt: '2024-01-25T08:54:00.000Z',
  windowSeconds: 295183,
  supply: '10000000000000000',
  moves: [
    move({ kind: 'mint', seconds: 84304, actorKind: 'contract', actor: JUP, share: 1 }),
    move({ seconds: 185952, share: 0.0000001, transaction: 'tx-buy' }),
  ],
  movesInWindow: 6,
  summary,
};

const html = (launch: LaunchReplayData) =>
  renderToStaticMarkup(createElement(LaunchReplay, { launch }));

describe('LaunchReplay', () => {
  it('counts the first buyers over the seconds they were counted on, not the whole window', () => {
    const out = html(jup);
    expect(out).toContain('addresses bought in the first 10 seconds');
    expect(out).not.toMatch(/wallets bought in these first/);
    // The later buyer is still listed, under its own heading.
    expect(out).toContain('The first buyers');
  });

  it('says a long window in hours or days, never in thousands of minutes', () => {
    expect(html(jup)).toContain('The first 3.4 days');
    expect(html(jup)).not.toMatch(/4920 minutes/);
    expect(html({ ...jup, windowSeconds: 7200 })).toContain('The first 2 hours');
    expect(html({ ...jup, windowSeconds: 300 })).toContain('The first 5 minutes');
    expect(html({ ...jup, windowSeconds: 40 })).toContain('The first 40 seconds');
  });

  it('draws no chart when nothing visible was bought', () => {
    expect(html(jup)).not.toContain('story-chart');
    const bought = {
      ...jup,
      moves: [...jup.moves, move({ seconds: 5, share: 0.2, transaction: 'tx-big', actor: JUP })],
    };
    expect(html(bought)).toContain('story-chart');
  });
});
