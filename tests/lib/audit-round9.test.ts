import { describe, expect, it } from 'vitest';
import { withoutClaims } from '../../src/lib/agent/claims';
import { renderReport } from '../../src/lib/agent/prompt';
import {
  creatorRemovals,
  fetchDeployerHistory,
  MAX_CHECKED_DEPLOYER_LAUNCHES,
  pickCheckedLaunches,
  removalsInTransactions,
  removalWithoutSender,
  V3_POSITION_MANAGER,
  V4_POSITION_MANAGER,
  MODIFY_LIQUIDITY_TOPIC,
  type ListedLaunch,
  type PositionHoldings,
  type TokenOrigin,
} from '../../src/lib/chain/deployer';
import { LAUNCHPADS } from '../../src/lib/chain/launchpads';
import type { RawLog } from '../../src/lib/chain/logs';
import { POOL_MANAGER } from '../../src/lib/chain/pools';
import type { RpcClient, RpcRequest } from '../../src/lib/chain/rpc';
import { checkedByLaunchpad } from '../../src/lib/checked-sample';
import type { LaunchReplayData, LaunchedToken, TokenReport } from '../../src/lib/contracts';
import { toFacts } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';
import { buildStory } from '../../src/lib/launch-story';
import { CATALOG } from '../../src/lib/specialists/catalog';
import type { SpecialistContext } from '../../src/lib/specialists/types';
import { makeReport } from '../specialists/helpers';
import ai from './fixtures/audit9/ai-launches.json';
import removalLogs from './fixtures/audit9/removal-logs.json';
import texts from './fixtures/audit9/texts.json';

/**
 * The ninth audit of staging (18/10/2026): AI's creator sold into the pools
 * of its pons launches while the report checked its ten latest Doppler ones
 * only; RH's round trips left out without a word; three wording slips; and
 * the liquidity of five busy markets partial on every retry.
 */

const AI = '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18';
const AI_CREATOR = '0x9b1513dfdfc023fa6e576b130066ec05b6f1bfa1';
const DOPPLER_FRONT = LAUNCHPADS.find((l) => l.id === 'doppler-22e9')!;
/** The pons launches the creator sold into (degraded run, then the chain: tx 0xdc76a12b…). */
const PONS_SOLD = [
  '0x2d2e491348557fbb639ccadc66b46ba420a1011c',
  '0x19fead2eef53be11a43744fd803bb9151b6d98fc',
  '0x2b1ceb0a6e596cddb056e1609f7987119ad24de7',
];

/** AI's 80 launches as read on chain: 21 on pons, 59 on Doppler's 0x22e9. */
const listed: ListedLaunch[] = ai.launches.map((l) => ({
  token: l.token,
  blockNumber: l.block,
  transactionHash: l.txHash,
  launchpad: LAUNCHPADS.find((p) => p.address === l.factory),
}));

// ---------------------------------------------------------------------------
// 1. Every launchpad the creator used has its launches checked

