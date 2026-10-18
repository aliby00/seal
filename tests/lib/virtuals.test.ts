import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderLaunch, renderReport } from '../../src/lib/agent/prompt';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { creatorFilter, findLaunchRecord, LAUNCHPADS, readOrigin } from '../../src/lib/chain';
import { LAUNCHPAD_WALLETS, VIRTUALS } from '../../src/lib/chain/launchpads';
import type { RawLog } from '../../src/lib/chain/logs';
import { decodePreset, knownName, readAddressRoles, unlockSteps } from '../../src/lib/chain/roles';
import type { BatchOutcome, RpcClient, RpcRequest } from '../../src/lib/chain/rpc';
import type {
  HolderDistributionData,
  LaunchReplayData,
  NamedAddress,
  TokenReport,
} from '../../src/lib/contracts';
import { toFacts } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';
import { withRoles } from '../../src/lib/holders/roles';
import { buildSupplyFlow, flowSentence, lockWords } from '../../src/lib/supply-flow';
import { CATALOG } from '../../src/lib/specialists/catalog';
import { shortAnswer } from '../../src/lib/specialists/plain';
import type { SpecialistAnswer } from '../../src/lib/specialists/brief';
import { makeReport } from '../specialists/helpers';
import holdersFixture from './fixtures/sirius/holders.json';
import launchFixture from './fixtures/sirius/launch.json';
import receiptFixture from './fixtures/sirius/receipt.json';
import rolesFixture from './fixtures/sirius/roles.json';
import rpcFixture from './fixtures/sirius/rpc.json';

/**
 * SIRIUS (0x72e9…6c88), launched on Virtuals on 28/08/2026, read on chain on
 * 18/10/2026. The report said "the largest holder, a contract, has 28 %",
 * drew an empty buyers chart, and wrote that the data "does not say where
 * the two later transfers came from". On chain: 50 % to Virtuals' curve,
 * 50 % to Virtuals' reserve wallet, which passed 25 % to Virtuals'
 * capital-formation wallet and 25 % to a TokenTable lock for the creator.
 */

const SIRIUS = '0x72e936815982a577386e8fcde94f5c9335836c88';
const CREATOR = '0xc47ff45c87ee89a999b95ed6d4f408674d9bed9f';
const CURVE = '0x0539b29ff2c295d396a5618b33db2788706334f0';
const V2_PAIR = '0x828571e17c68de8badf1b9b24890c71726c8dba5';
const LOCK = '0x75eb52136c4263b45bd22c0fb786f1e976b629e1';
const V3_POOL = '0x1991eefbd75557ccde431a35bde3c7d9b4df16c9';
const SUPPLY = 10n ** 27n;
const NOW = () => new Date('2026-10-18T12:00:00.000Z');

const roles = rolesFixture.roles as NamedAddress[];
const launch = launchFixture.launch as LaunchReplayData;
const logs = receiptFixture.receipt.logs as RawLog[];
const mint = logs.find(
  (l) => l.address.toLowerCase() === SIRIUS && l.topics[1] === `0x${'0'.repeat(64)}`,
)!;

/** The node's recorded answers, replayed; anything not recorded fails as the node would. */
function recordedNode(): RpcClient {
  const answers = rpcFixture.answers as Record<string, { result?: string; error?: string }>;
  const key = (r: RpcRequest) =>
    r.method === 'eth_call'
      ? `call|${(r.params[0] as { to: string }).to.toLowerCase()}|${(r.params[0] as { data: string }).data}`
      : `${r.method}|${String(r.params[0]).toLowerCase()}`;
  return {
    async callBatch<T>(requests: RpcRequest[]): Promise<BatchOutcome<T>[]> {
      return requests.map((r) => {
        const a = answers[key(r)];
        return a && a.result !== undefined
          ? { ok: true, value: a.result as T }
          : { ok: false, error: a?.error ?? 'not recorded' };
      });
    },
    async call<T>(): Promise<T> {
      throw new Error('not recorded');
    },
  } as RpcClient;
}

function holdersData(): HolderDistributionData {
  // As computeDistribution leaves them: the two pools already set aside.
  const top = holdersFixture.top.filter((h) => h.address !== V2_PAIR);
  const pooled = BigInt(holdersFixture.top.find((h) => h.address === V2_PAIR)!.balance);
  const circulating = SUPPLY - pooled;
  return {
    token: SIRIUS,
    countedSupply: circulating.toString(),
    holderCount: holdersFixture.holderCount - 1,
    top: top.map((h) => ({
      address: h.address,
      balance: h.balance,
      share: Number((BigInt(h.balance) * 1_000_000n) / circulating) / 1_000_000,
      kind: h.isContract ? 'contract' : 'wallet',
    })),
    concentration: { top1: 0.32886, top10: 0.7 },
    pooledShare: Number((pooled * 1_000_000n) / SUPPLY) / 1_000_000,
    setAside: [{ address: V2_PAIR, role: 'pool', share: 0.130926 }],
    distinctTraders: null,
  };
}

