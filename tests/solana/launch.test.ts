import { describe, expect, it } from 'vitest';
import { isCompliant } from '../../src/lib/agent/guardrails';
import { createFakeSolanaRpc, MissingRecordingError } from '../../src/lib/solana/fake-rpc';
import { LAUNCH_MAX_CALLS, replayLaunch } from '../../src/lib/solana/launch';
import type { SolanaLaunchReplay } from '../../src/lib/solana/launch-types';
import { fakeRpcFor, loadRecordings } from './fixtures';

/**
 * Launch replays of real pump.fun tokens, from answers recorded on mainnet on
 * 24-25/11/2026 (tests/fixtures/solana/launch/). No call reaches the network.
 */

const BUNDLED = '6qmoWWfCw1uVMfPzRWkCEu4kLmT9F8d3MXDMexXkpump';
const BUNDLED_CREATOR = 'b5fbkVRNRTjZHgvQLU2QKyYUUBXEVgX7bwTc7eP5FGT';
const BUNDLED_CREATION =
  'M49A3kmyZVm8WgTyaESpkXP2xu2KESqVStmS4nXRYUxX1YSjWB9Y19qpBkRWHCozJuZzVSHAm7gaW4tMSxmVWrM';
const BIG_BUYER = '2Hf75pNqubdzQSNssssj7MoUeEyRSKpXUsSC25L7Agik';
const SOLD = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
const SOLD_CREATOR = 'D234v6Hg5cYYmMkdvRdAdFYBBcLAP9Jcj3Uh2BQ8ChDH';
const CURVE_MINT = 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump';
const CURVE_CREATOR = 'B7VKZzqyCJCJ12yu4AkVdaTvQjd3TSiUJMtCppGP38xg';
const CURVE_PAYER = 'F46pqf6cNywQqncHGPityWzw1BfZtr49oZwbBM5bDfpx';
const NORMAL = '2beKV42eqYiHsqxrsUE8oc7vM7gjdwG9HHrbwqE6pump';
/** Read from its pump.fun curve (creator field, bytes 49..81) on 25/11/2026. */
const NORMAL_CREATOR = '13fyniHwvSCnCefRsm7WW8tNrZ17WoLPPSG54zsFNaSm';
/** DexScreener's pairCreatedAt for its pump.fun pair, read 25/11/2026. */
const NORMAL_CREATED_AT = 1795488687;

/** Every sentence a reader sees: the story and the notes. */
function texts(replay: SolanaLaunchReplay): string[] {
  return [...replay.data.story.map((l) => l.text), ...replay.sources.map((s) => s.note ?? '')];
}

describe('replayLaunch on a bundled pump.fun launch (6qmo…pump)', () => {
  const read = () =>
    replayLaunch(BUNDLED, fakeRpcFor('launch', ['pump-bundled.json']), {
      creator: BUNDLED_CREATOR,
    });

  it('finds the creation from the creator’s token account', async () => {
    const replay = await read();
    expect(replay.data.creation).toEqual(
      expect.objectContaining({
        signature: BUNDLED_CREATION,
        slot: 473504636,
        payer: BUNDLED_CREATOR,
        foundBy: 'creator-account',
        launchedAt: '2026-11-24T22:02:35.000Z',
      }),
    );
    expect(replay.data.launchBlock).toBe(473504636);
    expect(replay.data.supply).toBe('1000000000000000');
    expect(replay.data.tokenProgram).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  });

  it('reads the first sixty transactions and says what they cover', async () => {
    const replay = await read();
    expect(replay.data.transactions).toEqual(
      expect.objectContaining({ wanted: 60, read: 60, withoutChange: 20, failed: 141 }),
    );
    expect(replay.data.windowSlots).toBe(15);
    expect(replay.data.windowSeconds).toBe(3);
    expect(replay.data.calls).toBeLessThanOrEqual(LAUNCH_MAX_CALLS);
    // Sixty transactions reach 3 seconds: the first ten seconds are not all read.
    expect(replay.completeness).toBe('partial');
    expect(replay.sources[0]?.note).toContain('the window read ends before 10 seconds');
  });

  it('the creator bought 2.1 % in the creation; four other wallets got 47.9 % in the same slot', async () => {
    const { data } = await read();
    expect(data.summary?.creatorAtLaunch).toBe(0.021);
    expect(data.summary?.creatorBought).toBe(0.021);
    expect(data.sameSlot).toEqual(
      expect.objectContaining({ wallets: 4, transactions: 5, share: 0.479015 }),
    );
    // 35 % for one wallet; 11.78 % for another, paid with 15 wrapped SOL (REFERENCE.json).
    expect(data.sameSlot?.addresses.slice(0, 2)).toEqual([
      BIG_BUYER,
      'mxc91JmAdJ1HDGniKc4KtEzao2hHs9RF1wKhMcS5XfF',
    ]);
  });

  it('the 35 % buyer sold it all three slots later', async () => {
    const { data } = await read();
    expect(data.roundTrips).toContainEqual({
      address: BIG_BUYER,
      boughtAt: 0,
      soldAt: 0,
      boughtSlot: 0,
      soldSlot: 3,
      // 349,999,999,999,991 units of 10^15: shares are floored to 1e-6.
      bought: 0.349999,
      sold: 0.349999,
    });
    expect(data.summary?.roundTrips?.wallets).toBe(6);
  });

  it('tells it in order, in plain facts', async () => {
    const replay = await read();
    const story = replay.data.story.map((l) => l.text);
    expect(story[0]).toBe(
      'The token was created in transaction M49A…VWrM, paid for by the creator b5fb…5FGT.',
    );
    expect(story).toContain('The creator bought 2.1% of the supply in the creation transaction.');
    expect(story).toContain('2Hf7…Agik sold 35.0% of the supply 3 slots after buying 35.0%.');
    const slots = replay.data.story.map((l) => l.slot);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    for (const text of texts(replay)) expect(isCompliant(text), text).toBe(true);
    expect(texts(replay).join(' ')).not.toMatch(/sniper|bundle|insider|scam|rug|safe/i);
  });

  it('what the buyers hold today is read in the token accounts they used', async () => {
    const { data } = await read();
    expect(data.summary?.balancesRead).toBe(data.summary?.balancesWanted);
    // The creator still holds 6,949,733.952555 tokens there: 0.69 %.
    const creatorMove = data.moves.find((m) => m.actorIsCreator);
    expect(creatorMove?.heldNow).toBe(0.006949);
    expect(data.sameSlot?.heldNow).toBe(0);
  });
});

