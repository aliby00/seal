import { describe, expect, it } from 'vitest';
import {
  draftMoves,
  MAX_MOVES,
  readLaunchReplay,
  selectMoves,
  separateLiquidity,
} from '../../src/lib/chain/launch';
import type { RawLog } from '../../src/lib/chain/logs';
import { LogQueryTooBroadError, type RpcClient } from '../../src/lib/chain/rpc';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const word = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

let index = 0;
function transfer(from: string, to: string, value: bigint, block: number, tx: string): RawLog {
  return {
    address: addr(999),
    topics: [TRANSFER, word(from), word(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: tx,
    logIndex: `0x${(index++).toString(16)}`,
  };
}

const FACTORY = addr(1);
const POOL = addr(2);
const CREATOR = addr(3);
const BUYER = addr(4);
const ROUTER = addr(5);
const SUPPLY = 1_000_000n;

describe('draftMoves', () => {
  it('folds a launch contract that keeps a fee: supply is created for the pool, the creator buys', () => {
    const moves = draftMoves(
      [
        transfer(ZERO, FACTORY, SUPPLY, 10, '0xa'),
        transfer(FACTORY, POOL, SUPPLY - 1n, 10, '0xa'),
        transfer(POOL, CREATOR, 500n, 10, '0xa'),
      ],
      new Set([POOL]),
    );
    expect(moves.map((m) => [m.kind, m.actor, m.counterparty, m.value])).toEqual([
      ['mint', POOL, ZERO, SUPPLY - 1n],
      ['buy', CREATOR, POOL, 500n],
    ]);
  });

  it('attributes a purchase routed through a contract to the wallet that ends with the tokens', () => {
    const moves = draftMoves(
      [transfer(POOL, ROUTER, 300n, 20, '0xb'), transfer(ROUTER, BUYER, 300n, 20, '0xb')],
      new Set([POOL]),
    );
    expect(moves).toEqual([
      expect.objectContaining({ kind: 'buy', actor: BUYER, counterparty: POOL, value: 300n }),
    ]);
  });

  it('reads a sale from the seller side and a plain transfer as an allocation', () => {
    const moves = draftMoves(
      [transfer(BUYER, POOL, 100n, 30, '0xc'), transfer(CREATOR, BUYER, 50n, 31, '0xd')],
      new Set([POOL]),
    );
    expect(moves.map((m) => [m.kind, m.actor, m.counterparty])).toEqual([
      ['sell', BUYER, POOL],
      ['allocation', BUYER, CREATOR],
    ]);
  });

  it('keeps an address that holds what it received: it is a recipient, not a relay', () => {
    const moves = draftMoves(
      [transfer(ZERO, CREATOR, 1000n, 1, '0xe'), transfer(CREATOR, BUYER, 400n, 1, '0xe')],
      new Set([POOL]),
    );
    expect(moves.map((m) => [m.kind, m.actor, m.value])).toEqual([
      ['mint', CREATOR, 1000n],
      ['allocation', BUYER, 400n],
    ]);
  });
});

describe('selectMoves', () => {
  const move = (i: number, value: bigint, actor = `0x${String(i).padStart(40, '0')}`) => ({
    kind: 'buy' as const,
    actor,
    counterparty: '0xpool',
    value,
    block: i,
    transaction: `0x${i}`,
  });

  it('garde tout quand la fenêtre est courte', () => {
    const moves = Array.from({ length: 12 }, (_, i) => move(i, 1n));
    expect(selectMoves(moves, null)).toHaveLength(12);
  });

  // The live case: the creator's sale of 72 % sat at the ninth minute, past the
  // first forty moves.
  it('garde les mouvements du créateur et les plus gros, même tardifs', () => {
    const creator = '0xc0ffee0000000000000000000000000000000000';
    const moves = Array.from({ length: 1_500 }, (_, i) => move(i, 1n));
    moves[1_200] = { ...move(1_200, 10n ** 27n, creator), kind: 'sell' as never };
    moves[900] = move(900, 10n ** 20n);
    const kept = selectMoves(moves, creator);
    expect(kept).toHaveLength(MAX_MOVES);
    expect(kept.map((m) => m.block)).toContain(1_200);
    expect(kept.map((m) => m.block)).toContain(900);
    expect(kept.map((m) => m.block)).toEqual([...kept.map((m) => m.block)].sort((a, b) => a - b));
  });
});

describe('separateLiquidity', () => {
  const SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
  const MINT = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
  const receipts = (events: Record<string, string | null>): RpcClient =>
    ({
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: { params: string[] }[]) {
        return requests.map(({ params }) => {
          const topic = events[params[0] as string];
          return topic
            ? { ok: true, value: { logs: [{ address: POOL, topics: [topic], data: '0x' }] } }
            : { ok: false, error: 'missing' };
        });
      },
    }) as unknown as RpcClient;

  it('reads a transfer into the pool without a swap as liquidity, not a sale', async () => {
    const moves = draftMoves(
      [
        transfer(CREATOR, POOL, 100n, 30, '0xadd'),
        transfer(BUYER, POOL, 50n, 31, '0xsale'),
        transfer(POOL, CREATOR, 40n, 32, '0xpull'),
      ],
      new Set([POOL]),
    );
    const out = await separateLiquidity(
      receipts({ '0xadd': MINT, '0xsale': SWAP, '0xpull': MINT }),
      moves,
      new Set([POOL]),
    );
    expect(out.map((m) => [m.kind, m.actor])).toEqual([
      ['provide', CREATOR],
      ['sell', BUYER],
      ['withdraw', CREATOR],
    ]);
  });

  it('keeps the trade reading when a receipt cannot be read', async () => {
    const moves = draftMoves([transfer(CREATOR, POOL, 100n, 30, '0xadd')], new Set([POOL]));
    const out = await separateLiquidity(receipts({}), moves, new Set([POOL]));
    expect(out[0]?.kind).toBe('sell');
  });
});

describe('readLaunchReplay', () => {
  it('reads a shorter window when the launch is too busy for the node', async () => {
    const asked: number[] = [];
    const rpc = {
      async call<T>(method: string, params: { toBlock?: string }[]): Promise<T> {
        if (method === 'eth_call') return '0xf4240' as T;
        const span = Number(params[0]?.toBlock) - 100;
        asked.push(span);
        if (span > 3_000) throw new LogQueryTooBroadError('too-many-results');
        return [transfer(POOL, BUYER, 10n, 101, '0xbuy')] as T;
      },
      async callBatch(requests: { method: string; params: unknown[] }[]) {
        return requests.map((r) =>
          r.method === 'eth_getBlockByNumber'
            ? {
                ok: true,
                value: {
                  timestamp: `0x${Math.floor(1_700_000_000 + (Number(r.params[0]) - 100) / 10).toString(16)}`,
                },
              }
            : r.method === 'eth_getTransactionReceipt'
              ? { ok: true, value: { logs: [] } }
              : { ok: true, value: '0x' },
        );
      },
    } as unknown as RpcClient;
    const replay = await readLaunchReplay(rpc, addr(999) as `0x${string}`, {
      launchBlock: 100,
      latestBlock: 1_000_000,
      pools: [POOL],
    });
    expect(asked).toEqual([12_000, 6_000, 3_000]);
    expect(replay.completeness).toBe('partial');
    expect(replay.sources[0]?.note).toMatch(/too busy/);
    expect(replay.data.windowSeconds).toBe(300);
  });
});
