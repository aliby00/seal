import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../../src/lib/errors';
import { BudgetExhaustedError } from '../../src/lib/http';
import {
  CREATION_SIGNATURE_PAGES,
  creationsIn,
  creatorHistory,
  creatorOnToken,
  decodeMetadataAuthority,
  decodePumpCurve,
  DEFAULT_CREATOR_CALLS,
  dexPairsUrl,
  dexTokensUrl,
  findCreator,
  isReadFailure,
  limitRpc,
  marketsIn,
  ownerDeltas,
  ReadCapError,
  sendsOf,
  share6,
  signersOf,
  solChange,
  systemTransfers,
  tokenOutcome,
  type DexFetch,
} from '../../src/lib/solana/creator';
import { linkedWallets } from '../../src/lib/solana/funding';
import {
  createFakeSolanaRpc,
  MissingRecordingError,
  recordingKey,
} from '../../src/lib/solana/fake-rpc';
import {
  metadataAddress,
  pumpBondingCurveAddress,
  PUMP_FUN_PROGRAM,
} from '../../src/lib/solana/programs';
import type { AccountInfo, RecordedCall, SolanaTransaction } from '../../src/lib/solana/rpc';
import { loadRecordings } from './fixtures';

/**
 * The creator zone's recordings (tests/fixtures/solana/creator/<slug>.json),
 * read on mainnet on 24/11/2026 through the public node and DexScreener by a
 * recorder kept outside the repository. Each file also holds the clock of its
 * recording (`clock`) and DexScreener's answers (`dexscreener`, params [url]).
 */
function creatorCase(slug: string) {
  const recordings: RecordedCall[] = loadRecordings('creator', [`${slug}.json`]);
  const rpc = createFakeSolanaRpc(recordings);
  const clock = recordings.find((e) => e.method === 'clock')?.result as number;
  const answers = new Map(
    recordings
      .filter((e) => e.method === 'dexscreener')
      .map((e) => [String(e.params?.[0]), e.result]),
  );
  const dexAsked: string[] = [];
  const dex: DexFetch = async (url) => {
    dexAsked.push(url);
    if (!answers.has(url)) throw new Error(`no DexScreener recording for ${url}`);
    return structuredClone(answers.get(url));
  };
  const transaction = (signature: string) =>
    recordings.find((e) => e.method === 'getTransaction' && e.params?.[0] === signature)
      ?.result as SolanaTransaction;
  const account = (address: string) => {
    for (const e of recordings) {
      if (e.method !== 'getMultipleAccounts') continue;
      const i = (e.params?.[0] as string[]).indexOf(address);
      if (i >= 0) return (e.result as { value: (AccountInfo | null)[] }).value[i] ?? null;
    }
    return null;
  };
  return { recordings, rpc, now: () => clock, clock, dex, dexAsked, transaction, account };
}

const repeated = (calls: readonly { method: string; params: unknown[] }[]) => {
  const seen = new Set<string>();
  return calls
    .map((c) => recordingKey(c.method, c.params))
    .filter((k) => seen.has(k) || !seen.add(k));
};

// Reference tokens (tests/fixtures/solana/REFERENCE.md).
const SOLD = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
const SOLD_CREATOR = 'D234v6Hg5cYYmMkdvRdAdFYBBcLAP9Jcj3Uh2BQ8ChDH';
const SOLD_CREATION =
  '5Rftux227E8C37AFjXqDFkoqDvd15tTGAeqD4pk8PubLmuZfNCUtydsBh6coFiVQc1V9NxaxtM4Cpd8YGKjTvico';
const SOLD_SALE =
  '2gzY9HcNCX7DpifJxFoXzNd9uxLyxmRj88FWtHyr3porps64Qo5LQEa1NV8Timp2LbvMn47CLEowDxCpqsxQC9J2';