export function siriusReport(): TokenReport {
  return makeReport(SIRIUS, (r) => {
    r.creator.data.creator = CREATOR;
    r.creator.data.origin = {
      ...readOrigin(SIRIUS, mint, receiptFixture.transaction, receiptFixture.receipt as never),
      source: 'deployer',
      launchesListed: true,
      transactionCount: 11,
    } as never;
    r.holders.data = withRoles(holdersData(), roles, SUPPLY);
    // The market as DexScreener listed it on 18/10/2026.
    const m = launchFixture.market;
    r.market.data.priceUsd = m.priceUsd;
    r.market.data.liquidityUsd = m.liquidityUsd;
    r.market.data.fdvUsd = m.fdvUsd;
    r.market.data.volumeUsd = { m5: 0, h1: 0, h6: 0, h24: m.volume24hUsd };
    r.market.data.txns = { h1: { buys: 0, sells: 0 }, h24: { buys: m.buys24h, sells: m.sells24h } };
    r.market.data.pair = '0x828571E17c68DE8bADf1B9B24890C71726C8dbA5';
    r.market.data.pools = [
      {
        id: V2_PAIR,
        version: 'v2',
        base: true,
        liquidityUsd: 45_746,
      } as never,
    ];
    r.launch = { completeness: 'full', sources: [], data: launch };
    r.roles = roles;
  });
}

/** What /api/analyze answers for SIRIUS offline, as the browser test serves it. */
export function siriusAnalysis() {
  const report = siriusReport();
  const specialists = (['code-reuse', 'holder-spread', 'rule-change'] as const).map((id) => {
    const f = CATALOG[id].run({ token: SIRIUS, report, market: null, hook: null });
    return {
      specialist: id,
      title: CATALOG[id].title,
      question: CATALOG[id].question,
      signal: f.signal,
      facts: f.facts,
      limits: f.limits,
      ...(f.notApplicable ? { notApplicable: true } : {}),
    };
  });
  return {
    token: SIRIUS,
    explanation: offlineExplanation(report),
    completeness: 'full',
    sources: [],
    costUsd: 0,
    collectedAt: '2026-10-18T12:00:00.000Z',
    offline: true,
    name: 'SIRIUS',
    symbol: 'SIRIUS',
    facts: toFacts(report),
    specialists,
    launch: report.launch!.data,
  };
}

describe('the browser test’s SIRIUS fixture', () => {
  it('is what the pipeline builds from the chain fixtures', () => {
    const served = JSON.parse(readFileSync('tests/e2e/fixtures/sirius-analysis.json', 'utf8'));
    expect(served).toEqual(JSON.parse(JSON.stringify(siriusAnalysis())));
  });
});

describe('Virtuals as a launchpad', () => {
  it('reads SIRIUS’s launch: the creator from the tax manager, the curve from the launchpad', () => {
    const record = findLaunchRecord(SIRIUS, logs, CREATOR);
    expect(record).toMatchObject({ creator: CREATOR, curve: CURVE });
    expect(record?.launchpad.id).toBe('virtuals');
    const origin = readOrigin(
      SIRIUS,
      mint,
      receiptFixture.transaction,
      receiptFixture.receipt as never,
    );
    expect(origin).toMatchObject({
      creator: CREATOR,
      role: 'launcher',
      launchContract: VIRTUALS.bonding,
      launchpad: { id: 'virtuals', name: 'Virtuals' },
      creatorFrom: 'launch-record',
    });
    // The curve and the Uniswap v2 pair against VIRTUAL, both places a sale lands.
    expect(origin.venues.curves).toEqual([CURVE]);
    expect(origin.venues.pools).toContain(V2_PAIR);
    expect(origin.venues.saleRecipients).toEqual(expect.arrayContaining([CURVE, V2_PAIR]));
    expect(origin.venues.curveTrades).toContain(
      '0x298c349c742327269dc8de6ad66687767310c948ea309df826f5bd103e19d207',
    );
  });

  it('lists a creator’s Virtuals launches from the node, by the tax manager’s indexed creator', () => {
    const tax = LAUNCHPADS.find((l) => l.address === VIRTUALS.taxManager)!;
    expect(creatorFilter(tax, CREATOR)).toEqual([
      tax.topic0,
      null,
      `0x${'0'.repeat(24)}${CREATOR.slice(2)}`,
    ]);
    // The launchpad's own event does not name the creator.
    const bonding = LAUNCHPADS.find((l) => l.address === VIRTUALS.bonding)!;
    expect(creatorFilter(bonding, CREATOR)).toBeNull();
  });
});

