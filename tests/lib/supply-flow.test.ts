import { describe, expect, it } from 'vitest';
import { flowSentence, flowSpan, type FlowNode, type SupplyFlow } from '../../src/lib/supply-flow';

const node = (over: Partial<FlowNode>): FlowNode => ({
  address: 'A',
  kind: 'wallet',
  name: 'a wallet',
  received: 0.01,
  heldNow: 0,
  at: 0,
  tradable: null,
  children: [],
  ...over,
});

describe('flowSpan', () => {
  it('says a time after the launch in the unit a person would use', () => {
    expect(flowSpan(1)).toBe('1 second');
    expect(flowSpan(40)).toBe('40 seconds');
    expect(flowSpan(12 * 60)).toBe('12 minutes');
    expect(flowSpan(5 * 3600)).toBe('5 hours');
    // BONK: 10,352 minutes.
    expect(flowSpan(10_352 * 60)).toBe('7.2 days');
    expect(flowSpan(40 * 86_400)).toBe('40 days');
  });
});

describe('flowSentence', () => {
  it('says a hand-out over a week in days, not in minutes (BONK, 25/11/2026)', () => {
    const flow: SupplyFlow = {
      launchpad: null,
      windowSeconds: 621_120,
      buys: 0,
      roots: [
        node({
          address: 'C',
          kind: 'creator',
          name: 'the creator',
          received: 1,
          heldNow: 0.943,
          children: [
            node({ address: 'P1', name: 'a program account', at: 3_600 }),
            node({ address: 'P2', name: 'a program account', at: 621_120 }),
          ],
        }),
      ],
    };
    const sentence = flowSentence(flow, 'C');
    expect(sentence).toContain('passed 2% on within 7.2 days');
    expect(sentence).not.toMatch(/\d{4,} minutes/);
  });
});
