import { describe, expect, it } from 'vitest';
import { LAUNCHPADS as INDEXED } from '../../indexer/src/abi';
import {
  creatorFilter,
  CURVE_SELL_TOPIC,
  fetchDeployerHistory,
  FLAP_TOKEN_SOLD_TOPIC,
  findLaunchRecord,
  LAUNCHPADS,
  launchpadById,
  listCreatorLaunches,
  PONS_FACTORIES,
  readLaunchRecord,
  readOrigin,
  TRANSFER_TOPIC,
  type RawLog,
  type RpcClient,
  type RpcRequest,
  type TokenOrigin,
} from '../../src/lib/chain';
import { POOL_MANAGER } from '../../src/lib/chain/pools';

/** Read off the chain on 17/10/2026: the launch transactions of live tokens. */
const FLAP_TOKEN = '0xb417a5dab44c607520bba70a6e08d826c4c57777';
const FLAP_ROUTER = '0xd3de039292dbe0ba6b845c6a22863f73c8906666';
const FLAP_SENDER = '0x498b1bee7a146a4d10514f2d8eb1201b447ad384';
const CURVE_TOKEN = '0x008df4b3e857d06c4603aeb11f267ccd32ce2005';
const CURVE = '0xc1f765216bef0245136031aef8137e25a5341f60';
const CURVE_CREATOR = '0x9a8096aab239e44b3bb2cf0ff73b75300f9b45f6';
const AGEM = '0x7c0495053f47ec52eb4b678c4ad8f572df745bfe';
const AGEM_MARKET = '0xdd12ebb1924eb485b0d1027defd4df8e42406503778c0713774984798fb5bba6';

const flap = launchpadById('flap')!;
const curve7ed5 = launchpadById('curve-7ed5')!;
const curve3d6e = launchpadById('curve-3d6e')!;
const doppler = launchpadById('doppler')!;

const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const word = (a: string) => pad(a).slice(2);

function log(address: string, topics: string[], data = '0x', block = 100, tx = '0xtx'): RawLog {
  return {
    address,
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: tx,
    logIndex: '0x5',
  };
}

/** flap.sh `TokenCreated`, its words as in transaction 0xfe26f1bf…: the creator is the router. */
const flapCreated = log(
  flap.address,
  [flap.topic0],
  `0x${word('6ad2a579')}${word(FLAP_ROUTER)}${word('5add6')}${word(FLAP_TOKEN)}${word('e0')}`,
);
/** 0x7ed5 `TokenLaunched(token, curve, creator)`, as in transaction 0xf19c68ee…. */
const curveLaunched = log(
  curve7ed5.address,
  [curve7ed5.topic0, pad(CURVE_TOKEN), pad(CURVE), pad(CURVE_CREATOR)],
  `0x${word('0')}${word('0')}${word('3a4965bf58a40000')}`,
);

