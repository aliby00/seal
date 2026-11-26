import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  creatorFromLaunch,
  creatorHistory,
  PUMP_CURVE_DISCRIMINATOR,
  findCreation,
  launcherOverNamed,
  launchpadCreator,
  moveIn,
  readWalletOnToken,
  saleSize as sizeOf,
} from '../../src/lib/solana/creator';
import type { SolanaCreator } from '../../src/lib/solana/creator-types';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import { replayLaunch } from '../../src/lib/solana/launch';
import { decodeDbcPool, decodeLaunchLabPool } from '../../src/lib/solana/graduation';
import { liquidityAction } from '../../src/lib/solana/liquidity-ix';
import { PUMP_FUN_PROGRAM, TOKEN_PROGRAM } from '../../src/lib/solana/programs';
import { addressBytes } from '../../src/lib/solana/address';
import {
  accountBytes,
  type AccountInfo,
  type RecordedCall,
  type SolanaTransaction,
} from '../../src/lib/solana/rpc';
import { movesOf, ownerKind, readFlows } from '../../src/lib/solana/trades';
import { perTrade, pickSolanaPair, ratio, withCurveLiquidity } from '../../src/lib/market/solana';
import type { DexScreenerPair } from '../../src/lib/market/dexscreener';
import type { SolanaGraduation, SolanaMarketState } from '../../src/lib/market/solana-types';
import { SOLANA_FIXTURES } from './fixtures';

/**
 * The factual errors of the production audit of 26/11/2026 (36 fresh
 * tokens against RugCheck, DexScreener and the node), each on what the
 * chain showed for the token it was seen on: tests/fixtures/solana/faits/.
 */

const dir = join(SOLANA_FIXTURES, 'faits');
const load = (name: string) =>
  JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as RecordedCall | RecordedCall[];
const tx = (name: string) => (load(name) as RecordedCall).result as SolanaTransaction;
const signature = (name: string) => tx(name).transaction.signatures[0] as string;

const GIGA = '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9';
const GIGA_CREATOR = '9zMg9pEUvNVidr54xD4E5oLjiwu2SiuxJiSaU6EEW4Un';
const GIGA_SUPPLY_TODAY = 960372728924597n;
const NEST = '68Nq68CrtLVpyvK5Un7UADiNczaGf39hBbj3diRsYj6D';
const NEST_CREATOR = 'JBweC2s2Jht8D7K3vHyQtA5FDUseC1iCcYsxnML9F2pJ';
const FAKE_SOL = '6Dyz9eEBoQaXMcU3SNhAva1rZ1EsfjADsaYJFMGnK52G';
const FAKE_SOL_CREATOR = '6exijYia9cU9BVgBXwkpR4uE3CMGTMkTmDU6aKNvVqJU';
const POPCAT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const POPCAT_CREATOR = '8LAnvxpF7kL1iUjDRjmP87xiuyCx4yX3ZRAoDCChKe1L';
const EXODUS = 'ExodusMetRadUdPSGxhZ27cMJWHxLmcbeuy78GVNCzf5';
const GONDOLA = '5vQGwxuqt1v3mx7rdbFYDSWvP27Sm5z5x8emQn12pump';
const GONDOLA_NAMED = '3cZgqsZEp8d4VmEuzhhj6RtDS9u3mo62m9EPZq6QPvoZ';
const GONDOLA_LAUNCHER = '3vxCYSy3cGzEXN6UFabBPrJC5ofPrfNK32vHkBpaMfmi';
const HOSS = 'EvTaKHSWxhvqfdLNLJnuX8DMZyQA8Kg9nTNmhQhYpump';
const HOSS_NAMED = 'E33nfqdbfnY9EbCNgAKZJc3AHfE8oxnnAyR3Gn6pR9FH';
const HOSS_LAUNCHER = '8ZRL2vNXn1L9MxPP8B8SwKFUXN4GAqhpqFzZXhyN6iCP';
const PCB = 'PpYYE5KdVWc2r5W7RsvVA3Lcs4PLBkASxGVZGbmNX6r';

