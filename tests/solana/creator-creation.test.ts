import { describe, expect, it } from 'vitest';
import { withLaunchCreation } from '../../src/lib/solana/creator';
import type { SolanaCreator } from '../../src/lib/solana/creator-types';
import type { SolanaLaunchCreation } from '../../src/lib/solana/launch-types';

/**
 * The creator read squared with the creation the launch replay found. On
 * staging (25/11/2026) BONK, JUP and GOAT said "its creation was not reached"
 * next to the creation transaction the replay showed; the notes below are
 * the ones served then.
 */

const AT = '2026-11-25T10:39:00.000Z';

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const JUP_CREATION: SolanaLaunchCreation = {
  signature:
    '4h5iBF43PvG9SuKZyJiJ2mEUddsNd71uVW7X7Lz5RYzMJYqPeoPqLyNtz2fH9nd9FWKxqKXhmXtK3F9QqptzbZ',
  slot: 243989543,
  launchedAt: '2024-01-25T08:54:00.000Z',
  payer: 'JUPhop9E8ZfdJ5FNHhxQt4uAih822Vs4QpqsWcewFbq',
  signers: ['JUPhop9E8ZfdJ5FNHhxQt4uAih822Vs4QpqsWcewFbq'],
  foundBy: 'creation-time',
};
const JUP_CREATOR: SolanaCreator = {
  completeness: 'unavailable',
  sources: [
    {
      name: 'solana-rpc',
      fetchedAt: AT,
      note: 'the mint has more than 3000 transactions: its creation was not reached; the metadata update authority 61aq585V8cR2sZBeawJFt2NPqmN7zDi1sws4KLs5xHXV is a program address, not a wallet; no curve, creation transaction or metadata authority names a creator',
    },
  ],
  data: { mint: JUP, creator: null, from: null, account: null, creation: null, pumpCurve: null },
};

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_CREATOR = '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw';
const BONK_CREATION: SolanaLaunchCreation = {
  signature:
    '2K5X6HT9QZ8dcApbWL6mzYw6WBDvL5vWndTpGrFkQuMfuStGTP5LxPNQnnn5v5KR2T6UD1zEXnfCdajzUfuCPZgS',
  slot: 165714665,
  launchedAt: '2022-12-08T20:33:32.000Z',
  payer: BONK_CREATOR,
  signers: [BONK_CREATOR],
  foundBy: 'creation-time',
};
const BONK_READ: SolanaCreator = {
  completeness: 'partial',
  sources: [
    {
      name: 'solana-rpc',
      fetchedAt: AT,
      note: 'the mint has more than 3000 transactions: its creation was not reached',
    },
  ],
  data: {
    mint: BONK,
    creator: BONK_CREATOR,
    from: 'metadata-update-authority',
    account: null,
    creation: null,
    pumpCurve: null,
  },
};

describe('withLaunchCreation', () => {
  it('JUP: no longer says the creation was not reached, and says who paid for it', () => {
    const read = withLaunchCreation(JUP_CREATOR, JUP_CREATION);
    const note = read.sources[0]?.note ?? '';
    expect(note).not.toMatch(/not reached/);
    expect(note).not.toMatch(/creation transaction or metadata authority names/);
    expect(note).toContain('no curve or metadata authority names a creator');
    expect(note).toContain(
      'the creation transaction 4h5i…tzbZ, found by the launch replay, was paid for by JUPhop9E8ZfdJ5FNHhxQt4uAih822Vs4QpqsWcewFbq',
    );
    expect(note).toContain('61aq585V8cR2sZBeawJFt2NPqmN7zDi1sws4KLs5xHXV is a program address');
    // The payer is not made the creator: the creator's other reads ran without it.
    expect(read.data.creator).toBeNull();
    expect(read.completeness).toBe('unavailable');
  });

  it('BONK: the creator stays its metadata authority, and its creation is said found', () => {
    const read = withLaunchCreation(BONK_READ, BONK_CREATION);
    expect(read.sources[0]?.note).toBe(
      `its creation was found by the launch replay: transaction 2K5X…PZgS, paid for by ${BONK_CREATOR}`,
    );
    expect(read.data).toEqual(BONK_READ.data);
  });

  it('changes nothing when the replay found no creation, or the creator read had it', () => {
    expect(withLaunchCreation(JUP_CREATOR, null)).toBe(JUP_CREATOR);
    const reached: SolanaCreator = {
      ...BONK_READ,
      data: {
        ...BONK_READ.data,
        creation: {
          signature: BONK_CREATION.signature,
          slot: BONK_CREATION.slot,
          blockTime: null,
          feePayer: BONK_CREATOR,
          instruction: 'initialize-mint',
          launchpad: null,
        },
      },
    };
    expect(withLaunchCreation(reached, BONK_CREATION)).toBe(reached);
  });
});