describe('the launchpad registry', () => {
  it('reads the token and the creator where each launch event puts them', () => {
    expect(readLaunchRecord(flap, flapCreated)).toMatchObject({
      token: FLAP_TOKEN,
      creator: FLAP_ROUTER,
      // The portal holds every flap.sh curve.
      curve: flap.address,
    });
    expect(readLaunchRecord(curve7ed5, curveLaunched)).toMatchObject({
      token: CURVE_TOKEN,
      creator: CURVE_CREATOR,
      curve: CURVE,
    });
    // Another contract's log, or another event, is not a launch.
    expect(readLaunchRecord(flap, { ...flapCreated, address: CURVE })).toBeNull();
    expect(readLaunchRecord(curve7ed5, { ...curveLaunched, topics: [TRANSFER_TOPIC] })).toBeNull();
  });

  it('reads the v4 market a 0x3d6e launch graduates into, named at launch', () => {
    const words = Array.from({ length: 13 }, () => word('0'));
    words[0] = word('20');
    words[11] = AGEM_MARKET.slice(2);
    const launched = log(
      curve3d6e.address,
      [
        curve3d6e.topic0,
        pad(AGEM),
        pad('0xf6a70fa8e4fa500dd290e33f315fcbd8681ff77b'),
        pad(CURVE_CREATOR),
      ],
      `0x${words.join('')}`,
    );
    expect(readLaunchRecord(curve3d6e, launched)?.market).toBe(AGEM_MARKET);
  });

  it('prefers a launch event that names the creator over Doppler’s Airlock, which does not', () => {
    const airlock = log(doppler.address, [doppler.topic0, pad('0x05a3')], `0x${word(CURVE_TOKEN)}`);
    expect(findLaunchRecord(CURVE_TOKEN, [airlock])?.launchpad.id).toBe('doppler');
    expect(findLaunchRecord(CURVE_TOKEN, [airlock, curveLaunched])?.launchpad.id).toBe(
      'curve-7ed5',
    );
  });

  it('filters by creator only where the event indexes it', () => {
    expect(creatorFilter(curve7ed5, CURVE_CREATOR)).toEqual([
      curve7ed5.topic0,
      null,
      null,
      pad(CURVE_CREATOR),
    ]);
    expect(creatorFilter(flap, CURVE_CREATOR)).toBeNull();
    expect(creatorFilter(doppler, CURVE_CREATOR)).toBeNull();
  });

  it('keeps the pons factories, the first generation included', () => {
    expect(PONS_FACTORIES.map((f) => f.address)).toContain(
      '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb',
    );
    expect(PONS_FACTORIES.every((f) => typeof f.getter === 'boolean')).toBe(true);
  });

  it('agrees with the indexer’s copy, for every launchpad that names its creator', () => {
    const named = LAUNCHPADS.filter((l) => l.creator).map((l) => ({
      id: l.id,
      address: l.address,
      topic0: l.topic0,
      token: l.token,
      creator: l.creator,
      fromBlock: l.fromBlock,
      toBlock: l.toBlock,
    }));
    const indexed = INDEXED.map((l) => ({
      id: l.id,
      address: l.address,
      topic0: l.topic0,
      token: l.token,
      creator: l.creator,
      fromBlock: l.fromBlock,
      toBlock: l.toBlock,
    }));
    expect(indexed).toEqual(named);
  });
});

describe('a launch seen by both the 0x7ed5 factory and its router', () => {
  it('takes the record that names the sender: the router’s, when the factory names a contract', () => {
    const router = LAUNCHPADS.find(
      (l) => l.address === '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
    )!;
    const between = '0x274a4ecb5ceabc388424802ca22f48c0bfee9d2e';
    const factoryLog = log(curve7ed5.address, [
      curve7ed5.topic0,
      pad(CURVE_TOKEN),
      pad(CURVE),
      pad(between),
    ]);
    const routerLog = log(router.address, [
      router.topic0,
      pad(CURVE_TOKEN),
      pad(CURVE),
      pad(CURVE_CREATOR),
    ]);
    expect(findLaunchRecord(CURVE_TOKEN, [factoryLog, routerLog], CURVE_CREATOR)?.creator).toBe(
      CURVE_CREATOR,
    );
    const mint = log(CURVE_TOKEN, [TRANSFER_TOPIC, pad('0x0'), pad(CURVE)]);
    const origin = readOrigin(
      CURVE_TOKEN,
      mint,
      { from: CURVE_CREATOR, to: '0x6319141dcc29e7dceaab6c4563cca1fb58e8cce2', hash: '0xtx' },
      { contractAddress: null, logs: [mint, factoryLog, routerLog] },
    );
    expect(origin).toMatchObject({ creator: CURVE_CREATOR, creatorFrom: 'launch-record' });
  });
});

describe('the origin of a launchpad token', () => {
  it('takes the sender as creator when the launch event names the router it called', () => {
    const mint = log(FLAP_TOKEN, [TRANSFER_TOPIC, pad('0x0'), pad(flap.address)]);
    const origin = readOrigin(
      FLAP_TOKEN,
      mint,
      { from: FLAP_SENDER, to: FLAP_ROUTER, hash: '0xtx' },
      { contractAddress: null, logs: [mint, flapCreated] },
    );
    expect(origin).toMatchObject({
      creator: FLAP_SENDER,
      role: 'launcher',
      launchContract: flap.address,
      launchpad: { id: 'flap', name: 'flap.sh' },
      creatorFrom: 'transaction',
    });
    expect(origin.venues.curves).toEqual([flap.address]);
    expect(origin.venues.saleRecipients).toContain(flap.address);
    expect(origin.venues.curveTrades).toContain(FLAP_TOKEN_SOLD_TOPIC);
  });

  it('takes the creator from the launch record when it names who asked', () => {
    const mint = log(CURVE_TOKEN, [TRANSFER_TOPIC, pad('0x0'), pad(CURVE)]);
    const origin = readOrigin(
      CURVE_TOKEN,
      mint,
      { from: CURVE_CREATOR, to: '0xe33e9e479df8802cb0866d5d05258bec4cf62948', hash: '0xtx' },
      { contractAddress: null, logs: [mint, curveLaunched] },
    );
    expect(origin).toMatchObject({
      creator: CURVE_CREATOR,
      creatorFrom: 'launch-record',
      launchpad: { id: 'curve-7ed5' },
    });
    // The registry guess is not needed: the launchpad is known.
    expect(origin.registry).toBeUndefined();
  });
});

