import { describe, expect, it } from 'vitest';
import { draftMoves, readLaunchReplay, separateLiquidity } from '../../src/lib/chain/launch';
import { fetchDeployerHistory } from '../../src/lib/chain/deployer';
import { classifyFunder as appClassifyFunder } from '../../src/lib/chain/funder-kind';
import { firstIncoming, sentBy } from '../../src/lib/chain/funding';
import type { RawLog } from '../../src/lib/chain/logs';
import { fundingFacts } from '../../src/lib/indexer/merge';
import { CATALOG } from '../../src/lib/specialists/catalog';
import { describeContract, describeService } from '../../src/lib/specialists/names';
import type { SpecialistContext } from '../../src/lib/specialists/types';
import { classifyFunder as indexerClassifyFunder } from '../../indexer/src/funder-kind';
import type { RpcClient } from '../../src/lib/chain/rpc';
import type { LaunchReplayData } from '../../src/lib/contracts/launch';
import { buildStory } from '../../src/lib/launch-story';
import type { BlockscoutHolder } from '../../src/lib/holders';
import { computeDistribution } from '../../src/lib/holders';
import { readPoolsShare, recheckContracts } from '../../src/lib/holders/chain';
import { checkLiquidity, quietFor, toMarketState } from '../../src/lib/market';
import type { TokenReport } from '../../src/lib/contracts';
import { toFacts } from '../../src/lib/facts';
import type { ReportFacts } from '../../src/lib/facts';
import { buildGlance, usdShort } from '../../src/lib/glance';

/**
 * Regressions from the second audit of displayed facts, re-derived from the
 * chain on 30 live tokens (18/10/2026). Each fixture uses the addresses and
 * values the audit read on chain.
 */

const E27 = 10n ** 27n;
/** A share of a 1e27 supply, as a raw balance. */
const of = (share: number, supply = E27) =>
  ((supply * BigInt(Math.round(share * 1_000_000))) / 1_000_000n).toString();
const holder = (hash: string, value: string, isContract = false): BlockscoutHolder => ({
  address: { hash, is_contract: isContract },
  value,
});

const FLAP_PORTAL = '0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09';
const F05A = '0xf05a26e92e27b8f0385f6895f5507db26a2f4b8d';
const LOCKER_7ED5 = '0x267444d099b10fb5ed7c3cc7b7c767adca574952';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

