import { describe, expect, it } from 'vitest';
import { isOnCurve } from '../../src/lib/solana/address';
import { INCINERATOR, PUMP_FUN_PROGRAM, TOKEN_2022_PROGRAM } from '../../src/lib/solana/programs';
import type { SolanaTransaction } from '../../src/lib/solana/rpc';
import { movesOf, ownerKind, readFlows } from '../../src/lib/solana/trades';
import { loadRecordings } from './fixtures';

/**
 * What one transaction did to a token, read from its balances. Every
 * transaction below was recorded on mainnet (tests/fixtures/solana/launch/).
 */

const BUNDLED = '6qmoWWfCw1uVMfPzRWkCEu4kLmT9F8d3MXDMexXkpump';
const BUNDLED_CREATOR = 'b5fbkVRNRTjZHgvQLU2QKyYUUBXEVgX7bwTc7eP5FGT';
/** The pump.fun curve of 6qmo…: pumpBondingCurveAddress(mint), owned by pump.fun. */
const BUNDLED_CURVE = '73K9yy9H65nkDzTKbSw3Xr5w4Lj9GABV2edWuyhuWcX2';
/** The quote token of that curve: what its buyers paid with. */
const SPCX = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const NORMAL = '2beKV42eqYiHsqxrsUE8oc7vM7gjdwG9HHrbwqE6pump';
const CURVE_MINT = 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump';

function transaction(zoneFile: string, prefix: string, encoding = 'json'): SolanaTransaction {
  const entry = loadRecordings('launch', [zoneFile]).find(
    (e) =>
      e.method === 'getTransaction' &&
      String(e.params?.[0]).startsWith(prefix) &&
      (e.params?.[1] as { encoding?: string }).encoding === encoding,
  );
  if (!entry) throw new Error(`no recorded transaction ${prefix}`);
  return entry.result as SolanaTransaction;
}

/** On-curve owners are wallets; the curve is a pool because pump.fun owns its account. */
const kindOf = (owner: string) =>
  ownerKind(owner, owner === BUNDLED_CURVE ? PUMP_FUN_PROGRAM : undefined);

describe('readFlows', () => {
  it('sees the creation: the mint account gets its first lamports, the supply appears', () => {
    const flows = readFlows(transaction('pump-bundled.json', 'M49A3kmy'), BUNDLED);
    expect(flows.createsMint).toBe(true);
    expect(flows.payer).toBe(BUNDLED_CREATOR);
    expect(flows.slot).toBe(473504636);
    expect(flows.minted).toBe(1_000_000_000_000_000n);
    expect(new Map(flows.changes.map((c) => [c.owner, c.delta]))).toEqual(
      new Map([
        [BUNDLED_CURVE, 979_000_000_000_000n],
        [BUNDLED_CREATOR, 21_000_000_000_000n],
      ]),
    );
    expect(flows.others.get(BUNDLED_CREATOR)?.get(SPCX)?.delta).toBe(-531745n);
  });

  it('a later buy creates nothing', () => {
    const flows = readFlows(transaction('pump-bundled.json', '3NVtiBTE'), BUNDLED);
    expect(flows.createsMint).toBe(false);
    expect(flows.minted).toBe(0n);
  });

  it('a bot transaction that moves nothing has no change', () => {
    // 3q9LnDf8…: one of thirteen transactions of G9PvVCC9… in the first slots, none moving the token.
    const flows = readFlows(transaction('pump-bundled.json', '3q9LnDf8'), BUNDLED);
    expect(flows.changes).toEqual([]);
    expect(movesOf(flows, kindOf, BUNDLED)).toEqual([]);
  });
});

describe('ownerKind', () => {
  it('tells wallets, pools, other program accounts and the incinerator apart', () => {
    expect(isOnCurve(BUNDLED_CREATOR)).toBe(true);
    expect(ownerKind(BUNDLED_CREATOR, undefined)).toBe('wallet');
    expect(ownerKind(BUNDLED_CURVE, PUMP_FUN_PROGRAM)).toBe('pool');
    // Off the curve, owned by a program that is not a market: a program account.
    expect(ownerKind(BUNDLED_CURVE, TOKEN_2022_PROGRAM)).toBe('contract');
    expect(ownerKind(BUNDLED_CURVE, null)).toBe('contract');
    expect(ownerKind(INCINERATOR, null)).toBe('burn');
  });
});

