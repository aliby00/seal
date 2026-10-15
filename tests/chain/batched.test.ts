import { describe, expect, it } from 'vitest';
import {
  classifyOutcome,
  decodeGetLaunchedToken,
  encodeGetLaunchedToken,
  findLaunchOf,
  getLogsBatched,
  PONS_FACTORIES,
  wordToAddress,
  type RawLog,
  type RpcClient,
  type RpcRequest,
} from '../../src/lib/chain';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

type Filter = { address: string; fromBlock: string; toBlock: string; topics: unknown[] };

/** A node that records every batched eth_getLogs and answers through `answer`. */
function node(
  answer: (f: Filter) => RawLog[] | string,
  calls: { method: string; params: unknown[] }[] = [],
) {
  const batches: Filter[][] = [];
  const rpc: RpcClient = {
    async call() {
      throw new Error('not used');
    },
    async callBatch<T>(requests: RpcRequest[]) {
      calls.push(...requests);
      const logs = requests
        .filter((r) => r.method === 'eth_getLogs')
        .map((r) => r.params[0] as Filter);
      if (logs.length) batches.push(logs);
      return requests.map((r) => {
        if (r.method !== 'eth_getLogs') return { ok: true as const, value: '0x' as T };
        const out = answer(r.params[0] as Filter);
        return typeof out === 'string'
          ? { ok: false as const, error: out }
          : { ok: true as const, value: out as T };
      });
    },
  };
  return { rpc, batches };
}

const log = (block: number, address = '0xaa'): RawLog => ({
  address,
  topics: ['0xt'],
  data: '0x',
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: '0x1',
  logIndex: '0x0',
});

describe('getLogsBatched', () => {
  it('asks one address per query, in windows of 10 M blocks', async () => {
    const { rpc, batches } = node(() => []);
    await getLogsBatched(
      rpc,
      { addresses: ['0xA', '0xb'], topics: [] },
      { fromBlock: 0, toBlock: 24_999_999 },
    );
    const filters = batches.flat();
    expect(filters).toHaveLength(6);
    expect(filters.every((f) => typeof f.address === 'string')).toBe(true);
    expect(new Set(filters.map((f) => f.address))).toEqual(new Set(['0xa', '0xb']));
  });

  it('only reads an address within its own range', async () => {
    const { rpc, batches } = node(() => []);
    await getLogsBatched(
      rpc,
      { addresses: [{ address: '0xa', fromBlock: 15_000_000, toBlock: 18_000_000 }], topics: [] },
      { fromBlock: 0, toBlock: 90_000_000 },
    );
    expect(batches.flat()).toEqual([
      expect.objectContaining({ fromBlock: '0xe4e1c0', toBlock: '0x112a880' }),
    ]);
  });

  it('returns logs in chain order across windows', async () => {
    const { rpc } = node((f) => (f.fromBlock === '0x0' ? [log(5)] : [log(10_000_005)]));
    const { logs } = await getLogsBatched(
      rpc,
      { addresses: ['0xa'], topics: [] },
      { fromBlock: 0, toBlock: 19_999_999 },
    );
    expect(logs.map((l) => Number(l.blockNumber))).toEqual([5, 10_000_005]);
  });

  it('marks the result truncated when a window fails for another reason', async () => {
    const { rpc } = node(() => 'internal error');
    const out = await getLogsBatched(
      rpc,
      { addresses: ['0xa'], topics: [] },
      { fromBlock: 0, toBlock: 10 },
    );
    expect(out.truncated).toBe(true);
  });
});

describe('findLaunchOf', () => {
  const DEPLOYER = '0xe06289fde414ee521aba50db0cf0a60816faa523';
  const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';
  const launched = encodeAbiParameters(
    parseAbiParameters(
      '(address token, address deployer, address pairedToken, address positionManager, uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount)',
    ),
    [
      {
        token: TOKEN,
        deployer: DEPLOYER,
        pairedToken: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
        positionManager: '0x0000000000000000000000000000000000000001',
        positionId: 1n,
        dexId: 0n,
        launchConfigId: 0n,
        restrictionsEndBlock: 0n,
        supply: 10n ** 27n,
        isToken0: true,
        poolFee: 10_000,
        exists: true,
        initialBuyAmount: 0n,
      },
    ],
  );

  it('reads the creator from getLaunchedToken without any log query', async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const rpc: RpcClient = {
      async call() {
        throw new Error('not used');
      },
      async callBatch<T>(requests: RpcRequest[]) {
        calls.push(...requests);
        // The first factory knows the token; the token answers its pool.
        return requests.map((r, i) => ({
          ok: true as const,
          value: (i === 0
            ? launched
            : r.params[0] && (r.params[0] as { data: string }).data === '0x665a11ca'
              ? `0x${'0'.repeat(24)}${'12'.repeat(20)}`
              : '0x') as T,
        }));
      },
    };
    const launch = await findLaunchOf(rpc, TOKEN, 88_000_000);
    expect(launch?.deployer.toLowerCase()).toBe(DEPLOYER);
    expect(launch?.factory).toBe(PONS_FACTORIES[0]?.address);
    expect(launch?.pool).toBe(`0x${'12'.repeat(20)}`);
    expect(calls.some((c) => c.method === 'eth_getLogs')).toBe(false);
  });

  it('falls back to logs only for factories without the getter', async () => {
    const { rpc, batches } = node(() => []);
    const launch = await findLaunchOf(rpc, TOKEN, 88_000_000);
    expect(launch).toBeUndefined();
    const asked = new Set(batches.flat().map((f) => f.address));
    const withoutGetter = PONS_FACTORIES.filter((f) => !f.getter).map((f) => f.address);
    expect([...asked]).toEqual(withoutGetter);
  });
});

describe('getLaunchedToken helpers', () => {
  it('round-trips the call encoding selector', () => {
    expect(
      encodeGetLaunchedToken('0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9').slice(0, 10),
    ).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it('decodes another layout as null rather than as a launch', () => {
    expect(decodeGetLaunchedToken(`0x${'00'.repeat(32)}`)).toBeNull();
    expect(decodeGetLaunchedToken('0x')).toBeNull();
  });

  it('reads an address out of a word, and refuses zero', () => {
    expect(wordToAddress(`0x${'0'.repeat(24)}${'ab'.repeat(20)}`)).toBe(`0x${'ab'.repeat(20)}`);
    expect(wordToAddress(`0x${'0'.repeat(64)}`)).toBeNull();
    expect(wordToAddress('0x')).toBeNull();
  });
});

describe('classifyOutcome without a readable graduation', () => {
  // An old token whose graduation could not be read was called "abandoned".
  it('says undetermined, not abandoned', () => {
    expect(classifyOutcome(null, 30_000_000)).toBe('undetermined');
  });
});

describe('getLogsBatched without splitting', () => {
  it('gives up on a crowded window instead of re-reading it', async () => {
    const { rpc, batches } = node(() => 'logs matched by query exceeds limit of 10000');
    const out = await getLogsBatched(
      rpc,
      { addresses: ['0xa'], topics: [] },
      { fromBlock: 0, toBlock: 10 },
      { split: false },
    );
    expect(out.truncated).toBe(true);
    expect(batches).toHaveLength(1);
  });
});
