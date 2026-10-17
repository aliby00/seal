import { describe, expect, it } from 'vitest';
import type { LaunchMove, LaunchReplayData } from '../../src/lib/contracts/launch';
import { buildStory } from '../../src/lib/launch-story';

const move = (over: Partial<LaunchMove>): LaunchMove => ({
  kind: 'buy',
  seconds: 0,
  block: 0,
  actor: '0xa',
  counterparty: '0xpool',
  actorKind: 'wallet',
  share: 0.01,
  actorIsCreator: false,
  counterpartyIsCreator: false,
  heldNow: 0,
  transaction: '0x1',
  ...over,
});

const launch = (moves: LaunchMove[], movesInWindow = moves.length): LaunchReplayData => ({
  token: '0xt',
  launchBlock: 1,
  launchedAt: null,
  windowSeconds: 600,
  supply: '1',
  moves,
  movesInWindow,
});

describe('launch story', () => {
  it('tells what the creator took, how fast buyers came, and what they hold today', () => {
    const story = buildStory(
      launch([
        move({ kind: 'mint', actor: '0xpool', actorKind: 'pool', share: 1, heldNow: 0.5 }),
        move({ actor: '0xc', actorIsCreator: true, share: 0.15, transaction: '0x0' }),
        move({ actor: '0xa', seconds: 2, share: 0.05, heldNow: 0, transaction: '0x2' }),
        move({ actor: '0xb', seconds: 8, share: 0.04, heldNow: 0.02, transaction: '0x3' }),
        move({ actor: '0xe', seconds: 120, share: 0.1, heldNow: 0.1, transaction: '0x4' }),
        move({ kind: 'sell', actor: '0xc', actorIsCreator: true, seconds: 5, share: 0.15 }),
      ]),
    );
    expect(story.creatorAtLaunch).toBeCloseTo(0.15);
    expect(story.creatorSold).toBeCloseTo(0.15);
    // Only non-creator buys in the first minute are "first buyers".
    expect(story.early).toMatchObject({ wallets: 2, within: 8, unread: 0 });
    expect(story.early.share).toBeCloseTo(0.09);
    expect(story.early.heldNow).toBeCloseTo(0.02);
    expect(story.buyers.map((b) => b.address)).toEqual(['0xc', '0xa', '0xb', '0xe']);
    expect(story.curve.at(-1)).toMatchObject({ seconds: 600 });
    expect(story.curve.at(-1)!.bought).toBeCloseTo(0.34);
    expect(story.curve.at(-1)!.held).toBeCloseTo(0.12);
    expect(story.creatorSales).toEqual([{ seconds: 5, share: 0.15 }]);
    expect(story.bundle).toBeNull();
  });

  it('never counts an unread balance as zero', () => {
    const story = buildStory(launch([move({ heldNow: null, seconds: 3 })]));
    expect(story.early.heldNow).toBeNull();
    expect(story.early.unread).toBe(1);
  });

  it('finds the transaction that served many wallets at once', () => {
    const story = buildStory(
      launch(
        ['0xa', '0xb', '0xc', '0xd'].map((actor) =>
          move({ actor, block: 2, share: 0.06, transaction: '0xBUNDLE' }),
        ),
        448,
      ),
    );
    expect(story.bundle).toMatchObject({ transaction: '0xbundle', wallets: 4, seconds: 0 });
    expect(story.bundle!.share).toBeCloseTo(0.24);
    expect(story.partial).toBe(true);
  });
});