describe('movesOf', () => {
  it('the creation: the supply is created on the curve, the creator buys from it', () => {
    const moves = movesOf(
      readFlows(transaction('pump-bundled.json', 'M49A3kmy'), BUNDLED),
      kindOf,
      BUNDLED,
    );
    expect(
      moves.map(({ kind, actor, counterparty, value }) => ({ kind, actor, counterparty, value })),
    ).toEqual([
      { kind: 'mint', actor: BUNDLED_CURVE, counterparty: BUNDLED, value: 1_000_000_000_000_000n },
      {
        kind: 'buy',
        actor: BUNDLED_CREATOR,
        counterparty: BUNDLED_CURVE,
        value: 21_000_000_000_000n,
      },
    ]);
    // Paid in the curve's quote token, SPCX…, not in SOL.
    expect(moves[1]?.quote).toEqual({ asset: SPCX, amount: 531745n, decimals: 6 });
  });

  it('a 35 % buy in the creation slot, and its sale three slots later', () => {
    const buy = movesOf(
      readFlows(transaction('pump-bundled.json', '3NVtiBTE'), BUNDLED),
      kindOf,
      BUNDLED,
    );
    expect(buy).toEqual([
      expect.objectContaining({
        kind: 'buy',
        actor: '2Hf75pNqubdzQSNssssj7MoUeEyRSKpXUsSC25L7Agik',
        counterparty: BUNDLED_CURVE,
        value: 349_999_999_999_991n,
        slot: 473504636,
      }),
    ]);
    const sale = movesOf(
      readFlows(transaction('pump-bundled.json', '4jp7Dhj5'), BUNDLED),
      kindOf,
      BUNDLED,
    );
    expect(sale).toEqual([
      expect.objectContaining({
        kind: 'sell',
        actor: '2Hf75pNqubdzQSNssssj7MoUeEyRSKpXUsSC25L7Agik',
        value: 349_999_999_999_991n,
        slot: 473504639,
      }),
    ]);
  });

  it('a buyer routed through wrapped SOL is said to pay in SOL', () => {
    // 2oMJRq7K…: mxc91JmA… spent 15 wrapped SOL through another pool for the curve's quote token.
    const [move] = movesOf(
      readFlows(transaction('pump-bundled.json', '2oMJRq7K'), BUNDLED),
      kindOf,
      BUNDLED,
    );
    expect(move).toEqual(
      expect.objectContaining({
        kind: 'buy',
        actor: 'mxc91JmAdJ1HDGniKc4KtEzao2hHs9RF1wKhMcS5XfF',
        value: 117_819_560_696_626n,
      }),
    );
    // 15 wrapped SOL plus 2.923044290 SOL of lamports (2.920005 of them the fee).
    expect(move?.quote).toEqual({ asset: 'SOL', amount: 17_923_044_290n, decimals: 9 });
  });

  it('one transaction serving three wallets gives three buys', () => {
    // 3uWP3ffb…, on ANDL…pump: paid by F46pqf6c…, the creation's fee payer.
    const flows = readFlows(transaction('pump-curve.json', '3uWP3ffb'), CURVE_MINT);
    const curve = '8j8apXSGYWc9m9XySAADCYmUzhetFzs2ZMoj36opQ8YA';
    const moves = movesOf(
      flows,
      (o) => ownerKind(o, o === curve ? PUMP_FUN_PROGRAM : undefined),
      CURVE_MINT,
    );
    expect(flows.payer).toBe('F46pqf6cNywQqncHGPityWzw1BfZtr49oZwbBM5bDfpx');
    expect(moves.map((m) => [m.kind, m.actor.slice(0, 10), m.value])).toEqual([
      ['buy', 'CwrXPMe5zh', 58_584_154_462_697n],
      ['buy', 'CCeYeVdvsQ', 74_513_791_294_895n],
      ['buy', '32sn175oCa', 76_702_944_226_540n],
    ]);
    expect(moves.every((m) => m.counterparty === curve)).toBe(true);
  });
});