describe('holders: launch curves, pairs and launch contracts are not holders (bug 1)', () => {
  it('ECOGPT: the flap.sh portal holding 99.95 % on its curve is set aside, not "one holder"', () => {
    // ECOGPT 0x003b1a…7777: Blockscout listed the portal first, at 99.9482 %.
    const data = computeDistribution(
      '0x003b1a443ac7696728da395d5c607bab917a7777',
      [
        holder(FLAP_PORTAL, of(0.999482), true),
        holder('0xce2841c532af2628df7166badfa2eaf401c217a7', of(0.000517)),
        holder('0x641c1c78c256d4aa6d7e73c5fc0cddef035c6666', of(0.000001), true),
      ],
      { setAside: [{ address: FLAP_PORTAL, role: 'curve' }] },
      { holders: 3, supply: null, complete: true },
    );
    expect(data.top.find((h) => h.address === FLAP_PORTAL)).toMatchObject({
      kind: 'pool',
      role: 'curve',
      share: 0,
    });
    expect(data.pooledShare).toBeCloseTo(0.999482, 5);
    expect(data.concentration.top1).toBeGreaterThan(0.99);
    expect(data.holderCount).toBe(2);
    expect(data.setAside?.[0]).toMatchObject({ address: FLAP_PORTAL, role: 'curve' });
  });

  it('BELIEVE: the 0xf05a launchpad holding 11.3 % is set aside even when nobody passes it', () => {
    const data = computeDistribution(
      '0x84c23015379837dedbc566118e163372a1210586',
      [
        holder(F05A, of(0.11306), true),
        holder(POOL_MANAGER, of(0.16), true),
        holder('0x5783c40ebbcab99d0cfa177587aa5c3c1cbd3d00', of(0.026618)),
        holder('0xaeb9f5a1c5b50e8e104ad2dbffcbaab236b4f213', of(0.02607)),
      ],
      {},
      { holders: 4, supply: E27 },
    );
    expect(data.top.find((h) => h.address === F05A)).toMatchObject({
      kind: 'pool',
      role: 'launchpad',
    });
    expect(data.top[0]?.address).toBe('0x5783c40ebbcab99d0cfa177587aa5c3c1cbd3d00');
    expect(data.pooledShare).toBeCloseTo(0.27306, 4);
  });

  it('HYPURRT: the 0x7ed5 lock contract (0x2674…, 8.163 % locked at graduation) is set aside', () => {
    const data = computeDistribution(
      '0xff6a3387cf21ef2ed2e94da324bce290ca9abc3b',
      [
        holder(LOCKER_7ED5, of(0.081633), true),
        holder(POOL_MANAGER, of(0.255804), true),
        holder('0x000000000000000000000000000000000000dead', of(0.039912)),
        holder('0xa60fe0b9d2c0e753c775daf7871bb2f927796671', of(0.02673)),
      ],
      {},
      { holders: 4, supply: E27 },
    );
    expect(data.top.find((h) => h.address === LOCKER_7ED5)).toMatchObject({
      kind: 'pool',
      role: 'locker',
    });
    expect(data.top[0]?.address).toBe('0xa60fe0b9d2c0e753c775daf7871bb2f927796671');
    expect(data.pooledShare).toBeCloseTo(0.377349, 4);
  });

  it('moon and RH: every listed pair is set aside, not only the launch pool', () => {
    // moon: the flap-graduated V2 pair 0x55ae… held 16.6 %; RH: its USDG pair 0x653d….
    const moonPair = '0x55aed1a1406ad8821b3cd0b3a189757acf007447';
    const rhUsdg = '0x653d5cc9e89962a93aab2dc1244ef34f431c28a3';
    const data = computeDistribution(
      '0x862cdccb67c8a22fdb247d09a08b1dad09447777',
      [
        holder(moonPair, of(0.165849), true),
        holder(rhUsdg, of(0.01164), true),
        holder('0x20ae13c30960e1069c5212927f99fcffb635c00d', of(0.03578)),
      ],
      {
        setAside: [
          { address: moonPair, role: 'pool' },
          { address: rhUsdg, role: 'pool' },
        ],
      },
      { holders: 3, supply: null, complete: true },
    );
    expect(data.top.filter((h) => h.kind === 'pool').map((h) => h.address)).toEqual(
      expect.arrayContaining([moonPair, rhUsdg]),
    );
    expect(data.concentration.top1).toBe(1);
  });

  it('a complete list measures the part set aside against its own sum', () => {
    const data = computeDistribution(
      '0xt',
      [
        holder(POOL_MANAGER, '90', true),
        holder('0x1111111111111111111111111111111111111111', '10'),
      ],
      {},
      { holders: 2, supply: null, complete: true },
    );
    expect(data.pooledShare).toBeCloseTo(0.9, 6);
  });
});

describe('holders: an EIP-7702 wallet is a wallet (bug 6)', () => {
  it('BOOMER: Blockscout calls 0x11bd… a contract; its code is a 7702 delegation', async () => {
    const delegated = '0x11bd5979b8583bee134f6b9eee3dd426a5a1f7b3';
    const contract = LOCKER_7ED5;
    const codes: Record<string, string> = {
      [delegated]: '0xef0100e6cae83bde06e4c305530e199d7217f42808555b',
      [contract]: '0x6080806040526004361015610012575f80fd5b',
    };
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: { params: string[] }[]) {
        return requests.map(({ params }) => ({ ok: true, value: codes[params[0]!] ?? '0x' }));
      },
    } as unknown as RpcClient;
    const data = computeDistribution(
      '0x127cdc74e44e3c60422b7e792ebe480c0f873ed5',
      [holder(delegated, '175', true), holder('0x5eae646bba71a2417b359092ded75ed3a237e27e', '1')],
      {},
    );
    const out = await recheckContracts(rpc, data);
    expect(out.top.find((h) => h.address === delegated)?.kind).toBe('wallet');
  });
});

