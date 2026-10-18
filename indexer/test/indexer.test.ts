import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  decodeLaunch,
  decodeLaunchOf,
  decodeSwap,
  LAUNCHPADS,
  swapSide,
  type LaunchpadSource,
} from '../src/abi.ts';
import { createApi, sameToken } from '../src/api.ts';
import { createClock } from '../src/clock.ts';
import { openDb, type SwapInsert } from '../src/db.ts';
import { classifyLogError, createRpc, TooBroadError, TooManySelectorsError } from '../src/rpc.ts';
import { newWindow, readChunk } from '../src/scan.ts';
import { tokenStats } from '../src/stats.ts';
import { firstIncoming, fundingStream } from '../src/streams/funding.ts';
import { cursorName, launchFrontier, launchStream } from '../src/streams/launches.ts';
import { BACK, FORWARD, swapStream, TARGET } from '../src/streams/swaps.ts';
import { MARKETS } from '../src/streams/markets.ts';
import { fakeRpc, fixedClock, launchLog, memoryDb, pad, swapLog, topic } from './helpers.ts';

const FACTORY = '0x00000000000000000000000000000000000000f1';
const TOKEN = '0x000000000000000000000000000000000000000b';
const POOL = '0x00000000000000000000000000000000000000c1';
const CREATOR = '0x00000000000000000000000000000000000000d1';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const SECRET = 'test-token-0123456789abcdefghij';
const silent = () => undefined;

describe('classifyLogError', () => {
  it('reads the span ceiling the node states', () => {
    const e = classifyLogError(
      'query spans 999983 blocks (89820369 to 90820351), but only 100000 are allowed for this request',
    );
    expect(e).toBeInstanceOf(TooBroadError);
    expect((e as TooBroadError).maxSpan).toBe(100_000);
  });

  it('does not mistake the address-list ceiling for a span ceiling', () => {
    const e = classifyLogError(
      '2001 address and topic selectors specified in query, but only 1000 are allowed',
    );
    expect(e).toBeInstanceOf(TooManySelectorsError);
    expect((e as TooManySelectorsError).max).toBe(1000);
  });

  it('treats too many results as too broad', () => {
    expect(classifyLogError('logs matched by query exceeds limit of 10000')).toBeInstanceOf(
      TooBroadError,
    );
    expect(classifyLogError('execution reverted')).toBeNull();
  });
});

describe('readChunk', () => {
  it('halves the window on a too-broad error, then grows it back', async () => {
    const rpc = fakeRpc({});
    let refusals = 0;
    rpc.getLogs = async (filter) => {
      rpc.queries.push(filter);
      if (filter.toBlock - filter.fromBlock + 1 > 25_000) {
        refusals += 1;
        throw new TooBroadError('logs matched by query exceeds limit of 10000');
      }
      return [];
    };
    const window = newWindow(100_000);
    const chunk = await readChunk(rpc, { topics: [] }, 1, 1_000_000, window);
    // 100,000 then 50,000 refused, 25,000 accepted.
    expect(refusals).toBe(2);
    expect(chunk).toMatchObject({ from: 1, to: 25_000 });
    // A light answer doubles the next window.
    expect(window.span).toBe(50_000);
  });

  it('uses the ceiling the node states instead of halving blindly', async () => {
    const rpc = fakeRpc({});
    rpc.getLogs = async (filter) => {
      if (filter.toBlock - filter.fromBlock + 1 > 30_000) {
        throw new TooBroadError('only 30000 are allowed', 30_000);
      }
      return [];
    };
    const window = newWindow(10_000_000);
    const chunk = await readChunk(rpc, { topics: [] }, 0, 5_000_000, window);
    expect(chunk.to - chunk.from + 1).toBe(30_000);
    expect(window.max).toBe(30_000);
  });

  it('reads backwards, ending at `to`', async () => {
    const rpc = fakeRpc({});
    const chunk = await readChunk(rpc, { topics: [] }, 0, 500, newWindow(100), 'backward');
    expect(chunk).toMatchObject({ from: 401, to: 500 });
  });
});

