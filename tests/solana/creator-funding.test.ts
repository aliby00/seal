import { describe, expect, it } from 'vitest';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import { findFirstFunding, linkedWallets } from '../../src/lib/solana/funding';
import type { RecordedCall, SignatureInfo } from '../../src/lib/solana/rpc';
import { loadRecordings } from './fixtures';

/** A creator-zone recording (see creator.test.ts) and the clock it was made at. */
function creatorCase(slug: string) {
  const recordings: RecordedCall[] = loadRecordings('creator', [`${slug}.json`]);
  const clock = recordings.find((e) => e.method === 'clock')?.result as number;
  return { recordings, rpc: createFakeSolanaRpc(recordings), now: () => clock };
}

const SOLD = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
const SOLD_CREATOR = 'D234v6Hg5cYYmMkdvRdAdFYBBcLAP9Jcj3Uh2BQ8ChDH';
const BUNDLED = '6qmoWWfCw1uVMfPzRWkCEu4kLmT9F8d3MXDMexXkpump';
const BUNDLED_CREATOR = 'b5fbkVRNRTjZHgvQLU2QKyYUUBXEVgX7bwTc7eP5FGT';
const CURVE_TOKEN = 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump';
const CURVE_CREATOR = 'B7VKZzqyCJCJ12yu4AkVdaTvQjd3TSiUJMtCppGP38xg';

describe('linkedWallets', () => {
  it('finds who first paid the creator who sold everything, though no transfer instruction says so', async () => {
    const { rpc, now } = creatorCase('pump-creator-sold');
    const linked = await linkedWallets(SOLD_CREATOR, SOLD, rpc, { now, launchTime: 1795554868 });
    // Its first transaction, signed by 16hA8T…, took it from 0 to 5.63 SOL by
    // closing an account to it; the first System transfer to it came later:
    // 1 lamport of spam (28LKEsyk…).
    expect(linked.data.firstFunding).toEqual({
      from: '16hA8TwtLR1381TD4A6p3V279Dx27ocmiik8tGs6jrY',
      to: SOLD_CREATOR,
      lamports: '5626514133',
      how: 'balance-change',
      signature:
        '2YJWqr5T7RQPUZyjA2ZL9p3TcbYLosxJEYxvzCgjjewqsNg8h6qzP3di78K2sSBpaEuQ78PBmcjndzrZdiGdLXJe',
      slot: 471485897,
      blockTime: 1795123625,
    });
    expect(linked.data.funding).toBe('found');
    // The two transfers paid inside its sale (fees, a tip) are not wallets it funded.
    expect(linked.data.funded).toEqual([]);
    expect(linked.data.window).toEqual({ from: 1795554868 - 86_400, to: 1795554868 + 3_600 });
    expect(linked.completeness).toBe('partial');
    expect(linked.sources[0]?.note).toBe(
      "10 of the creator's 11 transactions around the launch read",
    );
  });

  it('lists the wallets the bundled launch’s creator funded the day before, each with its transaction', async () => {
    const { rpc, now } = creatorCase('pump-bundled');
    const linked = await linkedWallets(BUNDLED_CREATOR, BUNDLED, rpc, {
      now,
      launchTime: 1795557755,
    });
    expect(linked.data.firstFunding).toMatchObject({
      from: '78AeHrLbaP7ZYWyWwDa5txWtnSmHzo3JKsd98xGgN3Rc',
      lamports: '5000000000',
      how: 'system-transfer',
      signature:
        '267ywwqFXYax7fgk7Fs2VzNj3pdZvBCbrKr8Q1fycQm4KoHFcbWfALXuAXV7ET7KymM6iy4AKdbsMuEeJgvKA1K9',
    });
    expect(
      linked.data.funded.map((f) => [f.wallet, f.lamports, f.transfers[0]?.signature.slice(0, 10)]),
    ).toEqual([
      ['7NET2PzZ8JKMdoFn365nHpvSGbKxJacHF7SMRHnUj1Yd', '10000000000', '47tATrdryH'],
      ['7CLbtyYFWG45WQXxwQmkz4fmNCfFuojN8t4za6NVfMfH', '10000000000', '5nc3FhiSmZ'],
      ['9myc5T55sUQxGtFu7bRPxiuhatdk5U1y7vKT31p2E9cp', '10000000000', '3X3NcA6rXs'],
      ['3pLheGVtmHLe5xDpVXWLLPmcKquNLTGMEmzTofxLmoCC', '10000000000', 'N7rHAx15UB'],
      ['Ggnm2KVizsXedUrBJqjXtg8ztgCw3C5P6swVfSiFQ2SH', '10000000000', '3HhYSGCjRn'],
    ]);
    // The first three were read: none traded this token.
    expect(linked.data.funded.slice(0, 3).map((f) => f.onToken)).toEqual(
      Array(3).fill({ bought: '0', sold: '0', holdsNow: '0', sales: [], complete: true }),
    );
    expect(linked.data.funded.slice(3).map((f) => f.onToken)).toEqual([null, null]);
    expect(linked.completeness).toBe('partial');
    expect(linked.sources[0]?.note).toBe(
      "10 of the creator's 29 transactions around the launch read; trades of 2 funded wallets not read",
    );
  });

  it('reads the launch time from the creation when not given', async () => {
    const { rpc, now } = creatorCase('pump-curve');
    const linked = await linkedWallets(CURVE_CREATOR, CURVE_TOKEN, rpc, { now });
    expect(linked.data.window).toEqual({ from: 1795552482 - 86_400, to: 1795552482 + 3_600 });
    expect(linked.data.firstFunding).toMatchObject({
      from: '2UPzAimP45QrxJbp5GvxtGYSgdQ1yxYemL6oZrTgMt4s',
      lamports: '53593000',
      how: 'system-transfer',
    });
    expect(linked.data.funded).toEqual([]);
    expect(linked.completeness).toBe('full');
  });

  it('says unavailable when the creator’s transactions cannot be listed', async () => {
    const rpc = createFakeSolanaRpc([
      { method: 'getSignaturesForAddress', error: { code: 429, message: 'Too many requests' } },
    ]);
    const linked = await linkedWallets(SOLD_CREATOR, SOLD, rpc, { now: () => 0 });
    expect(linked.completeness).toBe('unavailable');
    expect(linked.data.funding).toBe('not-reached');
  });
});

describe('findFirstFunding', () => {
  const sig = (signature: string): SignatureInfo => ({
    signature,
    slot: 1,
    err: null,
    memo: null,
    blockTime: 1,
  });

  it('does not guess when the history was not listed to its start', async () => {
    const rpc = createFakeSolanaRpc([]);
    const found = await findFirstFunding(rpc, SOLD_CREATOR, [sig('a')], false);
    expect(found).toMatchObject({ funding: null, state: 'not-reached' });
    expect(rpc.calls).toEqual([]);
  });

  it('says how far it read when the cap stops it', async () => {
    const { rpc, recordings } = creatorCase('pump-creator-sold');
    const listed = recordings.find(
      (e) => e.method === 'getSignaturesForAddress' && e.params?.[0] === SOLD_CREATOR,
    )?.result as SignatureInfo[];
    // Without its first transaction the earliest left are the creator's own: none pays it.
    const found = await findFirstFunding(rpc, SOLD_CREATOR, listed.slice(0, -1), true, 2);
    expect(found).toEqual({
      funding: null,
      state: 'not-reached',
      note: "no SOL received in the creator's first 2 transactions",
    });
  });
});
