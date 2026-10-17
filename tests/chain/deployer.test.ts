import { describe, expect, it } from 'vitest';
import {
  burnMovedLiquidity,
  creatorOf,
  fetchDeployerHistory,
  findRegistry,
  findVenues,
  modifyRemovedLiquidity,
  MODIFY_LIQUIDITY_TOPIC,
  PAIR_CREATED_TOPIC,
  readOrigin,
  TRANSFER_TOPIC,
  USER_OPERATION_EVENT_TOPIC,
  V2_BURN_TOPIC,
  V4_INITIALIZE_TOPIC,
  type RawLog,
  type RpcClient,
  type RpcRequest,
  type TokenOrigin,
} from '../../src/lib/chain';
import { POOL_MANAGER } from '../../src/lib/chain/pools';

const TOKEN = '0x72e936815982a577386e8fcde94f5c9335836c88';
const CREATOR = '0xc47ff45c87ee89a999b95ed6d4f408674d9bed9f';
const LAUNCHPAD = '0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007';
const REGISTRY = '0x6d80b81d9fc56a7a839b1af9006eb49151961ce7';
const PAIR = '0x0539b29ff2c295d396a5618b33db2788706334f0';
const BUNDLER = '0x433707177eec628061e37777483a7fde7c0f403c';
const ACCOUNT = '0x1cf4fbdead2ecfb11bf882e00429f6cc7a38897f';
const ENTRY_POINT = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const REGISTRY_TOPIC = '0x8c768b5da89e637b23caac626ccd760ef89b9e8eaa2f45bbf8c9d68e231dabef';

const pad = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');