describe('movesOf on a Meteora DBC launch (8xKZ…)', () => {
  const DBC_MINT = '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx';
  /** The DBC pool authority: off the curve, an account of the System Program, no data. */
  const AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
  const kind = (o: string) =>
    ownerKind(o, o === AUTHORITY ? '11111111111111111111111111111111' : undefined);

  it('without a known pool, the program-derived owner is the other side', () => {
    expect(kind(AUTHORITY)).toBe('contract');
    // 5R2QMtmm…: Fuwe… bought 25.67 % in the creation slot.
    const moves = movesOf(
      readFlows(transaction('meteora-dbc.json', '5R2QMtmm'), DBC_MINT),
      kind,
      DBC_MINT,
    );
    expect(moves).toEqual([
      expect.objectContaining({
        kind: 'buy',
        actor: 'Fuwec4gw9j2zw2B9QBJqkuH3sULBeodqMVM2jUgaKaNT',
        counterparty: AUTHORITY,
        value: 256_661_639_803_643n,
      }),
    ]);
  });

  it('the creation puts the whole supply on that owner', () => {
    const flows = readFlows(transaction('meteora-dbc.json', 'iHeYqyqc'), DBC_MINT);
    expect(flows.createsMint).toBe(true);
    expect(flows.minted).toBe(1_000_000_000_000_000n);
    const [mint] = movesOf(flows, kind, DBC_MINT);
    expect(mint).toEqual(expect.objectContaining({ kind: 'mint', actor: AUTHORITY }));
  });
});

/**
 * The same three transactions read a second way: the token program's own
 * `transferChecked` instructions (jsonParsed), which name the accounts, the
 * amount and who signed the transfer. They must say what the balances said.
 */
describe('hand check against the transfer instructions', () => {
  type Parsed = {
    transaction: { message: { accountKeys: { pubkey: string }[] } };
    meta: {
      postTokenBalances: { accountIndex: number; owner?: string }[];
      preTokenBalances: { accountIndex: number; owner?: string }[];
      innerInstructions: { instructions: ParsedInstruction[] }[];
    };
  };
  type ParsedInstruction = {
    parsed?: {
      type: string;
      info: {
        mint?: string;
        source: string;
        destination: string;
        authority?: string;
        tokenAmount?: { amount: string };
      };
    };
  };

  const cases = [
    { file: 'pump-bundled.json', prefix: '3NVtiBTE', mint: BUNDLED, kind: 'buy' },
    { file: 'pump-bundled.json', prefix: '4jp7Dhj5', mint: BUNDLED, kind: 'sell' },
    { file: 'pump-normal.json', prefix: '3WgrHKBW', mint: NORMAL, kind: 'buy' },
  ] as const;

  for (const c of cases) {
    it(`${c.prefix}…: one transfer, the same amount, between the same owners`, () => {
      const parsed = transaction('crosscheck.json', c.prefix, 'jsonParsed') as unknown as Parsed;
      const keys = parsed.transaction.message.accountKeys.map((k) => k.pubkey);
      const ownerOf = new Map(
        [...parsed.meta.preTokenBalances, ...parsed.meta.postTokenBalances].map((b) => [
          keys[b.accountIndex],
          b.owner,
        ]),
      );
      const transfers = parsed.meta.innerInstructions
        .flatMap((g) => g.instructions)
        .filter((i) => i.parsed?.type === 'transferChecked' && i.parsed.info.mint === c.mint)
        .map((i) => i.parsed!.info);
      expect(transfers).toHaveLength(1);
      const transfer = transfers[0]!;

      const flows = readFlows(transaction(c.file, c.prefix), c.mint);
      const market = ownerOf.get(
        c.kind === 'buy' ? transfer.source : transfer.destination,
      ) as string;
      const [move] = movesOf(
        flows,
        (o) => ownerKind(o, o === market ? PUMP_FUN_PROGRAM : undefined),
        c.mint,
      );
      expect(move?.kind).toBe(c.kind);
      expect(move?.value.toString()).toBe(transfer.tokenAmount?.amount);
      expect(move?.counterparty).toBe(market);
      expect(ownerOf.get(c.kind === 'buy' ? transfer.destination : transfer.source)).toBe(
        move?.actor,
      );
      // A buy is signed by the curve, a sale by the wallet.
      expect(transfer.authority).toBe(c.kind === 'buy' ? market : move?.actor);
    });
  }
});
