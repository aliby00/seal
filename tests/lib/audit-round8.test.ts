import { describe, expect, it } from 'vitest';
import { renderLaunch, renderReport } from '../../src/lib/agent/prompt';
import {
  creatorRemovals,
  MAX_WINDOW_SPLITS,
  MODIFY_LIQUIDITY_TOPIC,
  readWindows,
  returnedFrom,
} from '../../src/lib/chain/deployer';
import {
  draftMoves,
  separateLiquidity,
  summarize,
  tallyLaunch,
  type RelayedTrip,
} from '../../src/lib/chain/launch';
import { launchInfrastructure } from '../../src/lib/chain/launchpads';
import type { RawLog } from '../../src/lib/chain/logs';
import { POOL_MANAGER } from '../../src/lib/chain/pools';
import type { RpcClient, RpcRequest } from '../../src/lib/chain/rpc';
import type { TxNature } from '../../src/lib/chain/trades';
import type { LaunchReplay, LaunchedToken } from '../../src/lib/contracts';
import { toFacts } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';
import { CATALOG } from '../../src/lib/specialists/catalog';
import type { SpecialistContext } from '../../src/lib/specialists/types';
import { makeReport } from '../specialists/helpers';
import rh from './fixtures/audit7/launch-rh.json';

/**
 * The eighth audit of staging (18/10/2026): the liquidity read of busy v4
 * markets (BOOMER, WORM, AGEM…), third-party removals said next to "no
 * removal" (MUT8, moon…), and RH's round trips, 25 against 27 on chain.
 */

const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
const word = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0');
const BOOMER = '0x127cdc74e44e3c60422b7e792ebe480c0f873ed5';
const BOOMER_MARKET = '0xf4a65e0f8e6022800a8ed713b1dae86548d198b8b483f73c7180de3d09fc0935';
const CREATOR = '0x89c5d00f166e4805946d3f30c596174f6cd2db7f';
const PROVIDER = '0x58daec3116aae6d93017baaea7749052e8a04fa7';

/** A `ModifyLiquidity` on BOOMER's market: a negative delta removes, zero collects fees. */
function modify(i: number, delta: bigint): { token: string; log: RawLog } {
  return {
    token: BOOMER,
    log: {
      address: POOL_MANAGER,
      topics: [MODIFY_LIQUIDITY_TOPIC, BOOMER_MARKET, pad(PROVIDER)],
      data: `0x${word(-1000n)}${word(1000n)}${word(delta)}${'0'.repeat(64)}`,
      blockNumber: `0x${(91_295_100 + i).toString(16)}`,
      transactionHash: `0x${i.toString(16).padStart(64, '0')}`,
      logIndex: '0x0',
    },
  };
}

