import { describe, expect, it } from 'vitest';
import { draftMoves } from '../../src/lib/chain/launch';
import type { RawLog } from '../../src/lib/chain/logs';

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