type Filter = { address: string; topics: (string | null)[]; fromBlock: string; toBlock: string };

/** A node answering logs through `logs`, receipts through `receipt`. */
function node(logs: (f: Filter) => RawLog[], receipt: (hash: string) => RawLog[]) {
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
                ? '0x3'
                : r.method === 'eth_getBlockByNumber'
                  ? { timestamp: '0x68000000' }
                  : r.method === 'eth_getTransactionReceipt'
                    ? { contractAddress: null, logs: receipt(r.params[0] as string) }
                    : r.method === 'eth_getTransactionByHash'
                      ? { from: '0x00000000000000000000000000000000000000ee' }
                      : null;
        return { ok: true as const, value: value as T };
      });
    },
  };
  return { rpc, requests };
}

const CURVE_ORIGIN: TokenOrigin = {
  token: CURVE_TOKEN,
  creator: CURVE_CREATOR,
  role: 'launcher',
  launchContract: curve7ed5.address,
  blockNumber: 30_000_000,
  transactionHash: '0xlaunch',
  launchpad: { id: 'curve-7ed5', name: curve7ed5.name, address: curve7ed5.address },
  creatorFrom: 'launch-record',
  venues: {
    pools: [],
    v4Markets: [],
    curves: [CURVE],
    curveTrades: [...(curve7ed5.curveTrades ?? [])],
    saleRecipients: [CURVE],
  },
};

const intoCurve = (tx: string) =>
  log(
    CURVE_TOKEN,
    [TRANSFER_TOPIC, pad(CURVE_CREATOR), pad(CURVE)],
    `0x${word('5')}`,
    30_000_100,
    tx,
  );

describe('creator sales on a launchpad curve', () => {
  it('counts a transfer into the curve as a sale only when the curve traded', async () => {
    const { rpc } = node(
      (f) => (f.address === CURVE_TOKEN ? [intoCurve('0xsell')] : []),
      (hash) => (hash === '0xsell' ? [log(CURVE, [CURVE_SELL_TOPIC])] : []),
    );
    const history = await fetchDeployerHistory(rpc, CURVE_ORIGIN, { latestBlock: 31_000_000 });
    expect(history.data.tokens.find((t) => t.address === CURVE_TOKEN)?.creatorDumped).toBe(true);
  });

  it('does not call a transfer into the curve a sale without its trade event', async () => {
    const { rpc } = node(
      (f) => (f.address === CURVE_TOKEN ? [intoCurve('0xgift')] : []),
      () => [log(CURVE, ['0x7f26b83ff96e1f2b6a682f133852f6798a09c465da95921460cefb3847402498'])],
    );
    const history = await fetchDeployerHistory(rpc, CURVE_ORIGIN, { latestBlock: 31_000_000 });
    expect(history.data.tokens.find((t) => t.address === CURVE_TOKEN)?.creatorDumped).toBe(false);
  });

  it('reads sales into the markets the token reached after its launch', async () => {
    const MARKET = `0x${'ab'.repeat(32)}`;
    const { rpc, requests } = node(
      (f) =>
        f.address === CURVE_TOKEN
          ? [
              log(
                CURVE_TOKEN,
                [TRANSFER_TOPIC, pad(CURVE_CREATOR), pad(POOL_MANAGER)],
                `0x${word('5')}`,
                30_000_200,
                '0xv4',
              ),
            ]
          : [],
      (hash) =>
        hash === '0xv4'
          ? [
              log(POOL_MANAGER, [
                '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
                MARKET,
              ]),
            ]
          : [],
    );
    const history = await fetchDeployerHistory(rpc, CURVE_ORIGIN, {
      latestBlock: 31_000_000,
      venues: { v4Markets: [MARKET] },
    });
    expect(history.data.tokens.find((t) => t.address === CURVE_TOKEN)?.creatorDumped).toBe(true);
    // Its liquidity is now read on that market too.
    expect(
      requests.some(
        (r) => r.method === 'eth_getLogs' && (r.params[0] as Filter).topics[1] === MARKET,
      ),
    ).toBe(true);
  });
});

