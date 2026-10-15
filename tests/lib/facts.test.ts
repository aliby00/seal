import { describe, expect, it } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { toFacts } from '../../src/lib/facts';
import { findFirstMint } from '../../src/lib/holders/chain';
import type { RpcClient, RpcRequest } from '../../src/lib/chain';

const token = (outcome: string, dumped: boolean | null, pulled: boolean | null) => ({
  address: `0x${outcome.padEnd(40, '0').slice(0, 40)}`,
  pool: '0xpool',
  launchedAtBlock: 1,
  launchedAt: null,
  outcome,
  graduationProgress: 0,
  creatorDumped: dumped,
  liquidityPulled: pulled,
});

const report = {
  token: '0xt',
  collectedAt: 'x',
  completeness: 'partial',
  creator: {
    completeness: 'partial',
    sources: [
      { name: 'robinhood-rpc', fetchedAt: 'x', note: '2 most recent of 5 launches read in detail' },
    ],
    data: {
      creator: '0xc',
      tokens: [token('abandoned', true, false), token('graduated', null, null)],
      counts: {
        launched: 5,
        graduated: 1,
        abandoned: 1,
        undetermined: 0,
        liquidityPulled: 0,
        creatorDumped: 1,
      },
      scannedRange: { fromBlock: 0, toBlock: 1 },
    },
  },
  holders: {
    completeness: 'unavailable',
    sources: [{ name: 'blockscout', fetchedAt: 'x', note: 'no API key' }],
    data: {
      token: '0xt',
      countedSupply: '0',
      holderCount: null,
      top: [],
      concentration: { top1: 0, top10: 0 },
      distinctTraders: null,
    },
  },
  market: {
    completeness: 'full',
    sources: [{ name: 'dexscreener', fetchedAt: 'x' }],
    data: {
      token: '0xt',
      pair: '0xp',
      priceUsd: 2,
      liquidityUsd: 1000,
      pairedEth: null,
      graduation: { thresholdEth: 4.2, progress: 0.5, graduated: false },
      volumeUsd: { m5: 0, h1: 0, h6: 0, h24: 300 },
      txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 3, sells: 1 } },
      fdvUsd: null,
      pairCreatedAt: null,
    },
  },
} as unknown as TokenReport;

describe('toFacts', () => {
  const facts = toFacts(report);

  it('counts outcomes over the launches read in detail, launches over all', () => {
    expect(facts.creator.launched).toBe(5);
    expect(facts.creator.detailed).toBe(2);
    expect(facts.creator.abandoned).toBe(1);
    expect(facts.creator.graduated).toBe(1);
  });

  it('counts sales and removals only over the launches actually checked', () => {
    expect(facts.creator.checked).toBe(1);
    expect(facts.creator.soldIntoPool).toBe(1);
    expect(facts.creator.liquidityPulled).toBe(0);
  });

  // A missing block is "not measured", never a 0 % bar.
  it('marks an unavailable source as not measured, with its reason', () => {
    expect(facts.holders.measured).toBe(false);
    expect(facts.holders.note).toBe('no API key');
  });

  it('carries the market numbers through', () => {
    expect(facts.market.buys24h).toBe(3);
    expect(facts.market.volume24hUsd).toBe(300);
    expect(facts.market.graduation?.progress).toBe(0.5);
  });
});

describe('findFirstMint', () => {
  function node(answer: (filter: { fromBlock: string }) => unknown[] | string): RpcClient {
    return {
      async call() {
        throw new Error('not used');
      },
      async callBatch<T>(requests: RpcRequest[]) {
        return requests.map((r) => {
          const out = answer(r.params[0] as { fromBlock: string });
          return typeof out === 'string'
            ? { ok: false as const, error: out }
            : { ok: true as const, value: out as T };
        });
      },
    };
  }
  const mint = (block: number) => ({
    address: '0xt',
    topics: [],
    data: '0x',
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: '0x',
    logIndex: '0x0',
  });

  it('returns the earliest mint across windows', async () => {
    const rpc = node((f) =>
      Number(f.fromBlock) < 10_000_000 ? [mint(9_000_000)] : [mint(15_000_000)],
    );
    expect(await findFirstMint(rpc, '0x0000000000000000000000000000000000000001', 19_999_999)).toBe(
      9_000_000,
    );
  });

  // A window that failed could hide an earlier mint: no start is better than a wrong one.
  it('gives up when a window could not be read', async () => {
    const rpc = node((f) =>
      Number(f.fromBlock) < 10_000_000 ? 'internal error' : [mint(15_000_000)],
    );
    expect(
      await findFirstMint(rpc, '0x0000000000000000000000000000000000000001', 19_999_999),
    ).toBeUndefined();
  });
});