describe('createRpc', () => {
  it('waits and retries after a 429 instead of failing', async () => {
    let calls = 0;
    const waits: number[] = [];
    let clock = 0;
    const rpc = createRpc({
      url: 'http://node',
      rate: 1000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      fetch: (async () => {
        calls += 1;
        if (calls < 3) return new Response('Too Many Requests', { status: 429 });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }));
      }) as typeof fetch,
    });
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe('0x10');
    expect(calls).toBe(3);
    expect(rpc.stats().rateLimited).toBe(2);
    expect(waits.some((ms) => ms >= 2_000)).toBe(true);
  });

  it('raises a too-broad error on a refused log query, without retrying', async () => {
    let calls = 0;
    const rpc = createRpc({
      url: 'http://node',
      rate: 1000,
      fetch: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ id: 1, error: { code: -32000, message: 'exceeds limit of 10000' } }),
        );
      }) as typeof fetch,
    });
    await expect(rpc.getLogs({ topics: [], fromBlock: 0, toBlock: 10 })).rejects.toBeInstanceOf(
      TooBroadError,
    );
    expect(calls).toBe(1);
  });
});

describe('clock', () => {
  it('interpolates between anchors and ignores the genesis block, stamped 0', async () => {
    const db = memoryDb();
    let headers = 0;
    // 10 blocks per second from block 1, as on Robinhood Chain; genesis says 1970.
    const ts = (n: number) => (n === 0 ? 0 : 1_780_000_000 + Math.floor(n / 10));
    const rpc = fakeRpc({
      call: (r) => {
        if (r.method !== 'eth_getBlockByNumber') return null;
        headers += 1;
        const tag = r.params[0] as string;
        const n = tag === 'latest' ? 120_000 : Number(tag);
        return { number: `0x${n.toString(16)}`, timestamp: `0x${ts(n).toString(16)}` };
      },
    });
    const clock = createClock(rpc, db);
    await clock.observeHead();
    const times = await clock.timesOf([9_505, 75_000, 119_990]);
    expect(times.get(9_505)).toBe(ts(9_505));
    expect(times.get(75_000)).toBe(ts(75_000));
    expect(times.get(119_990)).toBe(ts(119_990));
    // Anchors are read once: asking again costs nothing.
    const before = headers;
    await clock.timesOf([9_000, 80_000]);
    expect(headers).toBe(before);
  });
});

describe('decoding', () => {
  it('decodes a TokenLaunched log', () => {
    const row = decodeLaunch(
      launchLog({ factory: FACTORY, token: TOKEN, creator: CREATOR, pool: POOL, block: 77 }),
    );
    expect(row).toMatchObject({
      token: TOKEN,
      creator: CREATOR,
      pool: POOL,
      pairToken: WETH,
      positionId: '7',
      initialBuyAmount: '1000000000000000000',
      block: 77,
    });
  });

  it('derives the side from the token position in the pool', () => {
    const swap = decodeSwap(
      swapLog({ pool: POOL, recipient: CREATOR, amount0: -5n, amount1: 9n, block: 1 }),
    );
    expect(swap.amount0).toBe(-5n);
    expect(swap.amount1).toBe(9n);
    // The token left the pool: a buy when it is token0…
    expect(swapSide(swap, true)).toBe('buy');
    // …and the pair token left it when the token is token1: a sell.
    expect(swapSide(swap, false)).toBe('sell');
  });
});