describe('a creator’s launches across launchpads', () => {
  it('asks each launchpad that indexes the creator, with the creator in its own position', async () => {
    const other = '0x00000000000000000000000000000000000000aa';
    const { rpc, requests } = node(
      (f) =>
        f.address === curve7ed5.address
          ? [
              log(
                curve7ed5.address,
                [curve7ed5.topic0, pad(other), pad(CURVE), pad(CURVE_CREATOR)],
                '0x',
                40_000_000,
                '0xother',
              ),
            ]
          : [],
      () => [],
    );
    const listing = await listCreatorLaunches(rpc, CURVE_CREATOR, 91_000_000, {
      maxQueries: Number.POSITIVE_INFINITY,
    });
    expect(listing.launches.map((l) => [l.token, l.launchpad?.id])).toEqual([
      [other, 'curve-7ed5'],
    ]);
    expect(listing.read).toEqual(expect.arrayContaining(['pons', curve7ed5.name, 'metricpad']));
    expect(listing.unread).toEqual(expect.arrayContaining(['flap.sh', 'Doppler']));
    const asked = requests
      .filter((r) => r.method === 'eth_getLogs')
      .map((r) => r.params[0] as Filter);
    // Never the launchpads whose event does not index the creator.
    expect(asked.some((f) => f.address === flap.address)).toBe(false);
    // One 10 M-block window at most per query, within each launchpad's range.
    for (const f of asked) {
      expect(Number(f.toBlock) - Number(f.fromBlock)).toBeLessThan(10_000_000);
      const pad7ed5 = f.address === curve7ed5.address;
      if (pad7ed5) expect(f.topics).toEqual([curve7ed5.topic0, null, null, pad(CURVE_CREATOR)]);
    }
  });

  it('on the paced public node, reads the token’s own launchpad first and leaves out what does not fit', async () => {
    const { rpc, requests } = node(
      () => [],
      () => [],
    );
    const listing = await listCreatorLaunches(rpc, CURVE_CREATOR, 91_000_000, {
      first: 'curve-7ed5',
      maxQueries: 18,
    });
    // pons needs 22 queries over its five factories: read whole or not at all.
    expect(listing.read).toContain(curve7ed5.name);
    expect(listing.read).not.toContain('pons');
    expect(listing.unread).toContain('pons');
    expect(requests.filter((r) => r.method === 'eth_getLogs').length).toBeLessThanOrEqual(18);
  });

  it('leaves to the indexer the launchpads it has read, and lists flap.sh from it', async () => {
    const FLAP_OTHER = '0x0000000000000000000000000000000000017777';
    const { rpc, requests } = node(
      () => [],
      () => [],
    );
    const history = await fetchDeployerHistory(
      rpc,
      { ...CURVE_ORIGIN },
      {
        latestBlock: 31_000_000,
        indexed: {
          covered: new Set(['flap', 'curve-7ed5']),
          launches: [
            { token: FLAP_OTHER, blockNumber: 20_000_000, transactionHash: '0xf', launchpad: flap },
          ],
        },
      },
    );
    expect(history.data.counts.launched).toBe(2);
    expect(history.data.tokens.find((t) => t.address === FLAP_OTHER)?.launchpad).toBe('flap.sh');
    expect(history.data.origin?.launchpadsRead).toEqual(
      expect.arrayContaining(['flap.sh', curve7ed5.name]),
    );
    expect(history.data.origin?.launchpadsNotRead).not.toContain('flap.sh');
    expect(history.data.origin?.launchesListed).toBe(true);
    expect(
      requests.some(
        (r) => r.method === 'eth_getLogs' && (r.params[0] as Filter).address === curve7ed5.address,
      ),
    ).toBe(false);
  });
});