describe('liquidity added is never a sale (audit item 1)', () => {
  it('reads pool creations and deposits by their instructions, and a swap as none', () => {
    // GIGA: Raydium AMM v4 initialize2; NEST: DAMM v2 initialize_customizable_pool;
    // fake SOL: CLMM open_position_with_token22_nft; POPCAT: DAMM v1 pool creation.
    expect(liquidityAction(tx('giga-initialize2'))).toBe('add');
    expect(liquidityAction(tx('nest-seed'))).toBe('add');
    expect(liquidityAction(tx('fakesol-clmm'))).toBe('add');
    expect(liquidityAction(tx('popcat-sell'))).toBe('add');
    // A Raydium swap (tag 9), and a pump.fun creation with its buy.
    expect(liquidityAction(tx('giga-exodus-buy'))).toBeNull();
    expect(liquidityAction(tx('gondola-creation'))).toBeNull();
  });

  it.each([
    ['giga-initialize2', GIGA, GIGA_CREATOR, '875000000000000'],
    ['nest-seed', NEST, NEST_CREATOR, '400000000000000000'],
    ['fakesol-clmm', FAKE_SOL, FAKE_SOL_CREATOR, '20997873910000'],
    ['popcat-sell', POPCAT, POPCAT_CREATOR, '23336490000000'],
  ])('%s: the creator provided liquidity, it did not sell', (name, mint, wallet, amount) => {
    const move = moveIn(tx(name), signature(name), wallet, mint, null);
    expect(move?.kind).toBe('provided');
    expect(move?.amount).toBe(amount);
  });

  it('a buy paid in wrapped SOL stays a buy: GIGA’s 58.3 % in the pool’s first second', () => {
    const move = moveIn(tx('giga-exodus-buy'), signature('giga-exodus-buy'), EXODUS, GIGA, null);
    expect(move?.kind).toBe('buy');
    expect(move?.amount).toBe('582846410684474');
  });

  it('the launch replay reads the pool seeding as liquidity provided, not a transfer', () => {
    const flows = readFlows(tx('giga-initialize2'), GIGA);
    expect(flows.liquidity).toBe('add');
    const moves = movesOf(flows, (o) => ownerKind(o, undefined), GIGA);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      kind: 'provide',
      actor: GIGA_CREATOR,
      value: 875000000000000n,
    });
    const nest = movesOf(readFlows(tx('nest-seed'), NEST), (o) => ownerKind(o, undefined), NEST);
    expect(nest.map((m) => [m.kind, m.actor])).toEqual([['provide', NEST_CREATOR]]);
  });

  it('GIGA’s creator: received the supply, put 87.5 % into the pool, sold none, shares never above 100 %', async () => {
    const mintTx = load('giga-mint') as RecordedCall;
    const seed = load('giga-initialize2') as RecordedCall;
    const rpc = createFakeSolanaRpc([
      { method: 'getTokenAccountsByOwner', result: { value: [] } },
      {
        method: 'getSignaturesForAddress',
        result: [seed, mintTx].map((c) => {
          const t = c.result as SolanaTransaction;
          return {
            signature: t.transaction.signatures[0],
            slot: t.slot,
            err: null,
            memo: null,
            blockTime: t.blockTime,
            confirmationStatus: 'finalized',
          };
        }),
      },
      mintTx,
      seed,
    ]);
    const read = await readWalletOnToken(rpc, GIGA_CREATOR, GIGA, TOKEN_PROGRAM, GIGA_SUPPLY_TODAY);
    expect(read.sold).toBe('0');
    expect(read.provided).toBe('875000000000000');
    // 1e15 minted, 9.6e14 today: the shares are of what was minted.
    expect(read.shareBase).toBe('1000000000000000');
    expect(read.moves.map((m) => [m.kind, m.share])).toEqual([
      ['received', 1],
      ['provided', 0.875],
    ]);
  });
});