describe('naming addresses by their role', () => {
  it('decodes a TokenTable preset as read on SIRIUS’s lock', () => {
    // getEncodedPreset of the 250 M schedule: one unlock at the start, then five over 150 days.
    const raw = (rpcFixture.answers as Record<string, { result?: string }>)[
      `call|${LOCK}|0x2de1d431000000000000000000000000000000000000000000000000000001a048e82037`
    ]!.result;
    const preset = decodePreset(raw)!;
    expect(preset).toEqual({
      starts: [0, 1],
      end: 12_960_001,
      bips: [1666, 8334],
      unlocks: [1, 5],
      stream: false,
    });
    const steps = unlockSteps(preset);
    expect(steps).toHaveLength(6);
    expect(steps[0]).toEqual({ at: 1, bips: 1666 });
    expect(steps.at(-1)!.at).toBe(12_960_001);
  });

  it('names SIRIUS’s holders from the node’s own answers', async () => {
    const named = await readAddressRoles(
      recordedNode(),
      [
        LOCK,
        VIRTUALS.acfWallet,
        V3_POOL,
        '0x9080acd0298cd64841436cd2f1a714ec38b374b8',
        VIRTUALS.reserveWallet,
        CURVE,
      ].map((address) => ({ address, isContract: null })),
      { token: SIRIUS, supply: SUPPLY, launchpad: 'virtuals', curves: [CURVE], now: NOW },
    );
    const by = (a: string) => named.find((n) => n.address === a);
    expect(by(LOCK)).toMatchObject({
      kind: 'vesting',
      name: 'Virtuals’ team lock (TokenTable)',
      tradable: false,
      lock: {
        provider: 'TokenTable',
        owner: VIRTUALS.reserveWallet,
        cancelable: true,
        withdrawable: true,
        locked: 0.285747,
        nextUnlockAt: '2026-11-29T15:06:37.000Z',
        fullyUnlockedAt: '2028-01-25T15:06:08.000Z',
      },
    });
    expect(by(LOCK)!.lock!.schedules.map((s) => [s.beneficiary, s.total, s.steps])).toEqual([
      [CREATOR, 0.035747, 9],
      [CREATOR, 0.25, 6],
    ]);
    expect(by(V3_POOL)).toMatchObject({ kind: 'pool', name: 'a V3 trading pool against USDG' });
    expect(by(VIRTUALS.acfWallet)).toMatchObject({ kind: 'capital-formation', tradable: true });
    expect(by(VIRTUALS.reserveWallet)?.kind).toBe('distributor');
    expect(by(CURVE)?.name).toBe('Virtuals’ launch curve');
    expect(by('0x9080acd0298cd64841436cd2f1a714ec38b374b8')?.kind).toBe('smart-wallet');
  });

  it('never names an address it could not read', async () => {
    const empty = {
      callBatch: async (r: RpcRequest[]) => r.map(() => ({ ok: false, error: 'busy' })),
      call: async () => {
        throw new Error('busy');
      },
    } as unknown as RpcClient;
    const named = await readAddressRoles(empty, [{ address: LOCK, isContract: true }], {
      token: SIRIUS,
      supply: SUPPLY,
    });
    expect(named).toEqual([]);
  });

  it('knows a launchpad’s wallets and contracts without a read', () => {
    expect(knownName(VIRTUALS.bonding, {})?.name).toBe('Virtuals’ launch contract');
    expect(knownName('0x0000000000000000000000000000000000000001', {})).toBeNull();
    expect(LAUNCHPAD_WALLETS.has(VIRTUALS.reserveWallet)).toBe(true);
  });
});

describe('SIRIUS’s holders, once named', () => {
  it('sets the lock and the unlisted V3 pool aside, and names the rest', () => {
    const data = withRoles(holdersData(), roles, SUPPLY);
    expect(data.setAside?.map((s) => [s.address, s.role])).toEqual(
      expect.arrayContaining([
        [LOCK, 'vesting'],
        [V3_POOL, 'pool'],
        [V2_PAIR, 'pool'],
      ]),
    );
    const largest = data.top.find((h) => h.kind === 'wallet' || h.kind === 'contract')!;
    expect(largest.address).toBe(VIRTUALS.acfWallet);
    expect(largest.name).toBe('Virtuals’ capital-formation wallet (ACF)');
    // 17.95 % of the supply, over the 53.3 % outside pools and the lock.
    expect(largest.share).toBeCloseTo(0.1795 / 0.532, 2);
    expect(data.pooledShare).toBeCloseTo(0.1309 + 0.0505 + 0.2857, 3);
  });
});