function glanceFacts(holders: Partial<ReportFacts['holders']>): ReportFacts {
  return {
    creator: {
      measured: false,
      address: '0x89c5d00f166e4805946d3f30c596174f6cd2db7f',
      launched: 0,
      detailed: 0,
      graduated: 0,
      abandoned: 0,
      undetermined: 0,
      active: 0,
      checked: 0,
      soldIntoPool: 0,
      liquidityPulled: 0,
      salesChecked: 0,
      liquidityChecked: 0,
      source: null,
      role: null,
      launchContract: null,
      launchesListed: false,
      transactionCount: null,
    },
    holders: {
      measured: true,
      holderCount: 100,
      pooled: null,
      top1: 0.3,
      top10: 0.5,
      top: [],
      ...holders,
    },
    market: {
      measured: false,
      priceUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      buys24h: null,
      sells24h: null,
      fdvUsd: null,
      graduation: null,
    },
  };
}

describe('glance: a contract is never "one wallet" (bug 1)', () => {
  it('says "One contract" when the largest holder is a contract', () => {
    const glance = buildGlance({
      facts: glanceFacts({
        pooled: 0.3,
        top: [
          { address: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', share: 0.3, kind: 'contract' },
        ],
      }),
    })!;
    expect(glance.items.find((i) => i.id === 'supply')?.title).toMatch(/^One contract holds 30%/);
  });

  it('ECOGPT: says the supply is still on its launch curve, not in "the launch pool"', () => {
    const glance = buildGlance({
      facts: glanceFacts({
        pooled: 0.999482,
        setAside: [{ address: FLAP_PORTAL, role: 'curve', share: 0.999482 }],
      }),
    })!;
    expect(glance.items.find((i) => i.id === 'supply')?.title).toBe(
      '>99.9% of the supply is still in its launch curve: only <0.1% is held outside it so far.',
    );
  });
});

// ---------------------------------------------------------------------------
// The launch replay

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const CURVE_BUY = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455';
const MODIFY_LIQUIDITY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
const pad = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const n40 = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
let logIndex = 0;
function transferLog(
  token: string,
  from: string,
  to: string,
  value: bigint,
  block: number,
  tx: string,
): RawLog {
  return {
    address: token,
    topics: [TRANSFER, pad(from), pad(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: tx,
    logIndex: `0x${(logIndex++).toString(16)}`,
  };
}

/** A node answering a launch replay from a list of transfers and receipts. */
function launchNode(
  logs: RawLog[],
  supply: bigint,
  receipts: (hash: string) => { address: string; topics: string[]; data: string }[],
  launchBlock: number,
): RpcClient {
  return {
    async call<T>(method: string): Promise<T> {
      if (method === 'eth_call') return `0x${supply.toString(16)}` as T;
      return logs as T;
    },
    async callBatch(requests: { method: string; params: unknown[] }[]) {
      return requests.map((r) => {
        if (r.method === 'eth_getBlockByNumber') {
          const block = Number(r.params[0]);
          return {
            ok: true,
            value: {
              timestamp: `0x${(1_790_000_000 + Math.floor((block - launchBlock) / 10)).toString(16)}`,
            },
          };
        }
        if (r.method === 'eth_getTransactionReceipt') {
          return { ok: true, value: { logs: receipts(r.params[0] as string) } };
        }
        if (r.method === 'eth_getCode') return { ok: true, value: '0x' };
        return { ok: true, value: '0x0' };
      });
    },
  } as unknown as RpcClient;
}

describe('launch replay: totals over every transfer, not the 40 drawn (bug 2)', () => {
  it('RH: the transaction 0xafa97b… served 100 addresses and 87.5 % of the supply', async () => {
    // RH 0x99f2…ce24: SEAL said 35 wallets and 32 %, counted over the moves drawn.
    const token = '0x99f2e3420c1071bff35b8aef98a1339ea823ce24';
    const pool = '0xa7b6a6a6ba5c7bfe5235cae718dd7a9138599f6f';
    const bundleTx = '0xafa97b6eaaf34fc1bfc88ad41eadc5417729f454932e836838cbe1cc5ba292ba';
    const supply = E27;
    const launchBlock = 69_748_307;
    const logs: RawLog[] = [];
    // 120 small buys first, each in its own transaction.
    for (let i = 0; i < 120; i += 1) {
      logs.push(
        transferLog(
          token,
          pool,
          n40(10_000 + i),
          supply / 100_000n,
          launchBlock + 10 + i,
          `0xs${i}`,
        ),
      );
    }
    // Then one transaction delivering 0.875 % to each of 100 addresses, at +433 s.
    for (let i = 0; i < 100; i += 1) {
      logs.push(
        transferLog(
          token,
          pool,
          n40(20_000 + i),
          (supply * 875n) / 100_000n,
          launchBlock + 4_308,
          bundleTx,
        ),
      );
    }
    const rpc = launchNode(
      logs,
      supply,
      () => [{ address: pool, topics: [V3_SWAP], data: '0x' }],
      launchBlock,
    );
    const replay = await readLaunchReplay(rpc, token as `0x${string}`, {
      launchBlock,
      latestBlock: launchBlock + 1_000_000,
      pools: [pool],
    });
    expect(replay.data.moves.length).toBe(40);
    const story = buildStory(replay.data);
    expect(story.counted).toBe('all');
    expect(story.bundle).toMatchObject({ transaction: bundleTx, wallets: 100 });
    expect(story.bundle?.share).toBeCloseTo(0.875, 6);
    expect(replay.data.summary?.early.wallets).toBe(120);
    const glance = buildGlance({ facts: glanceFacts({}), launch: replay.data })!;
    expect(glance.items.find((i) => i.id === 'launch-buys')?.title).toBe(
      '100 wallets received 88% of the supply in one single transaction, 430 seconds after launch.',
    );
  });

  it('an old replay without totals says its figures are among the moves shown', () => {
    const move = (actor: string) => ({
      kind: 'buy' as const,
      seconds: 3,
      block: 0,
      actor,
      counterparty: '0xpool',
      actorKind: 'wallet' as const,
      share: 0.02,
      actorIsCreator: false,
      counterpartyIsCreator: false,
      heldNow: 0,
      transaction: '0x1',
    });
    const launch: LaunchReplayData = {
      token: '0xt',
      launchBlock: 1,
      launchedAt: null,
      windowSeconds: 600,
      supply: '1',
      moves: [move('0xa'), move('0xb'), move('0xc')],
      movesInWindow: 216,
    };
    const title = buildGlance({ facts: glanceFacts({}), launch })!.items.find(
      (i) => i.id === 'launch-buys',
    )?.title;
    expect(title).toMatch(/among the moves shown\.$/);
  });
});

describe('launch replay: a curve buy is a trade, not a withdrawal (bug 5)', () => {
  it('MUT8: three vaults buying on the 0x7ed5 curve then adding v4 liquidity stay buyers', async () => {
    const token = '0x48d343cae84ab737c46ce63cb74c926609eb03bb';
    const curve = '0x78dd2f4e84af6d0cc36e5f418d98a2eaa712dfd8';
    const router = '0x8cb50ced00000000000000000000000000000000';
    const vaults = [
      '0x92253f0dc487657c1d8fd5b71a7972b88149be9a',
      '0xac7b582cc44428b50919a5639acc6d4919f468b3',
      '0xd8d8fe098b55293cf3075e6e5950faccaf098a0c',
    ];
    const launchTx = '0xc8f6de6899152ab92be1ff76b0b0a4c4d99ce9bcf67d6637a8d901f586e0449a';
    const each = (E27 * 238_095n) / 1_000_000n;
    const moves = draftMoves(
      [
        transferLog(token, '0x0000000000000000000000000000000000000000', curve, E27, 1, launchTx),
        transferLog(token, curve, router, each * 3n, 1, launchTx),
        ...vaults.map((v) => transferLog(token, router, v, each, 1, launchTx)),
      ],
      new Set([curve, POOL_MANAGER]),
    );
    const rpc = launchNode(
      [],
      E27,
      () => [
        { address: curve, topics: [CURVE_BUY], data: '0x' },
        { address: POOL_MANAGER, topics: [MODIFY_LIQUIDITY], data: '0x' },
      ],
      1,
    );
    const out = await separateLiquidity(rpc, moves, new Set([curve, POOL_MANAGER]));
    expect(out.filter((m) => m.kind === 'buy').map((m) => m.actor)).toEqual(vaults);
    expect(out.some((m) => m.kind === 'withdraw')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Who first funded the creator (bug 3)

describe('funding: an unwrap is not a funding, a contract is not a wallet (bug 3)', () => {
  const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  const BONER_CREATOR = '0x79aeae6a47ff2e551f60bd87dbd6358efeaf4dc8';
  const BRIDGE = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';

  it('BONER: ETH sent by WETH in the creator’s own transaction is skipped', () => {
    const normal = [
      { blockNumber: '100', hash: '0xfund', from: BRIDGE, to: BONER_CREATOR, value: '5' },
      { blockNumber: '120', hash: '0xunwrap', from: BONER_CREATOR, to: WETH, value: '0' },
    ];
    const internal = [
      { blockNumber: '90', transactionHash: '0xolder', from: WETH, to: BONER_CREATOR, value: '9' },
      {
        blockNumber: '95',
        transactionHash: '0xunwrap',
        from: '0x1111111111111111111111111111111111111111',
        to: BONER_CREATOR,
        value: '9',
      },
    ];
    expect(
      firstIncoming(BONER_CREATOR, internal, { ownTransactions: sentBy(BONER_CREATOR, normal) }),
    ).toBeNull();
    expect(firstIncoming(BONER_CREATOR, normal)?.funder).toBe(BRIDGE);
    // The indexer's copy is tested in indexer/test/funders.test.ts.
  });

  it('an indexer funding stored as a WETH unwrap is asked again, not shown', () => {
    expect(
      fundingFacts({
        fundingState: 'found',
        funding: {
          funder: WETH,
          txHash: '0xunwrap',
          block: 1,
          kind: 'internal',
          funderKind: 'service',
          otherCreatorsFunded: [],
        },
      } as unknown as Parameters<typeof fundingFacts>[0]),
    ).toBeUndefined();
  });

  it('HYPURRT: a "MulticallHandler" with 0 transactions is a routing contract, not "high-volume"', () => {
    const f = CATALOG['funding-trace'].run({
      token: '0xff6a3387cf21ef2ed2e94da324bce290ca9abc3b',
      funding: {
        funder: '0xa8ad2e87e2043711d8bec77e8bc3e2683c0ab6bd',
        funderKind: 'service',
        funderName: 'MulticallHandler',
        funderTxCount: 0,
        otherCreatorsFunded: 0,
      },
    } as SpecialistContext);
    expect(f.facts[0]).toBe(
      'The creator wallet was first funded from a routing contract. A contract is not a person: it links this creator to no one, and says nothing about who is behind the wallet.',
    );
  });

  it('AGEM: the "Executor" contract that funded 25 creators links nobody', () => {
    const profile = {
      address: '0xa5166c3e69a933ee547ad908c9f1474f8f61901a',
      isContract: true,
      name: 'Executor',
      txCount: 0,
      tags: [],
    };
    expect(appClassifyFunder(profile)).toBe('service');
    expect(indexerClassifyFunder(profile)).toBe('service');
    const glance = buildGlance({
      facts: glanceFacts({}),
      specialists: [
        {
          specialist: 'funding-trace',
          title: 'Funding Trace',
          question: '',
          signal: 'quiet',
          facts: [],
          limits: [],
          funding: { kind: 'service', linkedCreators: 0, launches: null, depth: 0, path: [] },
        },
      ] as never,
    })!;
    expect(glance.items.find((i) => i.id === 'network')).toBeUndefined();
  });

  it('BONER: WETH, if ever shown, is "an upgradeable contract", never its raw proxy name', () => {
    expect(describeService('TransparentUpgradeableProxy', 2_973_472)).toBe(
      'a high-volume service (an upgradeable contract, 2,973,472 transactions)',
    );
    expect(describeContract('ERC1967Proxy')).toBe('an upgradeable contract');
  });
});

// ---------------------------------------------------------------------------
// Creator sales over the analysed token's whole life (bug 4)

describe('creator sales: the analysed token is read over its whole life (bug 4)', () => {
  const ASTEROID = '0xfd82d8db539b6ace0d50815845133767e24f1e18';
  const CREATOR = '0xf53e580690c1bdcab8292eaee58a479e375e372c';
  const SALE_TX = '0x7659595f90e75b2cc27dfb06143f1aa1d6141fa201c6001780443d493f9567ee';
  const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
  const LAUNCH = 9_681_917;
  const SALE = 77_427_045;
  const LATEST = 91_320_000;

  it('ASTEROID: the creator’s day-78 sale on the v4 PoolManager is found', async () => {
    const asked: { fromBlock: number; toBlock: number }[] = [];
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(batch: { method: string; params: unknown[] }[]) {
        return batch.map((r) => {
          const p = r.params[0] as { address?: string; fromBlock?: string; toBlock?: string };
          let value: unknown = null;
          if (r.method === 'eth_getLogs') {
            const from = Number(p.fromBlock);
            const to = Number(p.toBlock);
            if (p.address === ASTEROID) asked.push({ fromBlock: from, toBlock: to });
            value =
              p.address === ASTEROID && from <= SALE && SALE <= to
                ? [
                    {
                      address: ASTEROID,
                      topics: [TRANSFER, pad(CREATOR), pad(POOL_MANAGER)],
                      data: `0x${(405_054n * 10n ** 18n).toString(16).padStart(64, '0')}`,
                      blockNumber: `0x${SALE.toString(16)}`,
                      transactionHash: SALE_TX,
                      logIndex: '0x1',
                    },
                  ]
                : [];
          } else if (r.method === 'eth_getCode') value = '0x';
          else if (r.method === 'eth_getTransactionCount') value = '0x57c';
          else if (r.method === 'eth_getBlockByNumber') value = { timestamp: '0x68756e9c' };
          else if (r.method === 'eth_getTransactionReceipt')
            value = {
              contractAddress: null,
              logs: [{ address: POOL_MANAGER, topics: [V4_SWAP], data: '0x' }],
            };
          return { ok: true, value };
        });
      },
    } as unknown as RpcClient;
    const history = await fetchDeployerHistory(
      rpc,
      {
        token: ASTEROID,
        creator: CREATOR,
        role: 'launcher',
        blockNumber: LAUNCH,
        transactionHash: '0xlaunch',
        venues: {
          pools: [],
          v4Markets: ['0x15a09db785c7b5fc9d794f685a04e4ad38842a2035b9a8fab17909c0e54c425f'],
          saleRecipients: [POOL_MANAGER],
        },
      },
      { latestBlock: LATEST, maxListingQueries: 0, now: () => new Date('2026-10-18T00:00:00Z') },
    );
    const own = history.data.tokens.find((t) => t.address === ASTEROID);
    expect(own?.creatorDumped).toBe(true);
    expect(own?.salesWindow).toMatchObject({ fromBlock: LAUNCH, toBlock: LATEST, wholeLife: true });
    // Read in 10 M-block windows up to the latest block, not the first 11 days only.
    expect(Math.max(...asked.map((a) => a.toBlock))).toBe(LATEST);
  });

  it('says over which days each launch was read', () => {
    const f = glanceFacts({});
    f.creator = {
      ...f.creator,
      measured: true,
      launched: 11,
      detailed: 11,
      checked: 10,
      salesChecked: 10,
      soldIntoPool: 8,
      ownSales: { days: 96, wholeLife: true },
    };
    const sales = buildGlance({ facts: f })!.items.find((i) => i.id === 'sales');
    expect(sales?.detail).toBe(
      'This token’s sales checked over its whole life so far (96 days); the creator’s other launches in the first 11 days after each. Each confirmed by a trade in the market.',
    );
  });
});

describe('holders: an airdrop is not a spread of buyers (bug 10)', () => {
  it('ELON: 10,030 holders, 10,100 of them sent the token by the creator', () => {
    const ELON = '0x90f2e43af1028a443a4a0b2cf224ebdfe43a1236';
    const report = {
      token: ELON,
      creator: {
        completeness: 'partial',
        sources: [],
        data: {
          creator: '0x6eae1530779565e778919603479fe99c69ad7d20',
          tokens: [
            {
              address: ELON,
              pool: '0x',
              launchedAtBlock: 1,
              launchedAt: null,
              outcome: 'undetermined',
              graduationProgress: 0,
              liquidityPulled: false,
              creatorDumped: null,
              creatorRecipients: 10_100,
            },
          ],
        },
      },
      holders: {
        completeness: 'partial',
        sources: [],
        data: {
          token: ELON,
          countedSupply: '1',
          holderCount: 10_030,
          top: [],
          concentration: { top1: 0.05, top10: 0.2 },
          pooledShare: 0.509104,
          distinctTraders: null,
        },
      },
    } as unknown as SpecialistContext['report'];
    const f = CATALOG['holder-spread'].run({ token: ELON, report } as SpecialistContext);
    expect(f.signal).not.toBe('reassurance');
    expect(f.facts.join(' ')).toMatch(/sent this token directly to 10100 addresses/);
  });
});

// ---------------------------------------------------------------------------
// The creator's record (bugs 7 and 9)

describe('record: never "first token" while some launches cannot be listed (bug 7)', () => {
  it('AGEM-like: one launch found, Doppler and direct deploys not listed', () => {
    const f = glanceFacts({});
    f.creator = {
      ...f.creator,
      measured: true,
      launched: 1,
      detailed: 1,
      launchesListed: true,
      notListed: ['Doppler', 'contracts deployed directly'],
    };
    const record = buildGlance({ facts: f })!.items.find((i) => i.id === 'record');
    expect(record?.title).toBe(
      'No other launch by this creator was found on the launchpads SEAL can list (Doppler and direct deploys are not listed).',
    );
    expect(record?.title).not.toMatch(/first token|at least/);
  });

  it('ECOGPT: a flap.sh creator whose launches cannot be listed is not "at least 1 token"', () => {
    const f = glanceFacts({});
    f.creator = {
      ...f.creator,
      measured: true,
      launched: 1,
      detailed: 1,
      launchesListed: false,
      launchpad: 'flap.sh',
      notListed: ['Doppler', 'contracts deployed directly'],
    };
    expect(buildGlance({ facts: f })!.items.find((i) => i.id === 'record')?.title).toBe(
      'No other launch by this creator was found on the launchpads SEAL can list (flap.sh, Doppler and direct deploys are not listed).',
    );
  });
});

describe('record: the span is said of the launches it rests on (bug 9)', () => {
  it('80 launches, 40 read in detail over 24 days: not "80 tokens in 24 days"', () => {
    const f = glanceFacts({});
    f.creator = {
      ...f.creator,
      measured: true,
      launched: 80,
      detailed: 40,
      launchesListed: true,
      notListed: [],
      graduation: 'not-measured',
    };
    const start = Date.UTC(2026, 8, 20);
    const timeline = Array.from({ length: 40 }, (_, i) => ({
      address: `0x${String(i).padStart(40, '0')}`,
      launchedAt: new Date(start + (i * 24 * 86_400_000) / 39).toISOString(),
      block: i,
      outcome: 'undetermined' as const,
      progress: 0,
      sold: null,
      pulled: null,
      current: false,
    }));
    expect(buildGlance({ facts: f, timeline })!.items.find((i) => i.id === 'record')?.title).toBe(
      'This creator launched 80 tokens; the 40 read in detail came in 24 days.',
    );
  });
});

// ---------------------------------------------------------------------------
// Listed liquidity checked against the chain (bug 8), and market wording (bug 10)

describe('market: a listed liquidity the chain contradicts is not liquidity (bug 8)', () => {
  const MOON = '0xa472318678664cc67ffdf111fe48beb36e69f95f';
  // DexScreener's answer for MOON on 17/10/2026, 23:24 UTC (audit ds_ file).
  const pairs = [
    {
      pairAddress: '0x87236799e460f88e89f6d1b03d6c7faa07fdb0f6f1a131f23a4183530b188956',
      baseToken: { address: MOON },
      priceUsd: '0.0000853',
      liquidity: { usd: 61890.98, base: 475384426, quote: 8.8277 },
      txns: {
        m5: { buys: 0, sells: 0 },
        h1: { buys: 0, sells: 0 },
        h6: { buys: 601, sells: 391 },
        h24: { buys: 601, sells: 391 },
      },
      volume: { h24: 337400.56, h6: 337400.56, h1: 0, m5: 0 },
      fdv: 85309,
    },
  ];

  it('MOON: pools holding 0.002 % of the supply make the $61.9k listed not current', async () => {
    // The creator removed 100 % of the liquidity 25 minutes after launch
    // (ModifyLiquidity, block 91,212,119): the PoolManager holds 0.002 %.
    const balances: Record<string, bigint> = { supply: 10n ** 27n, pm: 2n * 10n ** 22n };
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: { params: [{ data: string }] }[]) {
        return requests.map((r) => ({
          ok: true,
          value: `0x${(r.params[0].data === '0x18160ddd' ? balances.supply! : balances.pm!).toString(16)}`,
        }));
      },
    } as unknown as RpcClient;
    const poolsShare = await readPoolsShare(rpc, MOON, [POOL_MANAGER]);
    expect(poolsShare).toBeCloseTo(0.00002, 6);
    const market = checkLiquidity(toMarketState(MOON, pairs), poolsShare);
    expect(market.data.quiet).toEqual({ hours: 1 });
    expect(market.data.liquidityCheck).toEqual({ poolsShare, current: false });
    const facts = toFacts({
      token: MOON,
      collectedAt: '2026-10-17T23:24:09.128Z',
      creator: {
        completeness: 'unavailable',
        sources: [],
        data: {
          creator: '0x',
          tokens: [],
          counts: {
            launched: 0,
            graduated: 0,
            abandoned: 0,
            undetermined: 0,
            liquidityPulled: 0,
            creatorDumped: 0,
          },
          scannedRange: { fromBlock: 0, toBlock: 0 },
        },
      },
      holders: {
        completeness: 'unavailable',
        sources: [],
        data: {
          token: MOON,
          countedSupply: '0',
          holderCount: null,
          top: [],
          concentration: { top1: 0, top10: 0 },
          distinctTraders: null,
        },
      },
      market,
      completeness: 'partial',
    } as TokenReport);
    expect(facts.market.liquidityUsd).toBeNull();
    const item = buildGlance({ facts })!.items.find((i) => i.id === 'market');
    expect(item).toMatchObject({ tone: 'attention' });
    expect(item?.title).toBe(
      'Its pools hold <0.1% of the supply today: the $61.9k of liquidity DexScreener lists is not current. No trade in the last hour.',
    );
  });

  it('a pair traded in the last five minutes is not quiet', () => {
    expect(
      quietFor({ m5: { buys: 1 }, h1: { buys: 3 }, h6: { buys: 5 }, h24: { buys: 9 } }),
    ).toBeNull();
  });
});

describe('wording: market figures and launchpad names (bug 10)', () => {
  it('says $7.3M, not $7279.8k', () => {
    expect(usdShort(7_279_812)).toBe('$7.3M');
    expect(usdShort(253_700)).toBe('$253.7k');
    expect(usdShort(337)).toBe('$337');
  });
});