describe('the launcher, when the pump.fun curve names another address (audit item 2)', () => {
  it.each([
    ['gondola-creation', GONDOLA, GONDOLA_NAMED, GONDOLA_LAUNCHER, 0.2146],
    ['hoss-creation', HOSS, HOSS_NAMED, HOSS_LAUNCHER, 0.066286],
  ])('%s: the signer that paid and bought is the creator', (name, mint, named, launcher, share) => {
    const over = launcherOverNamed(tx(name), mint, named);
    expect(over?.launcher).toBe(launcher);
    expect(Number(over!.got) / Number(over!.minted)).toBeCloseTo(share, 4);
    // The named address signing (or being the payer) keeps it the creator.
    expect(launcherOverNamed(tx(name), mint, launcher)).toBeNull();
  });

  it('the creator read from the curve becomes the launcher once the replay finds the creation', () => {
    const named: SolanaCreator = {
      completeness: 'partial',
      sources: [
        {
          name: 'solana-rpc',
          fetchedAt: '2026-11-26T08:00:00.000Z',
          note: 'the mint has more than 3000 transactions: its creation was not reached',
        },
      ],
      data: {
        mint: GONDOLA,
        creator: GONDOLA_NAMED,
        from: 'pump-curve',
        account: 'GcNuSykeNRCRsSDbbmbjxBiofGhqwEnSVNJ7dY4YPX89',
        creation: null,
        pumpCurve: { address: 'GcNuSykeNRCRsSDbbmbjxBiofGhqwEnSVNJ7dY4YPX89', complete: false },
      },
    };
    const found = {
      signature: signature('gondola-creation'),
      payer: GONDOLA_LAUNCHER,
      tx: tx('gondola-creation'),
    };
    const resolved = creatorFromLaunch(named, found);
    expect(resolved?.data).toMatchObject({
      creator: GONDOLA_LAUNCHER,
      from: 'creation-transaction',
      named: { address: GONDOLA_NAMED, from: 'pump-curve' },
    });
    expect(resolved?.data.named?.signerShare).toBeCloseTo(0.2146, 4);
    expect(resolved?.sources[0]?.note).toMatch(/3vxCYSy3\S+ is read as the creator/);
    expect(resolved?.sources[0]?.note).not.toMatch(/was not reached/);

    // No creator named at all: the creation's payer is read.
    const none = creatorFromLaunch(
      {
        ...named,
        completeness: 'unavailable',
        sources: [
          {
            name: 'solana-rpc',
            fetchedAt: '2026-11-26T08:00:00.000Z',
            note: 'no curve, creation transaction or metadata authority names a creator',
          },
        ],
        data: { ...named.data, creator: null, from: null, account: null, pumpCurve: null },
      },
      found,
    );
    expect(none?.data).toMatchObject({ creator: GONDOLA_LAUNCHER, from: 'creation-transaction' });
  });
});

