import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect } from '../../src/lib/collect';
import type { SolanaCreator } from '../../src/lib/solana/creator-types';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import type { SolanaLaunchCreation, SolanaLaunchReplay } from '../../src/lib/solana/launch-types';
import type { RecordedCall } from '../../src/lib/solana/rpc';
import { loadCollectRecording, NO_TIME_LIMIT } from './recording';

/**
 * The creator block of the report, squared with the creation the launch
 * replay found. On staging (25/11/2026) JUP, BONK and GOAT served "its
 * creation was not reached" in facts.creator.note, "Sources & limitations"
 * and the questions, next to the creation transaction the replay showed:
 * only the model's text and the offline one used withLaunchCreation. The
 * creator read and the launch replay are given here as staging read them;
 * every other read is refused by the node.
 */

const read = vi.hoisted(() => ({
  creator: null as SolanaCreator | null,
  launch: null as SolanaLaunchReplay | null,
}));

vi.mock('../../src/lib/solana/creator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/solana/creator')>()),
  findCreator: async () => read.creator,
}));
vi.mock('../../src/lib/solana/launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/solana/launch')>()),
  replayLaunch: async () => read.launch,
}));

afterEach(() => vi.unstubAllGlobals());

const AT = '2026-11-25T10:39:00.000Z';
const REFUSING: RecordedCall[] = [
  'getAccountInfo',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getTokenLargestAccounts',
  'getTokenAccountsByOwner',
  'getSignaturesForAddress',
  'getTransaction',
  'getSlot',
].map((method) => ({ method, error: { code: 429, message: 'Too many requests' } }));

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const JUP_PAYER = 'JUPhop9E8ZfdJ5FNHhxQt4uAih822Vs4QpqsWcewFbq';
const JUP_CREATION: SolanaLaunchCreation = {
  signature:
    '4h5iBF43PvG9SuKZyJiJ2mEUddsNd71uVW7X7Lz5RYzMJYqPeoPqLyNtz2fH9nd9FWKxqKXhmXtK3F9QqptzbZ',
  slot: 243989543,
  launchedAt: '2024-01-25T08:54:00.000Z',
  payer: JUP_PAYER,
  signers: [JUP_PAYER],
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

/** A launch replay that found `creation` (PYUSD's recorded block, its creation set). */
function replayFound(token: string, creation: SolanaLaunchCreation | null): SolanaLaunchReplay {
  const recorded = loadCollectRecording('pyusd').report.launch as SolanaLaunchReplay;
  return {
    completeness: 'partial',
    sources: [{ name: 'solana-rpc', fetchedAt: AT }],
    data: { ...recorded.data, token, creation },
  };
}

async function collectWith(token: string, creator: SolanaCreator, launch: SolanaLaunchReplay) {
  read.creator = creator;
  read.launch = launch;
  vi.stubGlobal('fetch', async () => new Response('busy', { status: 429 }));
  return collect(token, { rpc: createFakeSolanaRpc(REFUSING), deadlineMs: NO_TIME_LIMIT });
}

describe('collect: the creation the launch replay found', () => {
  it('JUP: the report no longer says its creation was not reached, and names who paid for it', async () => {
    const report = await collectWith(JUP, JUP_CREATOR, replayFound(JUP, JUP_CREATION));
    const note = report.creator.sources[0]?.note ?? '';
    expect(note).toContain(
      `the creation transaction 4h5i…tzbZ, found by the launch replay, was paid for by ${JUP_PAYER}`,
    );
    expect(note).not.toMatch(/creation transaction or metadata authority names/);
    // Nowhere in the report: facts, sources and questions are all read from it.
    expect(JSON.stringify(report)).not.toMatch(/creation was not reached/);
    expect(JSON.stringify(report.failedReads ?? [])).not.toMatch(/not reached/);
    // The payer is not made the creator.
    expect(report.creator.data.creator).toBeNull();
    expect(report.creator.completeness).toBe('unavailable');
  });

  it('BONK: the creator stays its metadata authority, its creation said found', async () => {
    const report = await collectWith(BONK, BONK_READ, replayFound(BONK, BONK_CREATION));
    expect(report.creator.sources[0]?.note).toBe(
      `its creation was found by the launch replay: transaction 2K5X…PZgS, paid for by ${BONK_CREATOR}`,
    );
    expect(report.creator.data).toEqual(BONK_READ.data);
    expect(JSON.stringify(report)).not.toMatch(/creation was not reached/);
  });

  it('keeps "not reached" when the launch replay did not find the creation either', async () => {
    const report = await collectWith(JUP, JUP_CREATOR, replayFound(JUP, null));
    expect(report.creator.sources[0]?.note).toBe(JUP_CREATOR.sources[0]?.note);
  });
});