describe('a serial launcher’s sales on every launchpad (item 1)', () => {
  it('AI’s real list: the ten most recent of each launchpad, the pons ones with sales among them', () => {
    expect(listed.filter((l) => l.launchpad?.id === 'pons')).toHaveLength(21);
    expect(listed.filter((l) => l.launchpad?.id === 'doppler-22e9')).toHaveLength(59);
    const { checked, sample } = pickCheckedLaunches(listed, AI);
    const pons = checked.filter((l) => l.launchpad?.id === 'pons').map((l) => l.token);
    const doppler = checked.filter((l) => l.launchpad?.id === 'doppler-22e9');
    expect(pons).toHaveLength(MAX_CHECKED_DEPLOYER_LAUNCHES);
    expect(doppler).toHaveLength(MAX_CHECKED_DEPLOYER_LAUNCHES);
    for (const token of PONS_SOLD) expect(pons).toContain(token);
    // The most recent of each, not the most recent overall (all Doppler).
    expect(Math.min(...doppler.map((l) => l.blockNumber))).toBe(22_919_190);
    expect(checked.map((l) => l.token)).not.toContain(AI);
    expect(sample).toEqual([
      { launchpad: 'Doppler launchpad 0x22e9…', listed: 58, checked: 10 },
      { launchpad: 'pons', listed: 21, checked: 10 },
    ]);
  });

  it('the history checks them all, says how many of each, and reads the pons launch 0x2d2e4913…', async () => {
    const receipts: string[] = [];
    const rpc = {
      async call() {
        return '0x';
      },
      async callBatch(batch: RpcRequest[]) {
        return batch.map((r) => {
          if (r.method === 'eth_getTransactionReceipt') receipts.push(String(r.params[0]));
          if (r.method === 'eth_getLogs') return { ok: true, value: [] };
          if (r.method === 'eth_getBlockByNumber')
            return { ok: true, value: { timestamp: '0x6a000000' } };
          if (r.method === 'eth_getCode') return { ok: true, value: '0x' };
          if (r.method === 'eth_getTransactionCount') return { ok: true, value: '0x52e' };
          return { ok: true, value: null };
        });
      },
    } as unknown as RpcClient;
    const own = listed.find((l) => l.token === AI)!;
    const origin: TokenOrigin = {
      token: AI,
      creator: AI_CREATOR,
      role: 'launcher',
      blockNumber: own.blockNumber,
      transactionHash: own.transactionHash,
      launchpad: { id: DOPPLER_FRONT.id, name: DOPPLER_FRONT.name, address: DOPPLER_FRONT.address },
      creatorFrom: 'launch-record',
      venues: { pools: [], v4Markets: [], hooks: [], saleRecipients: [] },
    };
    const history = await fetchDeployerHistory(rpc, origin, {
      latestBlock: 91_789_894,
      maxListingQueries: 0,
      indexed: { launches: listed, covered: new Set(['pons', 'doppler-22e9']) },
      now: () => new Date('2026-10-18T12:35Z'),
    });
    const launchTx = (token: string) => listed.find((l) => l.token === token)!.transactionHash;
    for (const token of PONS_SOLD) expect(receipts).toContain(launchTx(token));
    expect(receipts).toHaveLength(20);
    expect(history.data.checkedSample).toEqual([
      { launchpad: 'Doppler launchpad 0x22e9…', listed: 58, checked: 10 },
      { launchpad: 'pons', listed: 21, checked: 10 },
    ]);
    expect(history.data.counts.launched).toBe(80);
    expect(history.sources[0]?.note).toBe(
      'creator read from its Doppler launchpad 0x22e9… launch record; 40 of 80 launches read in detail, the most recent on each launchpad',
    );
  });

  /** AI's history once checked: this token sold, and 3 of its 10 latest pons launches. */
  function aiReport() {
    const { checked, sample } = pickCheckedLaunches(listed, AI);
    const checkedSet = new Set(checked.map((l) => l.token));
    const tokens: LaunchedToken[] = listed
      .filter((l) => l.token === AI || checkedSet.has(l.token))
      .map((l) => ({
        address: l.token,
        pool: '0x',
        launchedAtBlock: l.blockNumber,
        launchedAt: null,
        outcome: 'undetermined',
        graduationProgress: 0,
        launchpad: l.launchpad!.name,
        creatorDumped: l.token === AI || PONS_SOLD.includes(l.token),
        liquidityPulled: l.token === AI ? null : false,
        ...(l.token === AI
          ? {
              salesWindow: {
                fromBlock: l.blockNumber,
                toBlock: 91_789_894,
                days: 96,
                wholeLife: true,
              },
            }
          : {}),
      }));
    return makeReport(AI, (r) => {
      r.creator.completeness = 'partial';
      r.creator.data = {
        creator: AI_CREATOR,
        origin: {
          source: 'deployer',
          role: 'launcher',
          launchpad: {
            id: DOPPLER_FRONT.id,
            name: DOPPLER_FRONT.name,
            address: DOPPLER_FRONT.address,
          },
          creatorFrom: 'launch-record',
          launchesListed: true,
          transactionCount: 1326,
        },
        tokens,
        counts: {
          launched: 80,
          graduated: 0,
          abandoned: 0,
          undetermined: tokens.length,
          liquidityPulled: 0,
          creatorDumped: 4,
        },
        checkedSample: sample,
        scannedRange: { fromBlock: 0, toBlock: 91_789_894 },
      };
    });
  }

  it('the glance, the question and the prompt say which launches were checked', () => {
    const report = aiReport();
    expect(checkedByLaunchpad(report.creator.data, AI)).toEqual([
      {
        launchpad: 'Doppler launchpad 0x22e9…',
        listed: 58,
        checked: 10,
        salesChecked: 10,
        sold: 0,
        liquidityChecked: 10,
        pulled: 0,
      },
      {
        launchpad: 'pons',
        listed: 21,
        checked: 10,
        salesChecked: 10,
        sold: 3,
        liquidityChecked: 10,
        pulled: 0,
      },
    ]);
    const which =
      '0 of the 10 most recent of its 58 launches on Doppler launchpad 0x22e9… and 3 of the 10 most recent of its 21 launches on pons';
    const facts = toFacts(report);
    const sales = buildGlance({ facts })!.items.find((i) => i.id === 'sales');
    expect(sales?.title).toBe(
      `The creator sold into the pool on 4 of 21 launches checked. On its other launches: ${which}.`,
    );
    const history = CATALOG['creator-history'].run({ report, token: AI } as SpecialistContext);
    expect(history.signal).toBe('concern');
    expect(history.facts[0]).toContain(
      `sold into the pool on 3 of the 20 checked for sales: ${which}`,
    );
    const prompt = renderReport(report);
    expect(prompt).toContain(
      `Which other launches were checked (the most recent on each launchpad the creator used): sales, ${which}`,
    );
    // Each checked launch is listed, its launchpad named.
    expect(prompt).toContain(`- ${PONS_SOLD[0]}: pons, creator sale: yes`);
  });
});