describe('the creator a launchpad pool names (audit item 3)', () => {
  const rpc = () => createFakeSolanaRpc(load('launchpad-pools') as RecordedCall[]);

  it.each([
    [
      'sidoor-dbc',
      'zcRvzm7gAfYGde8gRwaSYxNryL47SjLVUQLAf1bdoor',
      'A7HB4xzKdHEmd6JxyNwQtX6H74afCaAB4XqqxwW83ddJ',
    ],
    [
      'ember-dbc',
      '5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6',
      'GZjYfGyUNQfDChcQ66Gc3ZMcQqPEisyRYe1nPyQhP9bp',
    ],
    [
      'rings-dbc',
      '65iH8k736QNhuUHm1tt8X7yJXpJ517HPPq8BrVdwring',
      'A38XmbEVAyhECNxMJTJ5Mmfb1M3c86yKUGNBHL5qToEP',
    ],
  ])('%s: the pool names its mint at 136 and its creator at 104', (name, mint, creator) => {
    const info = ((load(name) as RecordedCall).result as { value: AccountInfo }).value;
    const pool = decodeDbcPool(accountBytes(info) as Uint8Array);
    expect(pool).toMatchObject({ baseMint: mint, creator });
  });

  it('LENDR: its LaunchLab pool names its mint at 205 and its creator at 333', () => {
    const info = ((load('lendr-launchlab') as RecordedCall).result as { value: AccountInfo }).value;
    expect(decodeLaunchLabPool(accountBytes(info) as Uint8Array)).toMatchObject({
      baseMint: 'AGazYig7A8Co6ZapAPterBRLitdiP6AAaWiPH8jWLend',
      creator: '5x4pPF8hCwQmz4cKEQftxgvqqjMXhyqyVvE33rH8EY16',
    });
  });

  it('reads the Meteora DBC creator at 104 and the LaunchLab creator at 333', async () => {
    await expect(
      launchpadCreator(rpc(), 'zcRvzm7gAfYGde8gRwaSYxNryL47SjLVUQLAf1bdoor'),
    ).resolves.toEqual({
      creator: 'A7HB4xzKdHEmd6JxyNwQtX6H74afCaAB4XqqxwW83ddJ',
      account: 'EgoyV4ctCJHBUC3RnCayXVUVzNS7WK8V65ZhWNj5kyCZ',
    });
    await expect(
      launchpadCreator(rpc(), 'AGazYig7A8Co6ZapAPterBRLitdiP6AAaWiPH8jWLend'),
    ).resolves.toEqual({
      creator: '5x4pPF8hCwQmz4cKEQftxgvqqjMXhyqyVvE33rH8EY16',
      account: '9gPANe2jmpH8mxJ9XC2F6pB9cKU3UpgGxpeTuqtGMVcf',
    });
    await expect(
      launchpadCreator(rpc(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    ).resolves.toBeNull();
  });

  it('PCB: the mint’s first transaction, signed by the mint’s key, names who holds it', async () => {
    const first = load('pcb-first') as RecordedCall;
    const t = first.result as SolanaTransaction;
    const rpc = createFakeSolanaRpc([
      {
        method: 'getSignaturesForAddress',
        result: [
          {
            signature: t.transaction.signatures[0],
            slot: t.slot,
            err: null,
            memo: null,
            blockTime: t.blockTime,
            confirmationStatus: 'finalized',
          },
        ],
      },
      first,
    ]);
    const read = await findCreation(rpc, PCB, 1);
    expect(read.creation).toBeNull();
    expect(read.mintSigned?.feePayer).toBe('6eCJmAHZKjo7EzeZonDxg8uA3wSZiwdGJWcSyBued5AZ');
  });
});

describe('the launch window opens with trading (audit item 4)', () => {
  it('GIGA: minted 298 s before its pool; the first buyers are those of the pool’s first seconds', async () => {
    const rpc = createFakeSolanaRpc(load('giga-launch') as RecordedCall[]);
    const replay = await replayLaunch(GIGA, rpc, {
      creator: GIGA_CREATOR,
      creationSignature: signature('giga-mint'),
      deadlineMs: 600_000,
    });
    const s = replay.data.summary!;
    expect(s.tradingOpenedAt).toBe(298);
    expect(s.early.wallets).toBeGreaterThan(0);
    expect(s.early.share).toBeLessThanOrEqual(1);
    // The pool's seeding is the creator's liquidity, not a transfer to someone.
    expect(s.creatorSent).toBeUndefined();
    const seeding = replay.data.moves.find((m) => m.transaction === signature('giga-initialize2'));
    expect(seeding).toMatchObject({ kind: 'provide', actorIsCreator: true, share: 0.875 });
    const exodus = replay.data.moves.find((m) => m.actor === EXODUS);
    expect(exodus).toMatchObject({ kind: 'buy', seconds: 298, share: 0.582846 });
    expect(replay.data.story.map((l) => l.text).join(' ')).toMatch(
      /Within the first 10 seconds of trading, which opened 298 seconds after the creation/,
    );
  });
});

describe('the replay flags the launcher its creation shows (audit item 2)', () => {
  it('reads the creation, asks who launched it, and flags that address', async () => {
    const rpc = () => createFakeSolanaRpc(load('giga-launch') as RecordedCall[]);
    const asked: string[] = [];
    const replay = await replayLaunch(GIGA, rpc(), {
      creator: null,
      creationSignature: signature('giga-mint'),
      deadlineMs: 600_000,
      onCreation: (found) => {
        asked.push(found?.payer ?? 'none');
        return found?.payer ?? null;
      },
    });
    expect(asked).toEqual([GIGA_CREATOR]);
    // Started with no creator, the replay flags the one its creation named.
    expect(replay.data.summary?.creatorAtLaunch).toBe(1);
    expect(replay.data.moves.some((m) => m.actorIsCreator && m.actor === GIGA_CREATOR)).toBe(true);
  });
});

describe('the main pair and its trades (audit items 5 and 6)', () => {
  const pairs = (name: string) =>
    JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as DexScreenerPair[];

  it('EMBER: its $64.6k pool against MET is the market, not the $2.6k one against SOL', () => {
    const pick = pickSolanaPair('5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6', pairs('dex-ember'));
    expect(pick?.pairAddress).toBe('2y6PCqa4fEp3jLiFdan9jVMw7LSK8F3gwsTfy8p7traE');
  });

  it('LINK: with no meaningful liquidity anywhere, the most traded pool, not an $8 one', () => {
    const pick = pickSolanaPair('DMhmzwzNo12xkUh5mwRMRdYVDDgMEedXbfTCr9vfus5m', pairs('dex-link'));
    expect(pick?.pairAddress).toBe('C73f8tDQSLSEaLM3WikMFasincdikaQBhD7wi24yAqyX');
  });

  it('a price far from the reference pairs’ does not make a pair the market', () => {
    const ember = pairs('dex-ember').map((p) =>
      p.pairAddress === '2y6PCqa4fEp3jLiFdan9jVMw7LSK8F3gwsTfy8p7traE'
        ? { ...p, priceUsd: '4.3' }
        : p,
    );
    const pick = pickSolanaPair('5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6', ember);
    expect(pick?.pairAddress).toBe('5tb9fNLKr2wdJRSTNYRu39kGTjnYVseWo2bGyNgxnLHS');
  });

  it('volume per trade counts only pairs giving both figures', () => {
    const a = { volume: { h24: 1000 }, txns: { h24: { buys: 5, sells: 5 } } } as DexScreenerPair;
    const noVolume = { txns: { h24: { buys: 900, sells: 90 } } } as DexScreenerPair;
    expect(perTrade([a, noVolume])).toBe(100);
    expect(perTrade([noVolume])).toBeNull();
    expect(ratio(65_000, 420_000)).toBe(0.1548);
    expect(ratio(1, 0)).toBeNull();
  });

  it('a curve still on it: its SOL in dollars, and as a share of the market cap', () => {
    const market = {
      completeness: 'partial',
      sources: [],
      data: {
        chain: 'solana',
        token: 'x',
        pair: 'CURVE',
        dex: 'pumpfun',
        pairedWith: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
        priceUsd: 0.000015,
        priceNative: 0.0000001,
        liquidityUsd: null,
        volumeUsd: null,
        txns: null,
        fdvUsd: 15_000,
        marketCapUsd: 15_000,
        pairCreatedAt: null,
        pools: [],
      },
    } as unknown as SolanaMarketState;
    const graduation = {
      completeness: 'full',
      sources: [],
      data: {
        mint: 'x',
        launchpad: 'pump.fun',
        account: 'CURVE',
        graduated: false,
        progress: 0.3,
        progressBasis: 'tokens-sold',
        raised: { mint: null, raw: '53000000000' },
        target: null,
        destination: null,
        creator: null,
      },
    } as unknown as SolanaGraduation;
    const out = withCurveLiquidity(market, graduation);
    // 53 SOL at 150 USD (0.000015 / 0.0000001).
    expect(out.data.curveLiquidityUsd).toBe(7950);
    expect(out.data.liquidityToMarketCap).toBe(0.53);
  });
});

describe('every pump.fun curve naming the creator is a launch (audit item 7)', () => {
  it('counts the curves whose mint was not found, beside the tokens listed one by one', async () => {
    // pode's creator: 6 tokens listed, 1,382 curves more; here three curves, no mint found.
    const creator = GONDOLA_LAUNCHER;
    const curve = (complete: boolean) => {
      const bytes = new Uint8Array(81);
      bytes.set(PUMP_CURVE_DISCRIMINATOR, 0);
      bytes[48] = complete ? 1 : 0;
      bytes.set(addressBytes(creator), 49);
      return {
        lamports: 1,
        owner: PUMP_FUN_PROGRAM,
        executable: false,
        rentEpoch: 0,
        data: [Buffer.from(bytes).toString('base64'), 'base64'],
      };
    };
    const rpc = createFakeSolanaRpc([
      {
        method: 'getProgramAccounts',
        result: [
          { pubkey: GONDOLA_NAMED, account: curve(false) },
          { pubkey: HOSS_NAMED, account: curve(true) },
          { pubkey: HOSS_LAUNCHER, account: curve(false) },
        ],
      },
      { method: 'getSignaturesForAddress', result: [] },
      { method: 'getTokenAccountsByOwner', result: { value: [] } },
    ]);
    const history = await creatorHistory(creator, rpc, { dex: async () => ({ pairs: [] }) });
    expect(history.data.counts.launched).toBe(0);
    expect(history.data.scanned.curvesWithoutMint).toBe(3);
    expect(history.data.scanned.pumpCurves).toBe(3);
    expect(history.data.launchesAtLeast).toBe(3);
  });
});

describe('a minor sale is a fact, not a signal (audit item 8)', () => {
  const day = 86_400;
  it('under 0.5 % of the supply, or under 1 SOL on a token over a week old', () => {
    const base = { shareBase: undefined, supply: '1000000' };
    expect(sizeOf({ ...base, sold: '0', solReceived: '0' }, null, 0)).toBeUndefined();
    expect(sizeOf({ ...base, sold: '4000', solReceived: '9000000000' }, null, 0)).toBe('minor');
    // POPCAT: 0.0191 SOL on a two-year-old token.
    expect(sizeOf({ ...base, sold: '20000', solReceived: '19100000' }, 0, 700 * day)).toBe('minor');
    // The same sale on a token launched an hour ago is material.
    expect(sizeOf({ ...base, sold: '20000', solReceived: '19100000' }, 0, 3600)).toBe('material');
  });
});