const SOLD_CURVE = 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2';
const BUNDLED = '6qmoWWfCw1uVMfPzRWkCEu4kLmT9F8d3MXDMexXkpump';
const BUNDLED_CREATOR = 'b5fbkVRNRTjZHgvQLU2QKyYUUBXEVgX7bwTc7eP5FGT';
const CURVE_TOKEN = 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump';
const CURVE_CREATOR = 'B7VKZzqyCJCJ12yu4AkVdaTvQjd3TSiUJMtCppGP38xg';
const CURVE_PAYER = 'F46pqf6cNywQqncHGPityWzw1BfZtr49oZwbBM5bDfpx';
const METEORA = '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('decoding what the chain wrote', () => {
  it('reads the creator and the graduation from a pump.fun curve', () => {
    const { account } = creatorCase('pump-creator-sold');
    expect(decodePumpCurve(account(SOLD_CURVE))).toEqual({
      complete: false,
      creator: SOLD_CREATOR,
    });
    // Graduated: the curve of 9AiHB952…, listed by getProgramAccounts on its creator.
    const { recordings } = creatorCase('pump-bundled');
    const listed = recordings.find((e) => e.method === 'getProgramAccounts')?.result as {
      pubkey: string;
      account: AccountInfo;
    }[];
    const graduated = listed.find(
      (a) => a.pubkey === '4aKGe5mSjyRYcGvx8zUWxZgRvds6ouRmGWBVxhpGEN59',
    );
    expect(decodePumpCurve(graduated?.account ?? null)).toEqual({
      complete: true,
      creator: BUNDLED_CREATOR,
    });
  });

  it('refuses an account that is not a pump.fun curve', () => {
    const { account } = creatorCase('usdc');
    expect(decodePumpCurve(account(metadataAddress(USDC)))).toBeNull();
    expect(decodePumpCurve(null)).toBeNull();
    const curve = creatorCase('pump-creator-sold').account(SOLD_CURVE) as AccountInfo;
    expect(
      decodePumpCurve({ ...curve, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }),
    ).toBeNull();
  });

  it('reads the update authority of a Metaplex metadata account that names the mint', () => {
    const { account } = creatorCase('usdc');
    const meta = account(metadataAddress(USDC));
    expect(decodeMetadataAuthority(meta, USDC)).toBe(
      '2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9',
    );
    // The same account read for another mint names nobody.
    expect(decodeMetadataAuthority(meta, SOLD)).toBeNull();
  });

  it('recognises a pump.fun create_v2 and the mint it initialises', () => {
    const tx = creatorCase('pump-creator-sold').transaction(SOLD_CREATION);
    const [creation] = creationsIn(tx, SOLD_CREATION);
    expect(creation).toMatchObject({
      mint: SOLD,
      instruction: 'pump-create-v2',
      launchpad: 'pump.fun',
      creator: SOLD_CREATOR,
      feePayer: SOLD_CREATOR,
      curve: SOLD_CURVE,
      decimals: 6,
      name: 'The Poor Bull',
      symbol: 'PoorBull',
      slot: 473491200,
      blockTime: 1795554868,
    });
  });

  it('tells the creator named by pump.fun from the fee payer', () => {
    const { transaction } = creatorCase('pump-curve');
    const signature =
      '2bp2ZKVjB9Zw9NWGNkAkXwGEMv13ecd4Hd1EMPDFtw3S51eCtsHjzLoFjxyycppzacmvmjjsv8uF53dxYEmWetv6';
    const tx = transaction(signature);
    const [creation] = creationsIn(tx, signature);
    expect(creation?.creator).toBe(CURVE_CREATOR);
    expect(creation?.feePayer).toBe(CURVE_PAYER);
    expect(signersOf(tx)).toContain(CURVE_CREATOR);
  });

  it('recognises a plain InitializeMint2 outside any launchpad (Meteora DBC)', () => {
    const signature =
      'iHeYqyqcsa9mqRQeeADaYsd59eZSM96dBsVEc8tTgW9AzuXtGz9iEY9ZXne3Heu7gNz7hjXD4TSb3RL4Hhp5d4u';
    const tx = creatorCase('meteora-dbc').transaction(signature);
    expect(creationsIn(tx, signature)).toEqual([
      expect.objectContaining({
        mint: METEORA,
        instruction: 'initialize-mint2',
        launchpad: null,
        creator: null,
        decimals: 6,
        feePayer: '9kZ2UPtdbqnbwHWtAYt2wTK9nzC2pYQZHe3DvFrCkbuo',
      }),
    ]);
  });

  it('reads System transfers, balance changes and markets of a sale', () => {
    const { transaction } = creatorCase('pump-creator-sold');
    const creation = transaction(SOLD_CREATION);
    // The launch buy paid the curve 3.744 SOL from inside pump.fun.
    expect(systemTransfers(creation)).toContainEqual({
      from: SOLD_CREATOR,
      to: SOLD_CURVE,
      lamports: 3744427934n,
      inner: true,
    });
    const sale = transaction(SOLD_SALE);
    expect(marketsIn(sale)).toEqual([PUMP_FUN_PROGRAM]);
    const deltas = ownerDeltas(sale, SOLD);
    expect(deltas.get(SOLD_CREATOR)).toBe(-119064729176629n);
    expect(deltas.get(SOLD_CURVE)).toBe(119064729176629n);
    expect(solChange(sale, SOLD_CREATOR)).toBe(4000115037n);
  });

  it('builds the dexscreener URLs, 30 addresses a call at most', () => {
    expect(dexTokensUrl([SOLD, BUNDLED])).toBe(
      `https://api.dexscreener.com/tokens/v1/solana/${SOLD},${BUNDLED}`,
    );
    expect(dexPairsUrl([SOLD_CURVE])).toBe(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${SOLD_CURVE}`,
    );
  });

  it('rounds shares to six places, and has none without a supply', () => {
    expect(share6(119064729176629n, 1000000000000000n)).toBe(0.119064);
    expect(share6(1n, null)).toBeNull();
    expect(share6(1n, 0n)).toBeNull();
  });
});

describe('findCreator', () => {
  it('reads the creator of the token whose creator sold everything from its curve', async () => {
    const { rpc, now } = creatorCase('pump-creator-sold');
    const found = await findCreator(SOLD, rpc, { now });
    expect(found.completeness).toBe('full');
    expect(found.sources).toEqual([
      { name: 'solana-rpc', fetchedAt: new Date(now()).toISOString() },
    ]);
    expect(found.data).toMatchObject({
      mint: SOLD,
      creator: SOLD_CREATOR,
      from: 'pump-curve',
      account: SOLD_CURVE,
      pumpCurve: { address: SOLD_CURVE, complete: false },
      creation: {
        signature: SOLD_CREATION,
        instruction: 'pump-create-v2',
        feePayer: SOLD_CREATOR,
        name: 'The Poor Bull',
      },
    });
    // The creation came from the creator's token account: the mint's 2,000+
    // signatures were not listed.
    expect(
      rpc.calls.filter((c) => c.params[0] === SOLD && c.method === 'getSignaturesForAddress'),
    ).toEqual([]);
    expect(rpc.calls.length).toBeLessThanOrEqual(3);
  });

  it('names the curve creator, not the fee payer, when someone else paid', async () => {
    const { rpc, now } = creatorCase('pump-curve');
    const found = await findCreator(CURVE_TOKEN, rpc, { now });
    expect(found.completeness).toBe('full');
    expect(found.data.creator).toBe(CURVE_CREATOR);
    expect(found.data.from).toBe('pump-curve');
    expect(found.data.creation?.feePayer).toBe(CURVE_PAYER);
    // The creator bought nothing at launch: the creation was found among its own transactions.
    expect(
      rpc.calls.filter(
        (c) => c.params[0] === CURVE_TOKEN && c.method === 'getSignaturesForAddress',
      ),
    ).toEqual([]);
  });

  it('falls back to the fee payer of the creation outside pump.fun', async () => {
    const { rpc, now } = creatorCase('meteora-dbc');
    const found = await findCreator(METEORA, rpc, { now });
    expect(found.completeness).toBe('full');
    expect(found.data).toMatchObject({
      creator: '9kZ2UPtdbqnbwHWtAYt2wTK9nzC2pYQZHe3DvFrCkbuo',
      from: 'creation-transaction',
      account: null,
      pumpCurve: null,
      creation: { instruction: 'initialize-mint2', launchpad: null, slot: 473493022 },
    });
  });

  it('falls back to the metadata update authority when the creation is out of reach, and says so', async () => {
    const { rpc, now } = creatorCase('usdc');
    const found = await findCreator(USDC, rpc, { now, signaturePages: 1 });
    expect(found.completeness).toBe('partial');
    expect(found.data).toMatchObject({
      creator: '2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9',
      from: 'metadata-update-authority',
      account: metadataAddress(USDC),
      creation: null,
    });
    expect(found.sources[0]?.note).toBe(
      'the mint has more than 1000 transactions: its creation was not reached',
    );
    expect(CREATION_SIGNATURE_PAGES).toBe(3);
  });

  it('says unavailable, without throwing, when the node fails', async () => {
    const rpc = createFakeSolanaRpc([
      { method: 'getMultipleAccounts', error: { code: 429, message: 'Too many requests' } },
      { method: 'getSignaturesForAddress', error: { code: 429, message: 'Too many requests' } },
      { method: 'getAccountInfo', error: { code: 429, message: 'Too many requests' } },
    ]);
    const found = await findCreator(SOLD, rpc, { now: () => 0 });
    expect(found.completeness).toBe('unavailable');
    expect(found.data.creator).toBeNull();
    expect(found.sources[0]?.note).toContain('curve and metadata not read');
  });
});

describe('creatorHistory', () => {
  it('lists the creator’s other pump.fun launch, graduated, and says what it did not read', async () => {
    const { rpc, now, dex } = creatorCase('pump-bundled');
    const history = await creatorHistory(BUNDLED_CREATOR, rpc, { now, dex, exclude: BUNDLED });
    expect(history.data.tokens).toEqual([
      {
        mint: '9AiHB952pXVrHuct9m3RKWoWv4LG52p58FYjMvUkpump',
        launchpad: 'pump.fun',
        signature: null,
        slot: null,
        launchedAt: null,
        curve: '4aKGe5mSjyRYcGvx8zUWxZgRvds6ouRmGWBVxhpGEN59',
        outcome: 'graduated',
        trades24h: 303,
        foundBy: ['pump-curves'],
      },
    ]);
    // Every mint matched to a curve is checked by deriving the curve back.
    expect(pumpBondingCurveAddress('9AiHB952pXVrHuct9m3RKWoWv4LG52p58FYjMvUkpump')).toBe(
      '4aKGe5mSjyRYcGvx8zUWxZgRvds6ouRmGWBVxhpGEN59',
    );
    expect(history.data.counts).toEqual({
      launched: 1,
      graduated: 1,
      dead: 0,
      active: 0,
      unknown: 0,
    });
    expect(history.data.scanned).toEqual({
      pumpCurvesListed: true,
      curvesWithoutMint: 0,
      signatures: 62,
      signaturesComplete: true,
      transactionsListed: 62,
      transactionsRead: 12,
      readSince: 1795557107,
    });
    expect(history.completeness).toBe('partial');
    expect(history.sources.map((s) => s.name)).toEqual(['solana-rpc', 'dexscreener-solana']);
    expect(history.sources[0]?.note).toBe(
      "12 of the creator's 62 transactions listed were read for launches outside pump.fun",
    );
  });

  it('finds no other launch for the creator who sold everything, having read all of its history', async () => {
    const { rpc, now, dex, dexAsked } = creatorCase('pump-creator-sold');
    const history = await creatorHistory(SOLD_CREATOR, rpc, { now, dex, exclude: SOLD });
    expect(history.completeness).toBe('full');
    expect(history.data.tokens).toEqual([]);
    expect(history.data.scanned.transactionsRead).toBe(12);
    expect(dexAsked).toEqual([]);
  });

  it('keeps the analysed token when not told to leave it out', async () => {
    const { rpc, now } = creatorCase('pump-curve');
    const dex: DexFetch = async () => {
      throw new UpstreamError('dexscreener-solana', 'down');
    };
    const history = await creatorHistory(CURVE_CREATOR, rpc, { now, dex });
    expect(history.data.tokens).toEqual([
      expect.objectContaining({
        mint: CURVE_TOKEN,
        name: 'Bouncer',
        symbol: 'BOUNCER',
        signature:
          '2bp2ZKVjB9Zw9NWGNkAkXwGEMv13ecd4Hd1EMPDFtw3S51eCtsHjzLoFjxyycppzacmvmjjsv8uF53dxYEmWetv6',
        launchedAt: new Date(1795552482 * 1000).toISOString(),
        foundBy: ['creator-transactions', 'pump-curves'],
        // DexScreener down: trading unknown, so is the outcome.
        outcome: 'unknown',
        trades24h: null,
      }),
    ]);
    expect(history.completeness).toBe('partial');
    expect(history.sources[1]).toMatchObject({
      name: 'dexscreener-solana',
      note: 'tokens not read: trading unknown',
    });
  });

  it('still maps a curve on the chain when DexScreener is down', async () => {
    const { rpc, now } = creatorCase('pump-bundled');
    const dex: DexFetch = async () => {
      throw new UpstreamError('dexscreener-solana', 'down');
    };
    const history = await creatorHistory(BUNDLED_CREATOR, rpc, { now, dex, exclude: BUNDLED });
    expect(history.data.tokens.map((t) => [t.mint, t.outcome, t.trades24h])).toEqual([
      ['9AiHB952pXVrHuct9m3RKWoWv4LG52p58FYjMvUkpump', 'graduated', null],
    ]);
    expect(history.sources[1]?.note).toBe('pairs not read; tokens not read: trading unknown');
  });

  it('tells dead from active and unknown', () => {
    const nowS = 1_795_561_856;
    const day = 86_400;
    expect(tokenOutcome({ complete: true, trades24h: 0, launchedAt: null, nowS })).toBe(
      'graduated',
    );
    expect(tokenOutcome({ complete: false, trades24h: 4, launchedAt: nowS - 10 * day, nowS })).toBe(
      'active',
    );
    expect(tokenOutcome({ complete: false, trades24h: 0, launchedAt: nowS - 2 * day, nowS })).toBe(
      'dead',
    );
    // Younger than a day without a trade, or not listed: not enough to say.
    expect(tokenOutcome({ complete: false, trades24h: 0, launchedAt: nowS - 3600, nowS })).toBe(
      'unknown',
    );
    expect(
      tokenOutcome({ complete: null, trades24h: null, launchedAt: nowS - 9 * day, nowS }),
    ).toBe('unknown');
    expect(tokenOutcome({ complete: false, trades24h: 0, launchedAt: null, nowS })).toBe('unknown');
  });
});

describe('creatorOnToken', () => {
  it('shows the creator bought 11.9 % at launch and sold all of it in one transaction', async () => {
    const { rpc, now } = creatorCase('pump-creator-sold');
    const read = await creatorOnToken(SOLD_CREATOR, SOLD, rpc, { now });
    expect(read.completeness).toBe('full');
    expect(read.data).toMatchObject({
      bought: '119064729176629',
      sold: '119064729176629',
      received: '0',
      burned: '0',
      holdsNow: '0',
      holdsNowShare: 0,
      solSpent: '3800595724',
      solReceived: '4000115037',
      supply: '1000000000000000',
      decimals: 6,
      accountsRead: ['4CgQM3CBPKvByMwBWJCyxiqT7LfP97FS18zVb4CCM8TW'],
      transactions: { listed: 2, read: 2 },
      sends: { recipients: [], distinct: 0, burned: '0', total: '0' },
    });
    expect(read.data.moves.map((m) => [m.kind, m.signature, m.share])).toEqual([
      ['buy', SOLD_CREATION, 0.119064],
      ['sell', SOLD_SALE, 0.119064],
    ]);
    expect(read.data.moves[1]?.counterparties).toEqual([
      { address: SOLD_CURVE, amount: '119064729176629' },
    ]);
  });

  it('shows the bundled launch’s creator sent its launch buy to another wallet and holds the rest', async () => {
    const { rpc, now } = creatorCase('pump-bundled');
    const read = await creatorOnToken(BUNDLED_CREATOR, BUNDLED, rpc, { now });
    expect(read.completeness).toBe('full');
    expect(read.data.moves.map((m) => [m.kind, m.amount])).toEqual([
      ['buy', '21000000000000'],
      ['sent', '20999999999999'],
      ['buy', '3302385368521'],
      ['buy', '3647348584033'],
    ]);
    expect(read.data.holdsNow).toBe('6949733952555');
    // Bought − sent = held, to the unit.
    expect(BigInt(read.data.bought) - BigInt(read.data.sends.total ?? '0')).toBe(6949733952555n);
    expect(read.data.sends).toEqual({
      recipients: [
        { address: 'Cf37Kkz14fDSPPgLVjWTuLMkkdYov9kYUo1zojPijrPQ', value: '20999999999999' },
      ],
      distinct: 1,
      burned: '0',
      total: '20999999999999',
    });
  });

  it('shows a creator that bought nothing at launch', async () => {
    const { rpc, now } = creatorCase('pump-curve');
    const read = await creatorOnToken(CURVE_CREATOR, CURVE_TOKEN, rpc, { now });
    expect(read.completeness).toBe('full');
    expect(read.data.moves).toEqual([]);
    expect(read.data.holdsNow).toBe('0');
  });

  it('counts a send to the incinerator as burned', () => {
    const sends = sendsOf([
      {
        signature: 's',
        slot: 1,
        blockTime: null,
        kind: 'sent',
        amount: '5',
        share: null,
        sol: '0',
        counterparties: [
          { address: '1nc1nerator11111111111111111111111111111111', amount: '2' },
          { address: SOLD_CURVE, amount: '3' },
        ],
      },
    ]);
    expect(sends).toEqual({
      recipients: [{ address: SOLD_CURVE, value: '3' }],
      distinct: 1,
      burned: '2',
      total: '3',
    });
  });

  it('stops at its call cap and says the read is partial', async () => {
    const { rpc, now } = creatorCase('pump-creator-sold');
    const read = await creatorOnToken(SOLD_CREATOR, SOLD, rpc, { now, maxCalls: 3 });
    expect(read.completeness).toBe('partial');
    expect(read.data.transactions).toEqual({ listed: 2, read: 0 });
    expect(read.sources[0]?.note).toContain('call cap of 3 reached');
    expect(rpc.calls).toHaveLength(3);
  });

  it('stops at its time cap', async () => {
    const { rpc, clock } = creatorCase('pump-creator-sold');
    let t = clock;
    // Each look at the clock moves it 4 s on: the third call is past 10 s.
    const read = await creatorOnToken(SOLD_CREATOR, SOLD, rpc, {
      now: () => (t += 4_000),
      timeoutMs: 10_000,
    });
    expect(read.completeness).toBe('partial');
    expect(read.sources[0]?.note).toContain('time cap of 10000 ms reached');
  });
});

describe('limits shared by the four reads', () => {
  it('reads a whole creator within the default cap, each answer fetched once', async () => {
    const { rpc, now, dex, clock } = creatorCase('pump-bundled');
    const shared = limitRpc(rpc, { now });
    const creator = await findCreator(BUNDLED, shared);
    const who = creator.data.creator as string;
    const history = await creatorHistory(who, shared, { dex, exclude: BUNDLED });
    const onToken = await creatorOnToken(who, BUNDLED, shared);
    const linked = await linkedWallets(who, BUNDLED, shared, {
      launchTime: creator.data.creation?.blockTime ?? null,
    });
    expect([creator, history, onToken, linked].map((r) => r.completeness)).toEqual([
      'full',
      'partial',
      'full',
      'partial',
    ]);
    expect(repeated(rpc.calls)).toEqual([]);
    expect(shared.spent()).toBe(rpc.calls.length);
    expect(shared.spent()).toBeLessThanOrEqual(DEFAULT_CREATOR_CALLS);
    expect(history.sources[0]?.fetchedAt).toBe(new Date(clock).toISOString());
  });

  it('keeps a limited client as it is', () => {
    const limited = limitRpc(createFakeSolanaRpc([]), { maxCalls: 1 });
    expect(limitRpc(limited, { maxCalls: 99 })).toBe(limited);
  });

  it('survives its caps and failing sources, never a bug or a missing fixture', () => {
    expect(isReadFailure(new ReadCapError('calls', 1))).toBe(true);
    expect(isReadFailure(new BudgetExhaustedError('solana-rpc', 1))).toBe(true);
    expect(isReadFailure(new UpstreamError('solana-rpc', 'down'))).toBe(true);
    expect(isReadFailure(new MissingRecordingError('getSlot', []))).toBe(false);
    expect(isReadFailure(new TypeError('x'))).toBe(false);
  });
});