describe('the same launch without the creator', () => {
  it('finds the creation from the whole history and reads the same window', async () => {
    const rpc = fakeRpcFor('launch', ['pump-bundled.json', 'pump-bundled-history.json']);
    const plain = await replayLaunch(BUNDLED, rpc);
    const withCreator = await replayLaunch(BUNDLED, fakeRpcFor('launch', ['pump-bundled.json']), {
      creator: BUNDLED_CREATOR,
    });
    expect(plain.data.creation?.foundBy).toBe('history');
    expect(plain.data.creation?.signature).toBe(BUNDLED_CREATION);
    const strip = (r: SolanaLaunchReplay) =>
      r.data.moves.map(({ kind, actor, amount, transaction }) => ({
        kind,
        actor,
        amount,
        transaction,
      }));
    // Paged from the newest, or bounded by a block after the creation: the same transactions.
    expect(strip(plain)).toEqual(strip(withCreator));
    expect(plain.data.transactions.wholeHistory).toBe(true);
    // Without a creator, the fee payer's own buy is told as such.
    expect(plain.data.story.map((l) => l.text)).toContain(
      'The fee payer bought 2.1% of the supply in the creation transaction.',
    );
  });

  it('with one page of history allowed, the creation is out of reach and says so', async () => {
    const replay = await replayLaunch(
      BUNDLED,
      fakeRpcFor('launch', ['pump-bundled.json', 'pump-bundled-history.json']),
      { maxPages: 1 },
    );
    expect(replay.completeness).toBe('unavailable');
    expect(replay.data.creation).toBeNull();
    expect(replay.sources[0]?.note).toBe(
      'the token has more than 1,000 transactions: its creation lies beyond those read',
    );
  });
});

describe('replayLaunch on a creator who bought at launch (FB5e…pump)', () => {
  it('the creator bought 11.9 % for 3.80 SOL; two wallets took 39.5 % in the same slot', async () => {
    const replay = await replayLaunch(SOLD, fakeRpcFor('launch', ['pump-creator-sold.json']), {
      creator: SOLD_CREATOR,
      maxTransactions: 30,
    });
    const { data } = replay;
    expect(data.creation?.foundBy).toBe('creator-account');
    // 119,064,729,176,629 units at launch (REFERENCE.json).
    const buy = data.moves.find((m) => m.actorIsCreator && m.kind === 'buy');
    expect(buy?.amount).toBe('119064729176629');
    expect(buy?.quote).toEqual({ asset: 'SOL', amount: '3800682951', decimals: 9 });
    expect(data.summary?.creatorAtLaunch).toBe(0.119064);
    expect(data.sameSlot).toEqual(expect.objectContaining({ wallets: 2, share: 0.395332 }));
    // Its sale came at slot 473494427, far beyond the 30 transactions read.
    expect(data.summary?.creatorSold).toBe(0);
    expect(data.transactions.wanted).toBe(30);
    expect(data.story.map((l) => l.text)).toContain(
      'The creator bought 11.9% of the supply in the creation transaction for 3.80 SOL, fees included.',
    );
  });
});