function log(address: string, topics: string[], data = '0x', logIndex = 0, block = 100): RawLog {
  return {
    address,
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: '0xtx',
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

const mint = log(TOKEN, [TRANSFER_TOPIC, pad('0x0'), pad(LAUNCHPAD)], `0x${word(1000)}`, 3);
const registryLog = log(REGISTRY, [REGISTRY_TOPIC, pad(TOKEN), pad(CREATOR)], '0x', 16);
const pairLog = log(
  '0xfc2e4da3edb2e18100473339c763705d263d20a9',
  [PAIR_CREATED_TOPIC, pad(TOKEN), pad('0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31')],
  `0x${pad(PAIR).slice(2)}${word(1)}`,
  8,
);

describe('creatorOf', () => {
  it('is the sender of the transaction', () => {
    expect(
      creatorOf(
        { from: CREATOR, to: LAUNCHPAD, hash: '0x' },
        { contractAddress: null, logs: [] },
        0,
      ),
    ).toBe(CREATOR);
  });

  it('is the account of the user operation, not the bundler, through an EntryPoint', () => {
    const operation = log(
      ENTRY_POINT,
      [USER_OPERATION_EVENT_TOPIC, pad('0x01'), pad(ACCOUNT), pad('0x0')],
      '0x',
      52,
    );
    const earlier = log(
      ENTRY_POINT,
      [USER_OPERATION_EVENT_TOPIC, pad('0x02'), pad(BUNDLER)],
      '0x',
      1,
    );
    expect(
      creatorOf(
        { from: BUNDLER, to: ENTRY_POINT, hash: '0x' },
        { contractAddress: null, logs: [earlier, operation] },
        16,
      ),
    ).toBe(ACCOUNT);
  });
});

describe('findRegistry', () => {
  it('finds the launch contract event naming the token and its creator', () => {
    expect(findRegistry(TOKEN, CREATOR, [mint, registryLog])).toEqual({
      address: REGISTRY,
      topic0: REGISTRY_TOPIC,
      tokenIndex: 1,
      creatorIndex: 2,
    });
  });

  it('ignores the token’s own events and finds nothing when no event names both', () => {
    const own = log(TOKEN, ['0x8be0079c', pad('0x0'), pad(CREATOR)]);
    expect(findRegistry(TOKEN, CREATOR, [own, pairLog])).toBeUndefined();
  });
});

describe('findVenues', () => {
  it('takes V2 pairs, v4 markets and the launch contract as places a sale lands', () => {
    const init = log(POOL_MANAGER, [
      V4_INITIALIZE_TOPIC,
      `0x${'ab'.repeat(32)}`,
      pad('0x0'),
      pad(TOKEN),
    ]);
    const venues = findVenues(TOKEN, [pairLog, init], LAUNCHPAD);
    expect(venues.pools).toEqual([PAIR]);
    expect(venues.v4Markets).toEqual([`0x${'ab'.repeat(32)}`]);
    expect(venues.saleRecipients).toEqual([PAIR, POOL_MANAGER.toLowerCase(), LAUNCHPAD]);
  });

  it('ignores markets of other tokens', () => {
    const other = { ...pairLog, topics: [PAIR_CREATED_TOPIC, pad('0x1234'), pad('0x5678')] };
    expect(findVenues(TOKEN, [other]).saleRecipients).toEqual([]);
  });
});

describe('readOrigin', () => {
  it('calls a contract creation a deployment', () => {
    const origin = readOrigin(
      TOKEN,
      mint,
      { from: CREATOR, to: null, hash: '0x' },
      {
        contractAddress: TOKEN,
        logs: [mint],
      },
    );
    expect(origin.role).toBe('deployer');
    expect(origin.launchContract).toBeUndefined();
  });

  it('calls a launch contract a launch, and keeps its registry and markets', () => {
    const origin = readOrigin(
      TOKEN,
      mint,
      { from: CREATOR, to: LAUNCHPAD, hash: '0x' },
      {
        contractAddress: null,
        logs: [mint, pairLog, registryLog],
      },
    );
    expect(origin).toMatchObject({
      creator: CREATOR,
      role: 'launcher',
      launchContract: LAUNCHPAD,
      blockNumber: 100,
      registry: { address: REGISTRY },
    });
    expect(origin.venues.pools).toEqual([PAIR]);
  });

  it('does not call the sender of a later mint its author', () => {
    const origin = readOrigin(
      TOKEN,
      mint,
      { from: CREATOR, to: TOKEN, hash: '0x' },
      {
        contractAddress: null,
        logs: [mint],
      },
    );
    expect(origin.role).toBe('first-minter');
  });
});

describe('liquidity events', () => {
  it('a V2 or V3 burn of nothing is a fee collection, not a removal', () => {
    expect(burnMovedLiquidity(log(PAIR, [V2_BURN_TOPIC], `0x${word(0)}${word(0)}`))).toBe(false);
    expect(burnMovedLiquidity(log(PAIR, [V2_BURN_TOPIC], `0x${word(0)}${word(5)}`))).toBe(true);
  });

  it('a v4 negative liquidity delta is a removal', () => {
    const negative = (2n ** 256n - 10n).toString(16);
    expect(
      modifyRemovedLiquidity(
        log(POOL_MANAGER, [MODIFY_LIQUIDITY_TOPIC], `0x${word(1)}${word(2)}${negative}${word(0)}`),
      ),
    ).toBe(true);
    expect(
      modifyRemovedLiquidity(
        log(POOL_MANAGER, [MODIFY_LIQUIDITY_TOPIC], `0x${word(1)}${word(2)}${word(7)}${word(0)}`),
      ),
    ).toBe(false);
  });
});

type Filter = { address: string; topics: unknown[] };

const OTHER_LP = '0x00000000000000000000000000000000000000b3';

/** A node answering logs through `logs`, everything else with fixed values. */
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const V2_MINT = '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f';

/** `poolEvent`: what the pair emitted in every transaction, a swap by default. */
function node(logs: (f: Filter) => RawLog[], poolEvent = V2_SWAP) {
  const requests: RpcRequest[] = [];
  const rpc: RpcClient = {
    async call() {
      throw new Error('not used');
    },
    async callBatch<T>(batch: RpcRequest[]) {
      requests.push(...batch);
      return batch.map((r) => {
        const value =
          r.method === 'eth_getLogs'
            ? logs(r.params[0] as Filter)
            : r.method === 'eth_getCode'
              ? '0x'
              : r.method === 'eth_getTransactionCount'
                ? '0xb'
                : r.method === 'eth_getBlockByNumber'
                  ? { timestamp: '0x68000000' }
                  : r.method === 'eth_getTransactionReceipt'
                    ? {
                        contractAddress: null,
                        logs: [{ address: PAIR, topics: [poolEvent], data: '0x' }],
                      }
                    : r.method === 'eth_getTransactionByHash'
                      ? { from: (r.params[0] as string) === '0xcreator-pull' ? CREATOR : OTHER_LP }
                      : null;
        return { ok: true as const, value: value as T };
      });
    },
  };
  return { rpc, requests };
}

const ORIGIN: TokenOrigin = {
  token: TOKEN,
  creator: CREATOR,
  role: 'launcher',
  launchContract: LAUNCHPAD,
  blockNumber: 100,
  transactionHash: '0xtx',
  registry: { address: REGISTRY, topic0: REGISTRY_TOPIC, tokenIndex: 1, creatorIndex: 2 },
  venues: { pools: [PAIR], v4Markets: [], saleRecipients: [PAIR, LAUNCHPAD] },
};

describe('fetchDeployerHistory', () => {
  it('does not count the creator adding liquidity to the pair as a sale', async () => {
    const { rpc } = node((f) => {
      if (f.address === REGISTRY) {
        return [log(REGISTRY, [REGISTRY_TOPIC, pad(TOKEN), pad(CREATOR)], '0x', 0, 100)];
      }
      if (f.address === TOKEN) {
        return [log(TOKEN, [TRANSFER_TOPIC, pad(CREATOR), pad(PAIR)], `0x${word(5)}`, 0, 150)];
      }
      return [];
    }, V2_MINT);
    const history = await fetchDeployerHistory(rpc, ORIGIN, { latestBlock: 1_000 });
    expect(history.data.tokens.find((t) => t.address === TOKEN)?.creatorDumped).toBe(false);
  });

  it('lists the launches through the same contract and reads the sales into the market', async () => {
    const other = '0x00000000000000000000000000000000000000aa';
    const { rpc, requests } = node((f) => {
      if (f.address === REGISTRY) {
        return [
          log(REGISTRY, [REGISTRY_TOPIC, pad(other), pad(CREATOR)], '0x', 0, 50),
          log(REGISTRY, [REGISTRY_TOPIC, pad(TOKEN), pad(CREATOR)], '0x', 0, 100),
        ];
      }
      if (f.address === TOKEN) {
        return [log(TOKEN, [TRANSFER_TOPIC, pad(CREATOR), pad(PAIR)], `0x${word(5)}`, 0, 150)];
      }
      return [];
    });
    const history = await fetchDeployerHistory(rpc, ORIGIN, { latestBlock: 1_000 });
    expect(history.completeness).toBe('partial');
    expect(history.data.origin).toMatchObject({
      source: 'deployer',
      role: 'launcher',
      launchContract: LAUNCHPAD,
      launchesListed: true,
      transactionCount: 11,
    });
    // Where the launches were looked for, and where they cannot be.
    expect(history.data.origin?.launchpadsRead).toContain('its launch contract');
    expect(history.data.origin?.launchpadsRead).toContain('pons');
    expect(history.data.origin?.launchpadsNotRead).toEqual(
      expect.arrayContaining(['flap.sh', 'contracts deployed directly']),
    );
    expect(history.data.counts.launched).toBe(2);
    const own = history.data.tokens.find((t) => t.address === TOKEN);
    expect(own).toMatchObject({
      creatorDumped: true,
      liquidityPulled: false,
      outcome: 'undetermined',
    });
    // The other launch's receipt shows no market: its sales are read against the
    // launch contract only, and its liquidity is not measured — never "no".
    const theirs = history.data.tokens.find((t) => t.address === other);
    expect(theirs).toMatchObject({ creatorDumped: false, liquidityPulled: null });
    // The registry is asked with the creator in its own topic position.
    const registryQuery = requests.find(
      (r) => r.method === 'eth_getLogs' && (r.params[0] as Filter).address === REGISTRY,
    );
    expect((registryQuery?.params[0] as Filter).topics).toEqual([
      REGISTRY_TOPIC,
      null,
      pad(CREATOR),
    ]);
    // The node caps a filter listing several values in one position at
    // 100,000 blocks: every liquidity query names one event only.
    const burnQueries = requests.filter(
      (r) => r.method === 'eth_getLogs' && (r.params[0] as Filter).address === PAIR,
    );
    expect(burnQueries).toHaveLength(2);
    for (const r of requests.filter((q) => q.method === 'eth_getLogs')) {
      expect((r.params[0] as Filter).topics.some(Array.isArray)).toBe(false);
    }
  });

  it('says the other launches cannot be listed when no contract records them', async () => {
    const { rpc } = node(() => []);
    const unlisted: TokenOrigin = { ...ORIGIN, registry: undefined };
    const history = await fetchDeployerHistory(rpc, unlisted, { latestBlock: 1_000 });
    expect(history.data.origin?.launchesListed).toBe(false);
    expect(history.data.counts.launched).toBe(1);
    expect(history.sources[0]?.note).toMatch(/cannot be listed/);
  });

  it('does not count a transfer to another wallet as a sale', async () => {
    const { rpc } = node((f) =>
      f.address === TOKEN
        ? [
            log(TOKEN, [
              TRANSFER_TOPIC,
              pad(CREATOR),
              pad('0x00000000000000000000000000000000000000bb'),
            ]),
          ]
        : [],
    );
    const history = await fetchDeployerHistory(rpc, ORIGIN, { latestBlock: 1_000 });
    expect(history.data.tokens.find((t) => t.address === TOKEN)?.creatorDumped).toBe(false);
  });
});

describe('fetchDeployerHistory: liquidity removals', () => {
  const burnBy = (hash: string) => ({
    ...log(PAIR, [V2_BURN_TOPIC, pad(ROUTER_LIKE)], `0x${word(5)}${word(5)}`, 0, 150),
    transactionHash: hash,
  });
  const ROUTER_LIKE = '0x00000000000000000000000000000000000000c0';

  it('ignores liquidity another provider removed from the same market', async () => {
    const { rpc } = node((f) => (f.address === PAIR ? [burnBy('0xsomeone-else')] : []));
    const history = await fetchDeployerHistory(rpc, ORIGIN, { latestBlock: 1_000 });
    expect(history.data.tokens.find((t) => t.address === TOKEN)?.liquidityPulled).toBe(false);
  });

  it('reports a removal the creator signed', async () => {
    const { rpc } = node((f) =>
      f.address === PAIR ? [burnBy('0xsomeone-else'), burnBy('0xcreator-pull')] : [],
    );
    const history = await fetchDeployerHistory(rpc, ORIGIN, { latestBlock: 1_000 });
    expect(history.data.tokens.find((t) => t.address === TOKEN)?.liquidityPulled).toBe(true);
  });
});