// ---------------------------------------------------------------------------
// 2. RH: the round trips left out, said with the count

describe('the round trips left out are said (item 2)', () => {
  const launch = texts.rh.launch as unknown as LaunchReplayData;

  it('the launch story card gives the 25 and the 3 excluded', () => {
    const story = buildStory(launch);
    expect(story.roundTrips).toEqual({
      wallets: 25,
      excluded: { sameTransaction: 1, liquidity: 2 },
    });
  });

  it('RH’s served text gets the exclusions next to its count', () => {
    const report = makeReport(texts.rh.token, (r) => {
      r.launch = { completeness: 'full', sources: [], data: launch } as TokenReport['launch'];
    });
    const out = withoutClaims(texts.rh.text, report).text!;
    expect(out).toContain(
      '25 addresses bought and sold back within the first 10 minutes (3 more excluded: 1 bought and sold back within one single transaction, never holding the token; 2 put the tokens back into a pool as liquidity rather than selling), 20 of them from that +433 s purchase.',
    );
    // Said once: a second pass leaves it as it is.
    expect(withoutClaims(out, report).text).toBe(out);
  });
});

// ---------------------------------------------------------------------------
// 3. A limit is no reassurance, a contrast needs its other half, a share of
//    the supply is not one of a purchase

describe('three slips of the text (item 3)', () => {
  it('Wheel Smith: the holder read’s limit no longer opens "What is reassuring"', () => {
    const report = makeReport(texts.wheelSmith.token);
    const out = withoutClaims(texts.wheelSmith.text, report).text!;
    expect(out).not.toContain('The holder read covered only 3 pages, so it is partial.');
    expect(out.split('\n\n')[1]).toMatch(/^Sells are going through/);
  });

  it('ASTEROID: "Yet the early record points the other way." opens no section', () => {
    const report = makeReport(texts.asteroid.token);
    const out = withoutClaims(texts.asteroid.text, report).text!;
    expect(out).not.toMatch(/Yet the early record/);
    const diverge = out.split('\n\n');
    const i = diverge.findIndex((p) => p.startsWith('Where the signals diverge'));
    expect(diverge[i + 1]).toMatch(/^17 early buyers bought 17\.94% of supply/);
  });

  it('a "But" opening a section loses it and keeps the rest', () => {
    const report = makeReport(texts.asteroid.token);
    const out = withoutClaims(
      'What is reassuring\n\nSells go through.\n\nWhere the signals diverge\n\nBut holdings look spread over 2966 addresses.',
      report,
    ).text!;
    expect(out.split('\n\n')[3]).toBe('Holdings look spread over 2966 addresses.');
  });

  it('HYPURRT: 11.44% held today is of the supply, not of what they bought', () => {
    const report = makeReport(texts.hypurrt.token, (r) => {
      r.launch = {
        completeness: 'full',
        sources: [],
        data: { summary: { early: texts.hypurrt.early } },
      } as unknown as TokenReport['launch'];
    });
    const out = withoutClaims(texts.hypurrt.text, report).text!;
    expect(out).toContain('early buyers still hold 11.44% of the supply');
    expect(out).not.toContain('of what they bought');
    // The share of their purchases, when that is what is said, stands (11.44 / 73.80).
    expect(withoutClaims('Early buyers still hold 15.50% of what they bought.', report).text).toBe(
      'Early buyers still hold 15.50% of what they bought.',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Removals settled without reading every sender

const AGEM = '0x7c0495053f47ec52eb4b678c4ad8f572df745bfe';
const AGEM_CREATOR = '0xab48cf927b0f507c22ecd1025c33bb9a8bf70730';
const BONER_CREATOR = '0x79aeae6a47ff2e551f60bd87dbd6358efeaf4dc8';
const agemLogs = removalLogs.agem as RawLog[];
const aiBurns = removalLogs.ai as RawLog[];

/** As read on chain on 18/10/2026: what each creator ever held in the two managers. */
const NOTHING: PositionHoldings = {
  v4: { since: new Map(), operatorSince: null },
  v3: { since: new Map(), operatorSince: null },
};

describe('removals settled without every sender (item 4)', () => {
  it('AGEM: removals through the v4 PositionManager of positions its creator never held', () => {
    for (const log of agemLogs) {
      expect(log.topics[2]?.endsWith(V4_POSITION_MANAGER.slice(2))).toBe(true);
      expect(removalWithoutSender(log, AGEM_CREATOR, { positions: NOTHING })).toBe('not-creator');
      // Without the holdings, the sender has to be read.
      expect(removalWithoutSender(log, AGEM_CREATOR, {})).toBeNull();
    }
  });

  it('BONER: its creator’s own position 812111 is read for its sender, from the block it got it', () => {
    const positions: PositionHoldings = {
      ...NOTHING,
      v4: { since: new Map([['812111', 42_399_512]]), operatorSince: null },
    };
    const own = (block: number): RawLog => ({
      ...agemLogs[0]!,
      blockNumber: `0x${block.toString(16)}`,
      data: `${agemLogs[0]!.data.slice(0, 2 + 192)}${(812111).toString(16).padStart(64, '0')}`,
    });
    expect(removalWithoutSender(own(42_399_511), BONER_CREATOR, { positions })).toBe('not-creator');
    expect(removalWithoutSender(own(42_399_600), BONER_CREATOR, { positions })).toBeNull();
    // An operator of every position, from then on, settles nothing.
    const operator = { ...positions, v4: { since: new Map(), operatorSince: 42_000_000 } };
    expect(removalWithoutSender(own(41_999_999), BONER_CREATOR, { positions: operator })).toBe(
      'not-creator',
    );
    expect(removalWithoutSender(agemLogs[0]!, BONER_CREATOR, { positions: operator })).toBeNull();
  });

  it('AI: v3 burns before its creator got its full-range position (block 34,550,729) are not its', () => {
    const positions: PositionHoldings = {
      ...NOTHING,
      v3: { since: new Map([['-887200:887200', 34_550_729]]), operatorSince: null },
    };
    for (const log of aiBurns) {
      expect(log.topics[1]?.endsWith(V3_POSITION_MANAGER.slice(2))).toBe(true);
      expect(removalWithoutSender(log, AI_CREATOR, { positions })).toBe('not-creator');
    }
    const later = { ...aiBurns[2]!, blockNumber: `0x${(34_600_000).toString(16)}` };
    expect(removalWithoutSender(later, AI_CREATOR, { positions })).toBeNull();
  });

  it('only the removals left unsettled are asked for their sender, and the answer is known', async () => {
    const asked: string[] = [];
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: RpcRequest[]) {
        return requests.map((r) => {
          asked.push(String(r.params[0]));
          return { ok: true, value: { from: '0x22aa9de967d2c256ffbd43653333beafc7c0e22e' } };
        });
      },
    } as unknown as RpcClient;
    // 1,916 removal transactions on AGEM's markets: here 400 copies of the real ones, plus one
    // through another contract, whose sender is read.
    const many = Array.from({ length: 400 }, (_, i) => ({
      token: AGEM,
      log: {
        ...agemLogs[i % agemLogs.length]!,
        transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
      },
    }));
    const other = {
      token: AGEM,
      log: {
        ...agemLogs[0]!,
        topics: [
          MODIFY_LIQUIDITY_TOPIC,
          agemLogs[0]!.topics[1]!,
          `0x${'419e4d8ef9a35bd97ca53dcbf4abafc5526f2ac0'.padStart(64, '0')}`,
        ],
        transactionHash: `0x${'f'.repeat(64)}`,
      },
    };
    const { pulled } = await creatorRemovals(
      rpc,
      AGEM_CREATOR,
      new Set([AGEM]),
      [...many, other],
      [],
      AGEM,
      () => 0,
      Number.POSITIVE_INFINITY,
      { positions: NOTHING },
    );
    expect(pulled.get(AGEM)).toBe(false);
    // Only the one through another contract: the detailed ones name their
    // sender in their receipts.
    expect(asked).toEqual([`0x${'f'.repeat(64)}`]);
  });

  it('the creator’s whole transaction list settles every removal at once', () => {
    const sent = {
      hashes: new Set([agemLogs[1]!.transactionHash]),
      fromBlock: 0,
      toBlock: 91_789_894,
    };
    expect(removalWithoutSender(agemLogs[1]!, AGEM_CREATOR, { sent })).toBe('creator');
    expect(removalWithoutSender(agemLogs[0]!, AGEM_CREATOR, { sent })).toBe('not-creator');
  });

  it('a market too busy to read: the creator’s own transactions are read instead', async () => {
    const market = agemLogs[0]!.topics[1]!;
    const receipt = (logs: RawLog[]) => ({ ok: true, value: { logs } });
    const rpc = (answers: unknown[]) =>
      ({
        async call() {
          throw new Error('not used');
        },
        async callBatch(requests: RpcRequest[]) {
          return requests.map((_, i) => answers[i]);
        },
      }) as unknown as RpcClient;
    const removal = { ...agemLogs[0]!, address: POOL_MANAGER };
    const swap = { ...agemLogs[0]!, address: POOL_MANAGER, topics: ['0x1234', market] };
    const venues = { pools: [], v4Markets: [market] };
    expect(
      await removalsInTransactions(rpc([receipt([swap]), receipt([])]), ['0xa', '0xb'], venues),
    ).toEqual({ removed: false, collected: false, transactions: 2 });
    expect(await removalsInTransactions(rpc([receipt([removal])]), ['0xa'], venues)).toEqual({
      removed: true,
      collected: false,
      transactions: 1,
    });
    // A receipt not read proves nothing.
    expect(
      await removalsInTransactions(rpc([{ ok: false, error: 'busy' }]), ['0xa'], venues),
    ).toBeNull();
  });

  it('a history with the creator’s whole list: AGEM complete, its liquidity settled', async () => {
    const origin: TokenOrigin = {
      token: AGEM,
      creator: AGEM_CREATOR,
      role: 'launcher',
      blockNumber: 89_107_964,
      transactionHash: '0xb914266db426f8c4d9691a6ba2e8e81fcb91cee1b3ae065b539c6f43148553cd',
      venues: {
        pools: [],
        v4Markets: [agemLogs[0]!.topics[1]!],
        hooks: [],
        saleRecipients: [POOL_MANAGER],
      },
    };
    const lookups: string[] = [];
    const rpc = {
      async call() {
        return '0x';
      },
      async callBatch(batch: RpcRequest[]) {
        return batch.map((r) => {
          if (r.method === 'eth_getLogs') {
            const f = r.params[0] as { topics?: string[] };
            return { ok: true, value: f.topics?.[0] === MODIFY_LIQUIDITY_TOPIC ? agemLogs : [] };
          }
          if (r.method === 'eth_getTransactionByHash') lookups.push(String(r.params[0]));
          if (r.method === 'eth_getCode') return { ok: true, value: '0x' };
          if (r.method === 'eth_getTransactionCount') return { ok: true, value: '0xb' };
          if (r.method === 'eth_getBlockByNumber')
            return { ok: true, value: { timestamp: '0x6a000000' } };
          if (r.method === 'eth_getTransactionReceipt')
            return {
              ok: true,
              value: { from: '0x22aa9de967d2c256ffbd43653333beafc7c0e22e', logs: [] },
            };
          if (r.method === 'eth_call') return { ok: true, value: `0x${(10n ** 27n).toString(16)}` };
          return { ok: true, value: null };
        });
      },
    } as unknown as RpcClient;
    // Its 11 transactions, as many as its nonce: the list is whole.
    const list = Array.from({ length: 11 }, (_, i) => ({
      hash: `0x${(i + 7).toString(16).padStart(64, 'c')}`,
      block: 89_107_964 + i,
      call: true,
    }));
    const history = await fetchDeployerHistory(rpc, origin, {
      latestBlock: 91_789_894,
      maxListingQueries: 0,
      creatorSent: async () => list,
      now: () => new Date('2026-10-18T12:35Z'),
    });
    expect(history.data.tokens.find((t) => t.address === AGEM)?.liquidityPulled).toBe(false);
    expect(lookups).toHaveLength(0);
    expect(history.sources.map((s) => s.note).join(' ')).not.toMatch(/could not be read/);
    // One short of the nonce: Blockscout lags, the list proves nothing; the
    // positions the creator never held settle it, still without a lookup.
    const short = await fetchDeployerHistory(rpc, origin, {
      latestBlock: 91_789_894,
      maxListingQueries: 0,
      creatorSent: async () => list.slice(1),
      now: () => new Date('2026-10-18T12:35Z'),
    });
    expect(lookups).toHaveLength(0);
    expect(short.data.tokens.find((t) => t.address === AGEM)?.liquidityPulled).toBe(false);
  });
});
