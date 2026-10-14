import { describe, expect, it } from 'vitest';
import { TRANSFER_TOPIC, topicFor } from '../../src/lib/chain';
import { balancesFromTransfers } from '../../src/lib/holders/chain';

const ZERO = '0x0000000000000000000000000000000000000000';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const transfer = (from: string, to: string, value: bigint) => ({
  topics: [TRANSFER_TOPIC, topicFor(from), topicFor(to)],
  data: word(value),
});

describe('balancesFromTransfers', () => {
  it('replays mints and transfers into balances', () => {
    const balances = balancesFromTransfers([
      transfer(ZERO, A, 100n),
      transfer(A, B, 30n),
      transfer(B, A, 5n),
    ]);
    expect(balances.get(A)).toBe(75n);
    expect(balances.get(B)).toBe(25n);
    expect(balances.has(ZERO)).toBe(false);
  });

  it('ignores ERC-721-shaped events and zero transfers', () => {
    const balances = balancesFromTransfers([
      { topics: [TRANSFER_TOPIC, topicFor(ZERO), topicFor(A), word(1n)], data: '0x' },
      transfer(ZERO, B, 0n),
    ]);
    expect(balances.size).toBe(0);
  });
});