describe('replayLaunch on a launch paid by one wallet for ten others (ANDL…pump)', () => {
  it('names the fee payer’s transactions and the one that served three wallets', async () => {
    const replay = await replayLaunch(CURVE_MINT, fakeRpcFor('launch', ['pump-curve.json']), {
      creator: CURVE_CREATOR,
      maxTransactions: 20,
    });
    const { data } = replay;
    // The creator never bought: its token account has no history, the mint's is read whole.
    expect(data.creation?.foundBy).toBe('history');
    expect(data.creation?.payer).toBe(CURVE_PAYER);
    expect(data.creation?.signers).toContain(CURVE_CREATOR);
    expect(data.payerGroup).toEqual(
      expect.objectContaining({ payers: [CURVE_PAYER], transactions: 4, wallets: 10 }),
    );
    expect(data.payerGroup?.share).toBeCloseTo(0.65, 2);
    expect(data.summary?.creatorTx).toEqual(
      expect.objectContaining({
        transaction: data.creation?.signature,
        addresses: 1,
        share: 0.060565,
      }),
    );
    expect(data.summary?.bundle).toEqual(expect.objectContaining({ wallets: 3, share: 0.2098 }));
    expect(data.summary?.creatorAtLaunch).toBe(0);
    expect(data.story.map((l) => l.text)).toContain(
      'F46p…Dfpx, who paid for the creation, paid for 4 transactions (the creation among them) that delivered 65.0% of the supply to 10 wallets other than the creator.',
    );
  });
});

describe('replayLaunch on a token with a long history (2beK…pump)', () => {
  it('reads from the creation time given when the history is too long to page', async () => {
    const replay = await replayLaunch(NORMAL, fakeRpcFor('launch', ['pump-normal.json']), {
      creator: NORMAL_CREATOR,
      createdAt: NORMAL_CREATED_AT,
    });
    const { data } = replay;
    expect(data.creation).toEqual(
      expect.objectContaining({
        foundBy: 'creation-time',
        slot: 473183460,
        payer: 'AYEHKbGooTCishm755ArC88YZPJ29Rfh3b4q2hpyJPAQ',
      }),
    );
    expect(data.transactions).toEqual(expect.objectContaining({ read: 60, failed: 310 }));
    expect(data.sameSlot).toEqual(expect.objectContaining({ wallets: 6, share: 0.239675 }));
    expect(data.calls).toBeLessThanOrEqual(LAUNCH_MAX_CALLS);
    expect(data.story.map((l) => l.text)).toContain(
      "The creation's fee payer AYEH…JPAQ got 9.8% of the supply in it.",
    );
  });

  it('without that time, the history read is not enough and it says so', async () => {
    // Its creator never bought: its token account has no history either.
    const replay = await replayLaunch(NORMAL, fakeRpcFor('launch', ['pump-normal.json']), {
      creator: NORMAL_CREATOR,
      maxPages: 1,
    });
    expect(replay.completeness).toBe('unavailable');
    expect(replay.data.creation).toBeNull();
    expect(replay.sources[0]?.note).toContain('more than 1,000 transactions');
  });
});

describe('limits', () => {
  it('stops at the allowance of calls and says the replay is partial', async () => {
    const replay = await replayLaunch(
      BUNDLED,
      fakeRpcFor('launch', ['pump-bundled.json', 'pump-bundled-limits.json']),
      {
        creator: BUNDLED_CREATOR,
        maxCalls: 20,
      },
    );
    expect(replay.data.calls).toBeLessThanOrEqual(20);
    expect(replay.completeness).toBe('partial');
    expect(replay.data.transactions.read).toBeLessThan(60);
    expect(replay.sources.map((s) => s.note).join(' ')).toContain('allowance of calls');
  });

  it('stops when time runs out', async () => {
    let clock = 0;
    const replay = await replayLaunch(
      BUNDLED,
      fakeRpcFor('launch', ['pump-bundled.json', 'pump-bundled-limits.json']),
      {
        creator: BUNDLED_CREATOR,
        deadlineMs: 10_000,
        // Each look at the clock moves it one second on.
        now: () => (clock += 1_000),
      },
    );
    expect(replay.completeness).toBe('partial');
    expect(replay.data.transactions.read).toBeLessThan(60);
    expect(replay.sources.map((s) => s.note).join(' ')).toContain('time allowed');
  });

  it('a transaction the node refuses leaves the replay partial', async () => {
    const refused = loadRecordings('launch', ['pump-bundled.json']).find(
      (e) => e.method === 'getTransaction' && String(e.params?.[0]).startsWith('3NVtiBTE'),
    );
    const rpc = createFakeSolanaRpc([
      {
        method: 'getTransaction',
        params: refused?.params,
        error: { code: 429, message: 'Too many requests' },
      },
      ...loadRecordings('launch', ['pump-bundled.json', 'pump-bundled-limits.json']),
    ]);
    const replay = await replayLaunch(BUNDLED, rpc, { creator: BUNDLED_CREATOR });
    expect(replay.data.transactions.read).toBe(59);
    expect(replay.sources[0]?.note).toContain(
      '1 of 60 transactions of the window could not be read',
    );
  });

  it('a call nobody recorded is a bug, and is thrown', async () => {
    await expect(
      replayLaunch(BUNDLED, createFakeSolanaRpc([]), { creator: BUNDLED_CREATOR }),
    ).rejects.toBeInstanceOf(MissingRecordingError);
  });

  it('refuses what is not an address, without a call', async () => {
    const rpc = createFakeSolanaRpc([]);
    const replay = await replayLaunch('0xnotanaddress', rpc);
    expect(replay.completeness).toBe('unavailable');
    expect(rpc.calls).toHaveLength(0);
  });
});