describe('SIRIUS’s report', () => {
  it('draws where the supply went, by role', () => {
    const flow = buildSupplyFlow(launch, roles, 'Virtuals')!;
    expect(flow.buys).toBe(0);
    expect(flow.roots.map((r) => [r.name, r.received])).toEqual([
      ['Virtuals’ launch curve', 0.5],
      ['Virtuals’ reserve wallet', 0.5],
    ]);
    expect(flow.roots[1]!.children.map((c) => [c.name, c.received, c.heldNow])).toEqual([
      ['Virtuals’ capital-formation wallet (ACF)', 0.25, 0.1795],
      ['Virtuals’ team lock (TokenTable)', 0.25, 0.285747],
    ]);
    const sentence = flowSentence(flow, CREATOR);
    expect(sentence).toMatch(
      /^Launched on Virtuals\. At launch, 50% of the supply went to Virtuals’ launch curve/,
    );
    expect(sentence).toMatch(
      /25% to Virtuals’ team lock \(TokenTable\), where 28\.6% is locked for the creator/,
    );
    expect(sentence).toMatch(/unlocking from Nov 29, 2026 to Jan 25, 2028/);
    expect(sentence).not.toMatch(/a contract/);
  });

  it('opens the glance with it, and never calls the lock "one contract"', () => {
    const report = siriusReport();
    const facts = toFacts(report);
    const glance = buildGlance({ facts, launch })!;
    expect(glance.items[0]!.id).toBe('flow');
    expect(glance.items[0]!.href).toBe('#supply-flow');
    expect(glance.headline).toMatch(/^Launched on Virtuals/);
    const supply = glance.items.find((i) => i.id === 'supply');
    expect(supply?.title).toMatch(/^Virtuals’ capital-formation wallet \(ACF\) holds/);
    expect(supply?.title).toMatch(/sits in Virtuals’ team lock \(TokenTable\), left out/);
    expect(glance.items.map((i) => i.title).join(' ')).not.toMatch(/One contract/);
  });

  it('says where the launch-window transfers came from', () => {
    const lines = renderLaunch({ completeness: 'full', sources: [], data: launch }, { roles });
    expect(lines.join('\n')).toMatch(
      /0xe2890629ef31b32132003c02b29a50a025deee8a \(Virtuals’ capital-formation wallet \(ACF\)\), sent by 0x81f7ca6af86d1ca6335e44a2c28bc88807491415 \(Virtuals’ reserve wallet\)/,
    );
    const prompt = renderReport(siriusReport());
    expect(prompt).toMatch(/## Where the supply went at launch/);
    expect(prompt).toMatch(/can still cancel schedules and withdraw the deposit/);
    const offline = offlineExplanation(siriusReport());
    expect(offline).toMatch(/Launch: Launched on Virtuals\./);
  });

  it('says the v4-only questions do not apply to its Uniswap v2 pair', () => {
    const report = siriusReport();
    for (const id of ['code-reuse', 'rule-change'] as const) {
      const f = CATALOG[id].run({ token: SIRIUS, report, market: null, hook: null });
      expect(f.notApplicable).toBe(true);
      expect(f.limits[0]).toBe(
        'not applicable: this market has no trading-rules contract (Uniswap v2 pair 0x8285…dbA5)',
      );
      const answer = { ...f, title: '', question: '' } as SpecialistAnswer;
      expect(shortAnswer(answer)).toMatch(
        /^Not applicable: this market has no trading-rules contract/,
      );
    }
    const spread = CATALOG['holder-spread'].run({
      token: SIRIUS,
      report,
      market: null,
      hook: null,
    });
    const text = spread.facts.join(' ');
    expect(text).toMatch(/28\.6% of the supply is in Virtuals’ team lock \(TokenTable\)/);
    expect(text).toMatch(/The largest holder \(Virtuals’ capital-formation wallet \(ACF\)/);
    expect(text).not.toMatch(/\(a contract\)/);
  });

  it('says a lock’s dates as a person reads them', () => {
    const lock = roles.find((r) => r.kind === 'vesting')!.lock!;
    expect(lockWords(lock, CREATOR, 0.25)).toBe(
      '28.6% is locked for the creator (3.6% of it added after the launch), unlocking from Nov 29, 2026 to Jan 25, 2028',
    );
  });
});