describe('the liquidity of a busy v4 market is read whole (item 1)', () => {
  it('BOOMER: 998 fee collections no longer hide its one removal', async () => {
    // Measured on 18/10/2026: 1,009 ModifyLiquidity on its market in a day,
    // 998 of them fee collections, 10 additions and 1 removal.
    const collections = Array.from({ length: 998 }, (_, i) => modify(i, 0n));
    const removal = modify(500, -5n);
    const asked: string[] = [];
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: RpcRequest[]) {
        return requests.map((r) => {
          const hash = r.params[0] as string;
          asked.push(hash);
          return { ok: true, value: { from: PROVIDER } };
        });
      },
    } as unknown as RpcClient;
    const { pulled, sender } = await creatorRemovals(
      rpc,
      CREATOR,
      new Set([BOOMER]),
      [removal],
      collections,
      BOOMER,
    );
    // Its sender is read first, whatever the collections around it.
    expect(asked[0]).toBe(removal.log.transactionHash);
    expect(sender.get(removal.log.transactionHash)).toBe(PROVIDER);
    // Another provider's removal: the creator did not remove liquidity.
    expect(pulled.get(BOOMER)).toBe(false);
  });

  it('a batch of senders that fails loses only its own', async () => {
    const removals = Array.from({ length: 45 }, (_, i) => modify(i, -1n));
    let batch = 0;
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: RpcRequest[]) {
        batch += 1;
        if (batch === 2) throw new Error('busy');
        return requests.map(() => ({ ok: true, value: { from: PROVIDER } }));
      },
    } as unknown as RpcClient;
    const { sender } = await creatorRemovals(rpc, CREATOR, new Set([BOOMER]), removals, [], BOOMER);
    const read = [...sender.values()].filter((s) => s === PROVIDER).length;
    expect(read).toBe(25);
  });

  it('past its time, no sender is asked: "removed by the creator" is unknown, not "no"', async () => {
    let asked = 0;
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: RpcRequest[]) {
        asked += requests.length;
        return requests.map(() => ({ ok: true, value: { from: PROVIDER } }));
      },
    } as unknown as RpcClient;
    const { pulled } = await creatorRemovals(
      rpc,
      CREATOR,
      new Set([BOOMER]),
      [modify(1, -1n)],
      [],
      BOOMER,
      () => 1_000,
      500,
    );
    expect(asked).toBe(0);
    expect(pulled.has(BOOMER)).toBe(false);
  });

  it('a window with too many results is halved until it fits', async () => {
    const calls: { from: number; to: number }[] = [];
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: RpcRequest[]) {
        return requests.map((r) => {
          const q = r.params[0] as { fromBlock: string; toBlock: string };
          const from = Number(q.fromBlock);
          const to = Number(q.toBlock);
          calls.push({ from, to });
          if (to - from + 1 > 2_500_000) {
            return { ok: false, error: 'query returned more than 10000 results' };
          }
          return {
            ok: true,
            value: [{ ...modify(0, -1n).log, blockNumber: `0x${from.toString(16)}` }],
          };
        });
      },
    } as unknown as RpcClient;
    const read = await readWindows(rpc, [
      {
        address: POOL_MANAGER,
        fromBlock: 0,
        toBlock: 9_999_999,
        topics: [MODIFY_LIQUIDITY_TOPIC, BOOMER_MARKET],
      },
    ]);
    expect(read.truncated).toBe(false);
    // 10 M blocks in four quarters, every block covered once.
    expect(read.logs).toHaveLength(4);
    expect(calls.length).toBeLessThanOrEqual(2 + MAX_WINDOW_SPLITS);
  });

  it('a window that never fits is said truncated, not empty', async () => {
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: RpcRequest[]) {
        return requests.map(() => ({ ok: false, error: 'query returned more than 10000 results' }));
      },
    } as unknown as RpcClient;
    const read = await readWindows(rpc, [
      { address: POOL_MANAGER, fromBlock: 0, toBlock: 9_999_999, topics: [MODIFY_LIQUIDITY_TOPIC] },
    ]);
    expect(read.truncated).toBe(true);
  });
});

const MUT8 = '0x48d343cae84ab737c46ce63cb74c926609eb03bb';
const MUT8_CREATOR = '0x619af567afd627f560a55d03cb722e0ed86a3a84';
const OTHERS = [
  '0x115c3f5234efa12173e1d470bc59133ff1240d91',
  '0x0028e5f9131d0b0a38fda1d3c292ab4b55a25a80',
];

/** MUT8 on staging: no removal by the creator, two by other providers, their tokens back to them. */
function mut8Report() {
  return makeReport(MUT8, (r) => {
    r.creator.data.creator = MUT8_CREATOR;
    r.creator.data.origin = {
      source: 'deployer',
      role: 'launcher',
      launchesListed: false,
      launchpadsRead: [],
      launchpadsNotRead: [],
      transactionCount: null,
    };
    const own: LaunchedToken = {
      address: MUT8,
      pool: POOL_MANAGER,
      launchedAtBlock: 91_000_000,
      launchedAt: null,
      outcome: 'undetermined',
      graduationProgress: 0,
      liquidityPulled: false,
      creatorDumped: false,
      liquidityRemovals: OTHERS.map((sender, i) => ({
        transaction: `0x${String(i + 1).padStart(64, '0')}`,
        block: 91_100_000 + i,
        sender,
        by: 'other' as const,
        returned: [{ address: sender, share: 0.00001, isCreator: false, heldNow: 0 }],
      })),
    };
    r.creator.data.tokens = [own];
  });
}