describe('launch stream', () => {
  const factories = [{ address: FACTORY, fromBlock: 100, toBlock: 1_000 }];

  it('resumes from its cursor after a restart and never doubles a row', async () => {
    const db = memoryDb();
    const logs = [
      launchLog({ factory: FACTORY, token: TOKEN, creator: CREATOR, pool: POOL, block: 150 }),
      launchLog({
        factory: FACTORY,
        token: '0x000000000000000000000000000000000000000e',
        creator: CREATOR,
        pool: '0x00000000000000000000000000000000000000c2',
        block: 700,
      }),
    ];
    const rpc = fakeRpc({
      logs: (f) =>
        logs.filter(
          (l) => Number(l.blockNumber) >= f.fromBlock && Number(l.blockNumber) <= f.toBlock,
        ),
    });
    // The node only takes 400 blocks at a time.
    const narrow = rpc.getLogs.bind(rpc);
    rpc.getLogs = async (f) => {
      if (f.toBlock - f.fromBlock + 1 > 400) throw new TooBroadError('only 400 are allowed', 400);
      return narrow(f);
    };
    const clock = fixedClock(2_000);
    const first = launchStream({ rpc, db, clock, log: silent, factories });
    expect(await first.step()).toBe(true);
    expect(db.cursor(cursorName(FACTORY))).toBe(499);
    expect(db.count('launches')).toBe(1);

    // A new process: it starts where the last one stopped.
    const second = launchStream({ rpc, db, clock, log: silent, factories });
    rpc.queries.length = 0;
    await second.step();
    expect(rpc.queries[0]?.fromBlock).toBe(500);
    while (await second.step());
    expect(db.cursor(cursorName(FACTORY))).toBe(1_000);
    expect(db.count('launches')).toBe(2);

    // Replaying a window is harmless.
    db.setCursor(cursorName(FACTORY), 99);
    while (await second.step());
    expect(db.count('launches')).toBe(2);
    // A closed factory, fully read, no longer holds the frontier back.
    expect(launchFrontier(db, factories)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('swap streams', () => {
  it('anchors at the launch frontier, keeps pons swaps only, and backfills down to the target', async () => {
    const db = memoryDb();
    db.insertLaunches([
      {
        ...decodeLaunch(
          launchLog({ factory: FACTORY, token: TOKEN, creator: CREATOR, pool: POOL, block: 10 }),
        ),
        ts: 1,
      },
    ]);
    // Every pons factory read up to the head.
    for (const f of (await import('../src/abi.ts')).PONS_FACTORIES) {
      db.setCursor(cursorName(f.address), f.toBlock ?? 1_000_000);
    }
    const swaps = [
      swapLog({
        pool: POOL,
        recipient: CREATOR,
        amount0: -100n,
        amount1: 5n,
        block: 999_990,
        logIndex: 1,
      }),
      swapLog({
        pool: POOL,
        recipient: CREATOR,
        amount0: 40n,
        amount1: -2n,
        block: 1_000_005,
        logIndex: 2,
      }),
      // Another pool, not a pons launch.
      swapLog({
        pool: '0x00000000000000000000000000000000000000ff',
        recipient: CREATOR,
        amount0: 1n,
        amount1: -1n,
        block: 1_000_006,
      }),
    ];
    const rpc = fakeRpc({
      logs: (f) =>
        swaps.filter(
          (l) =>
            Number(l.blockNumber) >= f.fromBlock &&
            Number(l.blockNumber) <= f.toBlock &&
            (!f.address || (f.address as string[]).includes(l.address)),
        ),
      call: (r) => {
        if (r.method === 'eth_call') return `0x${TOKEN.slice(2).padStart(64, '0')}`;
        if (r.method === 'eth_getTransactionByHash')
          return { from: '0x00000000000000000000000000000000000000e0' };
        return null;
      },
    });
    const clock = fixedClock(1_000_010);
    const stream = swapStream({ rpc, db, clock, log: silent, backfillDays: 0.0001 });

    // Anchored at the launch frontier: nothing past it is read yet.
    expect(await stream.forward.step()).toBe(false);
    expect(db.cursor(FORWARD)).toBe(1_000_000);
    expect(db.cursor(TARGET)).toBe(1_000_000 - 86);
    // The launches move on: so do the swaps, up to them.
    for (const f of (await import('../src/abi.ts')).PONS_FACTORIES) {
      if (f.toBlock === undefined) db.setCursor(cursorName(f.address), 1_000_010);
    }
    expect(await stream.forward.step()).toBe(true);
    expect(db.cursor(FORWARD)).toBe(1_000_010);
    expect(db.count('swaps')).toBe(1);

    while (await stream.back.step());
    expect(db.cursor(BACK)).toBe(db.cursor(TARGET));
    expect(db.count('swaps')).toBe(2);
    const sides = db.raw.prepare('SELECT side, origin FROM swaps ORDER BY block').all();
    expect(sides).toEqual([
      { side: 'buy', origin: '0x00000000000000000000000000000000000000e0' },
      { side: 'sell', origin: '0x00000000000000000000000000000000000000e0' },
    ]);
    expect(db.token0(POOL)).toBe(TOKEN);
  });
});

function swap(over: Partial<SwapInsert> & { ts: number; side: 'buy' | 'sell' }): SwapInsert {
  return {
    txHash: `0x${Math.random().toString(16).slice(2)}`,
    logIndex: 0,
    pool: POOL,
    token: TOKEN,
    block: over.ts,
    sender: '0xrouter',
    recipient: '0xr',
    origin: '0xa',
    amount0: over.side === 'buy' ? '-1000' : '1000',
    amount1: over.side === 'buy' ? '10' : '-10',
    ...over,
  };
}

describe('tokenStats', () => {
  it('aggregates each window, the top traders and whether the creator traded', () => {
    const db = memoryDb();
    const now = 10_000_000;
    db.insertSwaps([
      swap({ ts: now - 60, side: 'buy', origin: '0xa' }),
      swap({ ts: now - 120, side: 'sell', origin: '0xb', amount1: '-30' }),
      swap({ ts: now - 7_200, side: 'buy', origin: CREATOR }),
      swap({ ts: now - 3 * 86_400, side: 'buy', origin: '0xa', amount1: '50' }),
      swap({ ts: now - 30 * 86_400, side: 'sell', origin: '0xc' }),
    ]);
    const stats = tokenStats(db, TOKEN, { creator: CREATOR, tokenIsToken0: true, nowSec: now });
    expect(stats.windows.h1).toMatchObject({ buys: 1, sells: 1, uniqueTraders: 2, volume: '40' });
    expect(stats.windows.h24).toMatchObject({ buys: 2, sells: 1, uniqueTraders: 3, volume: '50' });
    expect(stats.windows.d7).toMatchObject({ buys: 3, sells: 1, volume: '100' });
    expect(stats.windows.sinceLaunch).toMatchObject({
      buys: 3,
      sells: 2,
      uniqueTraders: 4,
      volume: '110',
    });
    expect(stats.windows.h1.lastTradeAt).toBe(new Date((now - 60) * 1000).toISOString());
    expect(stats.topTraders7d[0]).toMatchObject({
      address: '0xa',
      buys: 2,
      volume: '60',
      netToken: '2000',
    });
    expect(stats.topTraders7d.find((t) => t.address === CREATOR)?.isCreator).toBe(true);
    expect(stats.creator).toEqual({ traded: true, buys: 1, sells: 0 });
  });
});

describe('API', () => {
  function api(fundingEnabled = false) {
    const db = memoryDb();
    db.insertLaunches([
      {
        ...decodeLaunch(
          launchLog({ factory: FACTORY, token: TOKEN, creator: CREATOR, pool: POOL, block: 10 }),
        ),
        ts: 1_700_000_000,
      },
    ]);
    const handle = createApi({
      db,
      clock: fixedClock(500),
      rpc: { stats: () => ({ requests: 0, rateLimited: 0 }) },
      token: SECRET,
      fundingEnabled,
      nowSec: () => 1_700_000_100,
    });
    const get = (url: string, auth: string | undefined = `Bearer ${SECRET}`) =>
      handle({ method: 'GET', url, authorization: auth });
    return { db, get };
  }

  it('compares tokens in constant time, whatever their length', () => {
    expect(sameToken(SECRET, SECRET)).toBe(true);
    expect(sameToken('short', SECRET)).toBe(false);
  });

  it('requires the bearer token everywhere but /health', () => {
    const { get } = api();
    expect(get('/health', '').status).toBe(200);
    expect(get(`/v1/token/${TOKEN}`, '').status).toBe(401);
    expect(get(`/v1/token/${TOKEN}`, 'Bearer wrong').status).toBe(401);
    expect(get(`/v1/token/${TOKEN}`, SECRET).status).toBe(401);
    expect(get(`/v1/token/${TOKEN}`).status).toBe(200);
  });

  it('validates and lowercases addresses, and answers 404 for unknown ones', () => {
    const { get } = api();
    expect(get('/v1/token/not-an-address').status).toBe(400);
    expect(get(`/v1/creator/${CREATOR.toUpperCase().replace('0X', '0x')}`).status).toBe(200);
    expect(get('/v1/token/0x00000000000000000000000000000000000000aa').status).toBe(404);
    expect(get('/v1/nope/x').status).toBe(404);
  });

  it('says whether funding is disabled, pending, found or absent', () => {
    const off = api(false);
    expect((off.get(`/v1/creator/${CREATOR}`).body as { fundingState: string }).fundingState).toBe(
      'disabled',
    );
    const on = api(true);
    expect((on.get(`/v1/creator/${CREATOR}`).body as { fundingState: string }).fundingState).toBe(
      'pending',
    );
    on.db.setFunding({
      creator: CREATOR,
      status: 'none',
      funder: null,
      txHash: null,
      block: null,
      kind: null,
    });
    expect(on.get(`/v1/creator/${CREATOR}`).body).toMatchObject({
      fundingState: 'none',
      funding: null,
    });
    on.db.setFunding({
      creator: CREATOR,
      status: 'found',
      funder: '0xf0',
      txHash: '0x1',
      block: 5,
      kind: 'tx',
    });
    const other = '0x00000000000000000000000000000000000000d2';
    on.db.insertLaunches([
      {
        ...decodeLaunch(
          launchLog({
            factory: FACTORY,
            token: '0x000000000000000000000000000000000000000c',
            creator: other,
            pool: POOL,
            block: 11,
          }),
        ),
        ts: 1_700_000_001,
      },
    ]);
    on.db.setFunding({
      creator: other,
      status: 'found',
      funder: '0xf0',
      txHash: '0x2',
      block: 6,
      kind: 'tx',
    });
    // Not profiled yet: its creators are not listed as linked.
    expect(on.get(`/v1/creator/${CREATOR}`).body).toMatchObject({
      fundingState: 'found',
      funding: { funder: '0xf0', funderKind: 'unknown', otherCreatorsFunded: [] },
    });
    on.db.setFunder(
      { address: '0xf0', isContract: false, name: null, txCount: 33, tags: [] },
      'wallet',
    );
    expect(on.get(`/v1/creator/${CREATOR}`).body).toMatchObject({
      fundingState: 'found',
      funding: {
        funder: '0xf0',
        funderKind: 'wallet',
        funderTxCount: 33,
        effective: '0xf0',
        otherCreatorsFunded: [other],
      },
    });
  });

  it('includes indexedTo and the swap coverage in the token answer', () => {
    const { db, get } = api();
    db.setCursor(FORWARD, 480);
    db.setCursor(BACK, 5);
    const body = get(`/v1/token/${TOKEN}`).body as Record<string, unknown>;
    expect(body).toMatchObject({ indexedTo: 480, coveredFrom: 5, sinceLaunchComplete: true });
    expect(body.launch).toMatchObject({
      creator: CREATOR,
      pool: POOL,
      timestamp: '2023-11-14T22:13:20.000Z',
    });
  });

  // Fifth audit: a recent window counted "1 market" on the hook 0xe5e7…
  // for each of MUT8, HYPURRT, WAFER and COVENANT. The indexer counts them all.
  it('counts every market on a hook, over the whole history read', () => {
    const { db, get } = api();
    const hook = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
    const eth = '0x0000000000000000000000000000000000000000';
    const tokens = [
      '0x48d343cae84ab737c46ce63cb74c926609eb03bb',
      '0xff6a3387cf21ef2ed2e94da324bce290ca9abc3b',
      '0x9182f4791dd6ac83323a935760c5cfe2ad25361b',
      '0x2eef2a627ac024cb9f545f6193b1940f0416a1de',
    ];
    db.insertMarkets(
      tokens.map((token, i) => ({
        id: `0x${String(i + 1).padStart(64, '0')}`,
        currency0: eth,
        currency1: token,
        fee: 0,
        tickSpacing: 60,
        hook,
        block: 100 + i,
        txHash: `0x${String(i + 1).padStart(64, 'a')}`,
        logIndex: 0,
        ts: null,
      })),
    );
    db.setCursor(MARKETS, 490);
    expect(get(`/v1/hook/${hook}`).body).toEqual({
      hook,
      indexedTo: 490,
      markets: 4,
      pairs: 4,
      firstBlock: 100,
      lastBlock: 103,
    });
    // A hook no market runs is an answer too: none.
    expect(get(`/v1/hook/0x${'1'.repeat(40)}`).body).toMatchObject({ markets: 0, indexedTo: 490 });
  });
});

describe('funding', () => {
  it('takes the first incoming transfer of value, normal or internal', () => {
    expect(
      firstIncoming(CREATOR, [
        { to: '0xelse', from: '0x1', value: '5', blockNumber: '1', hash: '0xa' },
        { to: CREATOR, from: '0x2', value: '0', blockNumber: '2', hash: '0xb' },
        { to: CREATOR, from: '0x3', value: '9', blockNumber: '3', hash: '0xC', isError: '1' },
        { to: CREATOR, from: '0x4', value: '9', blockNumber: '4', hash: '0xD' },
      ]),
    ).toEqual({ from: '0x4', txHash: '0xd', block: 4 });
  });

  it('records "none found" apart from "not read yet", and retries after a 429', async () => {
    const db = memoryDb();
    db.insertLaunches([
      {
        ...decodeLaunch(
          launchLog({ factory: FACTORY, token: TOKEN, creator: CREATOR, pool: POOL, block: 10 }),
        ),
        ts: 1,
      },
    ]);
    let calls = 0;
    const stream = fundingStream({
      db,
      apiKey: 'k',
      log: silent,
      sleep: async () => undefined,
      fetch: (async (url: string) => {
        calls += 1;
        if (calls === 1) return new Response('slow down', { status: 429 });
        expect(String(url)).toContain('sort=asc');
        return Response.json({ status: '0', message: 'No transactions found', result: [] });
      }) as unknown as typeof fetch,
    });
    expect(db.raw.prepare('SELECT * FROM funding').all()).toEqual([]);
    expect(await stream.step()).toBe(true);
    expect(db.raw.prepare('SELECT creator, status FROM funding').all()).toEqual([
      { creator: CREATOR, status: 'none' },
    ]);
    expect(await stream.step()).toBe(false);
  });

  it('stays within its daily Blockscout calls, spread over the day, the queue first', async () => {
    const db = memoryDb();
    const other = '0x00000000000000000000000000000000000000b2';
    db.insertLaunches(
      [CREATOR, other].map((creator, i) => ({
        ...decodeLaunch(
          launchLog({
            factory: FACTORY,
            token: `0x${String(i + 1).padStart(40, '0')}`,
            creator,
            pool: POOL,
            block: 10 + i,
          }),
        ),
        ts: 1,
      })),
    );
    let clock = 1_000_000_000_000;
    let calls = 0;
    const stream = fundingStream({
      db,
      apiKey: 'k',
      log: silent,
      now: () => clock,
      sleep: async () => undefined,
      dailyCalls: 2,
      fetch: (async () => {
        calls += 1;
        return Response.json({ status: '0', message: 'No transactions found', result: [] });
      }) as unknown as typeof fetch,
    });
    // A creator asked for through the API goes first.
    stream.prioritize(other);
    expect(await stream.step()).toBe(true);
    expect(calls).toBe(2);
    expect(stream.usage()).toEqual({ callsToday: 2, dailyCalls: 2 });
    // The day's calls are spent: nothing more until tomorrow, even when asked.
    stream.prioritize(CREATOR);
    expect(await stream.step()).toBe(false);
    expect(calls).toBe(2);
    clock += 86_400_000;
    expect(await stream.step()).toBe(true);
    expect(calls).toBe(4);
  });
});

describe('launchpads', () => {
  const FLAP = LAUNCHPADS.find((l) => l.id === 'flap') as LaunchpadSource;
  const CURVE = LAUNCHPADS.find((l) => l.id === 'curve-7ed5') as LaunchpadSource;
  const FLAP_TOKEN = '0x00000000000000000000000000000000000f7777';
  const CURVE_TOKEN = '0x000000000000000000000000000000000000c0de';

  /** flap.sh `TokenCreated(ts, creator, nonce, token, name, symbol, meta)`: nothing indexed. */
  function flapLog(block: number, creator = CREATOR, token = FLAP_TOKEN) {
    const words = [
      pad('6ad2a579'),
      pad(creator),
      pad('5add6'),
      pad(token),
      pad('e0'),
      pad('120'),
      pad('160'),
    ];
    return {
      address: FLAP.address,
      topics: [FLAP.topic0],
      data: `0x${words.join('')}`,
      blockNumber: `0x${block.toString(16)}`,
      transactionHash: `0x${pad(`f${block.toString(16)}`)}`,
      logIndex: '0x0',
    };
  }

  /** `TokenLaunched(token, curve, creator indexed; …)` of 0x7ed5. */
  function curveLog(block: number) {
    return {
      address: CURVE.address,
      topics: [
        CURVE.topic0,
        topic(CURVE_TOKEN),
        topic('0x00000000000000000000000000000000000000c7'),
        topic(CREATOR),
      ],
      data: `0x${pad('0')}${pad('0')}${pad('1')}`,
      blockNumber: `0x${block.toString(16)}`,
      transactionHash: `0x${pad(`c${block.toString(16)}`)}`,
      logIndex: '0x1',
    };
  }

  it('reads the creator where each launchpad puts it: a data word, or a topic', () => {
    expect(decodeLaunchOf(FLAP, flapLog(5_000_000))).toMatchObject({
      launchpad: 'flap',
      token: FLAP_TOKEN,
      creator: CREATOR,
      factory: FLAP.address,
      // No pool is named: never mistaken for a pons pool by the swap stream.
      pool: '',
    });
    expect(decodeLaunchOf(CURVE, curveLog(30_000_000))).toMatchObject({
      launchpad: 'curve-7ed5',
      token: CURVE_TOKEN,
      creator: CREATOR,
    });
    // A pons launch keeps its full reading.
    const pons = LAUNCHPADS.find((l) => l.id === 'pons') as LaunchpadSource;
    expect(
      decodeLaunchOf(
        pons,
        launchLog({
          factory: pons.address,
          token: TOKEN,
          creator: CREATOR,
          pool: POOL,
          block: 40_000_001,
        }),
      ),
    ).toMatchObject({ launchpad: 'pons', pool: POOL, pairToken: WETH });
  });

  it('starts each new launchpad at its own first block, without touching the pons cursors', async () => {
    const db = memoryDb();
    const pons = { address: FACTORY, fromBlock: 100 };
    db.setCursor(cursorName(FACTORY), 6_000_000);
    const rpc = fakeRpc({
      logs: (f) =>
        f.address === FLAP.address && f.fromBlock <= 5_000_000 && f.toBlock >= 5_000_000
          ? [flapLog(5_000_000)]
          : [],
    });
    const stream = launchStream({
      rpc,
      db,
      clock: fixedClock(6_000_000),
      log: silent,
      factories: [pons, FLAP],
    });
    while (await stream.step());
    const flapQueries = rpc.queries.filter((q) => q.address === FLAP.address);
    expect(flapQueries[0]?.fromBlock).toBe(FLAP.fromBlock);
    expect(rpc.queries.some((q) => q.address === FACTORY)).toBe(false);
    expect(db.cursor(cursorName(FACTORY))).toBe(6_000_000);
    expect(db.cursor(cursorName(FLAP.address))).toBe(6_000_000);
    const row = db.raw
      .prepare('SELECT launchpad, creator FROM launches WHERE token = ?')
      .get(FLAP_TOKEN);
    expect(row).toEqual({ launchpad: 'flap', creator: CREATOR });
    // The pons frontier is what the swaps wait on: another launchpad never holds it back.
    expect(launchFrontier(db, [pons])).toBe(6_000_000);
  });

  it('adds the launchpad column to a database created before it, the old rows read as pons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seal-indexer-'));
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE launches (
      tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, token TEXT NOT NULL, creator TEXT NOT NULL,
      pool TEXT NOT NULL, factory TEXT NOT NULL, dex_factory TEXT NOT NULL, pair_token TEXT NOT NULL,
      position_id TEXT NOT NULL, initial_buy TEXT NOT NULL, block INTEGER NOT NULL, ts INTEGER,
      PRIMARY KEY (tx_hash, log_index)) WITHOUT ROWID;
    CREATE TABLE cursors (stream TEXT PRIMARY KEY, block INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO launches VALUES ('0xold', 0, '${TOKEN}', '${CREATOR}', '${POOL}', '${FACTORY}', '', '${WETH}', '1', '0', 10, NULL);
    INSERT INTO cursors VALUES ('launches:${FACTORY}', 1234, 0);`);
    old.close();

    const db = openDb(path);
    try {
      expect(
        db.raw.prepare('SELECT launchpad FROM launches WHERE tx_hash = ?').get('0xold'),
      ).toEqual({
        launchpad: 'pons',
      });
      expect(db.cursor(cursorName(FACTORY))).toBe(1234);
      // Opening it again is harmless.
      db.close();
      const again = openDb(path);
      expect(again.count('launches')).toBe(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists a creator’s launches across launchpads, and says how far each one is read', () => {
    const db = memoryDb();
    db.insertLaunches([
      {
        ...decodeLaunch(
          launchLog({ factory: FACTORY, token: TOKEN, creator: CREATOR, pool: POOL, block: 10 }),
        ),
        ts: null,
      },
      {
        ...(decodeLaunchOf(FLAP, flapLog(20)) as NonNullable<ReturnType<typeof decodeLaunchOf>>),
        ts: null,
      },
    ]);
    db.setCursor(cursorName(FLAP.address), 450);
    const handle = createApi({
      db,
      clock: fixedClock(500),
      rpc: { stats: () => ({ requests: 0, rateLimited: 0 }) },
      token: SECRET,
      fundingEnabled: false,
    });
    const get = (url: string) => handle({ method: 'GET', url, authorization: `Bearer ${SECRET}` });
    const creator = get(`/v1/creator/${CREATOR}`).body as {
      launchCount: number;
      launches: { token: string; launchpad: string; txHash: string }[];
      launchpads: Record<string, number>;
    };
    expect(creator.launchCount).toBe(2);
    expect(creator.launches.map((l) => l.launchpad).sort()).toEqual(['flap', 'pons']);
    expect(creator.launches.every((l) => l.txHash.startsWith('0x'))).toBe(true);
    expect(creator.launchpads.flap).toBe(450);
    const coverage = get('/v1/coverage');
    expect(coverage.status).toBe(200);
    expect((coverage.body as { launchpads: Record<string, number> }).launchpads.flap).toBe(450);
    // Swaps are counted for pons pools only: another launchpad's token is not one.
    expect(get(`/v1/token/${FLAP_TOKEN}`).status).toBe(404);
    expect(get(`/v1/token/${TOKEN}`).status).toBe(200);
    expect(handle({ method: 'GET', url: '/v1/coverage' }).status).toBe(401);
  });
});