describe('removals by other providers, said apart from the creator’s (item 2)', () => {
  it('the liquidity question states both, and says they do not contradict', () => {
    const report = mut8Report();
    const answer = CATALOG['liquidity-move'].run({ token: MUT8, report } as SpecialistContext);
    expect(answer.facts[0]).toBe(
      'No liquidity removal sent by the creator was observed on this token’s pool in the first 11 days after its launch.',
    );
    expect(answer.facts[1]).toMatch(
      /^Separately, other liquidity providers removed liquidity they had added themselves: 2 removals/,
    );
    expect(answer.facts[1]).toMatch(/the tokens going back to the address that removed them/);
    expect(answer.facts[1]).toMatch(/not the creator’s or the launch liquidity/);
    expect(answer.facts[1]).toMatch(/do not contradict/);
    expect(answer.signal).toBe('quiet');
  });

  it('the prompt labels each removal, and says the two are not contradictory', () => {
    const text = renderReport(mut8Report());
    expect(text).toMatch(
      /Removals of the creator’s or the launch liquidity \(sent by the creator\): none observed\./,
    );
    expect(text).toMatch(/Removals by other liquidity providers, taking back positions[^\n]*: 2\./);
    expect(text).toMatch(/These are not contradictory/);
    expect(text).toMatch(
      /Liquidity removal on this token \(another liquidity provider’s own position; transaction 0x0+1\)/,
    );
    expect(text).toMatch(/of the supply to that same address/);
  });

  it('the facts and the glance say whose liquidity each removal was', () => {
    const facts = toFacts(mut8Report());
    expect(facts.creator.ownRemovals?.map((r) => r.whose)).toEqual([
      'other-provider',
      'other-provider',
    ]);
    const item = buildGlance({ facts })!.items.find((i) => i.id === 'liquidity');
    expect(item?.title).toBe('The creator never removed liquidity on the 1 launch checked.');
    expect(item?.detail).toMatch(
      /other liquidity providers took back positions of their own 2 times/,
    );
  });

  it('moon: the token’s own contract keeping a fee is not where the liquidity went', () => {
    const moon = '0x862cdccb67c8a22fdb247d09a08b1dad09447777';
    const remover = '0xce53140837bda6b9d3192e4301d809cbd970ed5a';
    const transfer = (from: string, to: string, value: bigint): RawLog => ({
      address: moon,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        pad(from),
        pad(to),
      ],
      data: `0x${word(value)}`,
      blockNumber: '0x1',
      transactionHash: '0x666e',
      logIndex: '0x0',
    });
    const got = returnedFrom(
      [transfer(POOL_MANAGER, remover, 99n), transfer(remover, moon, 1n)],
      moon,
      new Set([POOL_MANAGER.toLowerCase()]),
    );
    expect([...got.keys()]).toEqual([remover]);
  });
});

type LaunchFixture = {
  token: string;
  creator: string;
  launchBlock: number;
  pools: string[];
  seconds: Record<string, number>;
  transfers: (string | number)[][];
};

describe('the round trips left out are said (item 3, RH)', () => {
  it('25 round trips, with the same-transaction and liquidity cases stated', async () => {
    const f = rh as LaunchFixture;
    const logs: RawLog[] = f.transfers.map(([block, tx, from, to, value], i) => ({
      address: f.token,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        pad(String(from)),
        pad(String(to)),
      ],
      data: `0x${String(value).padStart(64, '0')}`,
      blockNumber: `0x${Number(block).toString(16)}`,
      transactionHash: String(tx),
      logIndex: `0x${i.toString(16)}`,
    }));
    const markets = new Set(f.pools);
    const pools = new Set([...markets, ...launchInfrastructure().keys()]);
    const relayed: RelayedTrip[] = [];
    // Read on chain on 18/10/2026: these two transactions created and funded
    // a v4 pool (Initialize, ModifyLiquidity), they were not sales.
    const natures = new Map<string, TxNature>([
      ['0xd8980d59b46d930abedd31154303fb38bff7458f22a8ecfc6c1a18c18a0b568f', 'liquidity'],
      ['0xbddbb4127ac4e0028f9d6410f5e6cef9f4616f7c005fc09e402793d3b7f60a30', 'liquidity'],
    ]);
    const drafts = draftMoves(logs, pools, markets, relayed);
    const moves = (await separateLiquidity({} as RpcClient, drafts, pools, natures)).map((m) => ({
      ...m,
      seconds: f.seconds[String(m.block)] ?? 0,
    }));
    expect(relayed.map((r) => r.address)).toContain('0xb05500000005255c2812826856b92621b889678b');
    const tally = tallyLaunch(moves, {
      creator: f.creator,
      from: f.launchBlock,
      pools,
      supply: 10n ** 27n,
      natures,
      relayed,
    });
    const summary = summarize(tally, new Map(), {
      receiptsRead: 0,
      receiptsWanted: 0,
      balancesRead: 0,
      balancesWanted: 0,
      moves: moves.length,
    });
    const trips = summary.roundTrips!;
    expect(trips.wallets).toBe(25);
    expect(trips.excluded).toEqual({ sameTransaction: 1, liquidity: 2 });
    const replay: LaunchReplay = {
      completeness: 'partial',
      sources: [{ name: 'robinhood-rpc', fetchedAt: '' }],
      data: {
        token: f.token,
        launchBlock: f.launchBlock,
        launchedAt: null,
        windowSeconds: 600,
        supply: (10n ** 27n).toString(),
        moves: [],
        movesInWindow: moves.length,
        summary,
      },
    };
    expect(renderLaunch(replay).join('\n')).toMatch(
      /Round trips over every move of the window: 25 addresses bought and then sold back within it, [^\n]* \(3 more excluded: 1 bought and sold back within one single transaction, never holding the token; 2 put the tokens back into a pool as liquidity rather than selling\)\. Quote 25 as the count/,
    );
  });
});
