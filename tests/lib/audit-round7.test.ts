import { describe, expect, it } from 'vitest';
import { withoutClaims } from '../../src/lib/agent/claims';
import { renderLaunch, renderReport } from '../../src/lib/agent/prompt';
import { detailRemovals, returnedFrom } from '../../src/lib/chain/deployer';
import { draftMoves, roundTripsOf, summarize, tallyLaunch } from '../../src/lib/chain/launch';
import { launchInfrastructure } from '../../src/lib/chain/launchpads';
import type { RawLog } from '../../src/lib/chain/logs';
import { POOL_MANAGER } from '../../src/lib/chain/pools';
import type { RpcClient } from '../../src/lib/chain/rpc';
import type { LaunchReplay, LaunchedToken } from '../../src/lib/contracts';
import { toFacts } from '../../src/lib/facts';
import { makeReport } from '../specialists/helpers';
import elon from './fixtures/audit7/launch-elon.json';
import rh from './fixtures/audit7/launch-rh.json';
import topblast from './fixtures/audit7/launch-topblast.json';
import moonRemoval from './fixtures/audit7/moon-removal.json';

/**
 * The seventh audit of staging (18/10/2026), from data read on chain then:
 * the transfers of the first ten minutes of RH, TOPBLAST (c3d6e-b) and ELON,
 * and the receipt of MOON's liquidity removal 0xf58e531e….
 */

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;

type LaunchFixture = {
  token: string;
  name: string;
  creator: string;
  launchBlock: number;
  pools: string[];
  seconds: Record<string, number>;
  transfers: (string | number)[][];
};

/** The window's moves, timed as the replay times them, over every transfer read. */
function replayOf(f: LaunchFixture) {
  const logs: RawLog[] = f.transfers.map(([block, tx, from, to, value], i) => ({
    address: f.token,
    topics: [TRANSFER, pad(String(from)), pad(String(to))],
    data: `0x${String(value).padStart(64, '0')}`,
    blockNumber: `0x${Number(block).toString(16)}`,
    transactionHash: String(tx),
    logIndex: `0x${i.toString(16)}`,
  }));
  const markets = new Set(f.pools);
  const pools = new Set([...markets, ...launchInfrastructure().keys()]);
  const moves = draftMoves(logs, pools, markets).map((m) => ({
    ...m,
    seconds: f.seconds[String(m.block)] ?? 0,
  }));
  const tally = tallyLaunch(moves, {
    creator: f.creator,
    from: f.launchBlock,
    pools,
    supply: 10n ** 27n,
  });
  const summary = summarize(tally, new Map(), {
    receiptsRead: 0,
    receiptsWanted: 0,
    balancesRead: 0,
    balancesWanted: 0,
    moves: moves.length,
  });
  const replay: LaunchReplay = {
    completeness: 'partial',
    sources: [{ name: 'robinhood-rpc', fetchedAt: '' }],
    data: {
      token: f.token,
      launchBlock: f.launchBlock,
      launchedAt: null,
      windowSeconds: 600,
      supply: (10n ** 27n).toString(),
      // The drawing keeps 40; none is needed for the counts.
      moves: [],
      movesInWindow: moves.length,
      summary,
    },
  };
  return { moves, pools, summary, replay };
}

describe('round trips, counted over the whole window (item 4)', () => {
  it('TOPBLAST: seven wallets bought at +15 s and sold back at +225 s, not five', () => {
    const { summary, replay } = replayOf(topblast as LaunchFixture);
    const trips = summary.roundTrips!;
    expect(trips.listed.filter((t) => t.boughtAt === 15 && t.soldAt === 225)).toHaveLength(7);
    expect(trips.wallets).toBe(26);
    const text = renderLaunch(replay).join('\n');
    expect(text).toMatch(/Round trips over every move of the window: 26 addresses/);
    expect(text).toMatch(/Of them, 7 bought at \+15 s and sold back between \+225 s and \+225 s/);
    // The list is a selection, and says so.
    expect(text).toMatch(/18 more round trips in the window, not listed/);
  });

  it('ELON: seven wallets bought and sold back about 41 s later, not five', () => {
    const { summary, replay } = replayOf(elon as LaunchFixture);
    const trips = summary.roundTrips!;
    expect(trips.wallets).toBe(7);
    expect(trips.delays).toEqual({ min: 41, max: 42 });
    expect(renderLaunch(replay).join('\n')).toMatch(
      /Round trips over every move of the window: 7 addresses/,
    );
  });

  it('RH: 27 addresses sold back in the window, 20 of them bought at +433 s, not three', () => {
    const { summary, replay } = replayOf(rh as LaunchFixture);
    const trips = summary.roundTrips!;
    expect(trips.wallets).toBe(27);
    expect(trips.listed.filter((t) => t.boughtAt === 433)).toHaveLength(20);
    expect(trips.delays?.min).toBe(0);
    // The single transaction at +433 s delivered to 100 addresses: 20 of them sold back.
    expect(summary.bundle?.wallets).toBe(100);
    expect(trips.fromBundle).toBe(20);
    const text = renderLaunch(replay).join('\n');
    expect(text).toMatch(/Round trips over every move of the window: 27 addresses/);
    expect(text).toMatch(/Of them, 20 bought at \+433 s and sold back between \+472 s and \+597 s/);
    expect(text).toMatch(/Of the 100 addresses the single transaction at \+433 s delivered to, 20/);
  });

  it('counts a trip once per address, a sale before the first buy not being one', () => {
    const at = (kind: 'buy' | 'sell', actor: string, seconds: number) => ({
      kind,
      actor,
      counterparty: '0xpool',
      value: 1n,
      block: seconds,
      transaction: `0x${seconds}`,
      seconds,
    });
    const trips = roundTripsOf(
      [at('sell', '0xa', 1), at('buy', '0xa', 5), at('sell', '0xa', 9), at('sell', '0xa', 12)],
      new Set(['0xpool']),
      null,
    );
    expect(trips).toEqual([{ address: '0xa', boughtAt: 5, soldAt: 9 }]);
  });
});

const MOON = '0xa472318678664cc67ffdf111fe48beb36e69f95f';
const MOON_CREATOR = '0x2a7f2f0faea66171dac0e8c1ec7a1a37424464ec';
const MOON_TX = '0xf58e531e78408a409528e27a7a44f441fc0b1f3a925b1e359998d853d5ac1cc6';

/** A node answering MOON's removal: the receipt, the supply, the creator's balance today. */
function moonNode(): RpcClient {
  return {
    async call() {
      throw new Error('not used');
    },
    async callBatch(requests: { method: string; params: unknown[] }[]) {
      return requests.map((r) => {
        if (r.method === 'eth_getTransactionReceipt') {
          return { ok: true, value: { logs: moonRemoval.logs } };
        }
        const data = (r.params[0] as { data: string }).data;
        if (data === '0x18160ddd') return { ok: true, value: moonRemoval.supply };
        return { ok: true, value: moonRemoval.creatorBalance };
      });
    },
  } as unknown as RpcClient;
}

describe('who removed the liquidity, and to whom it went (item 2, MOON)', () => {
  it('reads the market returning 48.07 % of the supply to the creator, from the receipt', () => {
    const got = returnedFrom(moonRemoval.logs, MOON, new Set([POOL_MANAGER.toLowerCase()]));
    expect([...got.keys()]).toEqual([MOON_CREATOR]);
  });

  it('names the creator as the sender, with the share returned and held today', async () => {
    const { removals, failed } = await detailRemovals(
      moonNode(),
      MOON,
      MOON_CREATOR,
      [{ log: { ...moonRemoval.logs[1]!, blockNumber: moonRemoval.blockNumber } }],
      new Map([[MOON_TX, MOON_CREATOR]]),
      new Set([POOL_MANAGER.toLowerCase()]),
    );
    expect(failed).toBe(false);
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({
      transaction: MOON_TX,
      sender: MOON_CREATOR,
      by: 'creator',
    });
    expect(removals[0]!.returned[0]).toMatchObject({ address: MOON_CREATOR, isCreator: true });
    expect(removals[0]!.returned[0]!.share).toBeCloseTo(0.4807, 4);
    expect(removals[0]!.returned[0]!.heldNow).toBeCloseTo(0.4807, 3);
  });

  it('a removal whose sender was not read is a failed read, never "nobody"', async () => {
    const { removals, failed } = await detailRemovals(
      moonNode(),
      MOON,
      MOON_CREATOR,
      [{ log: { ...moonRemoval.logs[1]!, blockNumber: moonRemoval.blockNumber } }],
      new Map([[MOON_TX, null]]),
      new Set([POOL_MANAGER.toLowerCase()]),
    );
    expect(removals).toHaveLength(0);
    expect(failed).toBe(true);
  });

  const moonReport = () =>
    makeReport(MOON, (r) => {
      r.creator.data.creator = MOON_CREATOR;
      const own: LaunchedToken = {
        address: MOON,
        pool: POOL_MANAGER,
        launchedAtBlock: 91_196_644,
        launchedAt: null,
        outcome: 'undetermined',
        graduationProgress: 0,
        liquidityPulled: true,
        creatorDumped: false,
        liquidityRemovals: [
          {
            transaction: MOON_TX,
            block: 91_212_119,
            sender: MOON_CREATOR,
            by: 'creator',
            returned: [
              { address: MOON_CREATOR, share: 0.480742, isCreator: true, heldNow: 0.480741 },
            ],
          },
        ],
      };
      r.creator.data.tokens = [own];
    });

  it('the facts state who sent the removal and to whom the share went', () => {
    const facts = toFacts(moonReport());
    expect(facts.creator.ownRemovals).toEqual([
      {
        transaction: MOON_TX,
        by: 'creator',
        sender: MOON_CREATOR,
        returned: [{ address: MOON_CREATOR, share: 0.480742, to: 'creator', heldNow: 0.480741 }],
      },
    ]);
  });

  it('a removal sent by the creator’s first funder is said so', () => {
    const funder = '0x00000000000000000000000000000000000000f1';
    const report = moonReport();
    report.creator.data.tokens[0]!.liquidityRemovals![0]!.sender = funder;
    expect(toFacts(report, { funder }).creator.ownRemovals?.[0]?.by).toBe('funder');
  });

  it('the prompt gives the remover and the share returned', () => {
    const text = renderReport(moonReport());
    expect(text).toMatch(
      /Liquidity removal on this token \(transaction 0xf58e531e[0-9a-f]+\): sent by the creator\./,
    );
    expect(text).toMatch(
      /returned 48\.07% of the supply to the creator, which holds 48\.07% of the supply today/,
    );
  });

  it('the claims check cuts "who removed it is not stated" when the remover is known', () => {
    const served =
      'Where the signals diverge\n\nThe creator never sold the token, but it did provide the whole supply as liquidity, and liquidity was later removed. Who removed it is not stated here. Holder reads are partial.';
    const out = withoutClaims(served, moonReport());
    expect(out.dropped.map((c) => c.kind)).toContain('remover-unknown');
    expect(out.text).not.toMatch(/not stated/);
    expect(out.text).toMatch(/Holder reads are partial/);
  });

  it('keeps that sentence when the data does not name the remover', () => {
    const report = moonReport();
    delete report.creator.data.tokens[0]!.liquidityRemovals;
    const out = withoutClaims('Liquidity was removed. Who removed it is not stated here.', report);
    expect(out.dropped).toHaveLength(0);
  });
});

describe('a read inside a module that fails says so (item 1)', () => {
  const failingNode = (fail: (method: string) => boolean): RpcClient =>
    ({
      async call() {
        throw new Error('not used');
      },
      async callBatch(requests: { method: string }[]) {
        if (requests.some((r) => fail(r.method))) throw new Error('node down');
        return requests.map(() => ({ ok: false, error: 'busy' }));
      },
    }) as unknown as RpcClient;

  it('a pool balance not read throws, never "the pools hold nothing"', async () => {
    const { readPoolsShare } = await import('../../src/lib/holders/chain');
    await expect(
      readPoolsShare(
        failingNode(() => false),
        MOON,
        [POOL_MANAGER],
      ),
    ).rejects.toThrow(/pool balances not read/);
  });

  it('the holders’ codes not read throw, never "no wallet among them"', async () => {
    const { recheckContracts } = await import('../../src/lib/holders/chain');
    const data = {
      token: MOON,
      countedSupply: '1',
      holderCount: 1,
      top: [{ address: MOON_CREATOR, share: 1, kind: 'contract' as const, balance: '1' }],
      concentration: { top1: 1, top10: 1 },
      distinctTraders: null,
    };
    await expect(
      recheckContracts(
        failingNode(() => true),
        data,
      ),
    ).rejects.toThrow(/node down/);
    // Codes answered with errors: what was read is applied, and the gap is told.
    const told: unknown[] = [];
    await recheckContracts(
      failingNode(() => false),
      data,
      undefined,
      (e) => told.push(e),
    );
    expect(told).toHaveLength(1);
  });

  it('the creator’s recipients’ codes not read fail the links read', async () => {
    const { linkCreatorToHolders } = await import('../../src/lib/holders/links');
    await expect(
      linkCreatorToHolders(
        failingNode(() => false),
        {
          token: MOON,
          sends: {
            recipients: [{ address: MOON_CREATOR, value: '500' }],
            distinct: 1,
            burned: '0',
          },
          holders: {
            token: MOON,
            countedSupply: '1',
            holderCount: 1,
            top: [],
            concentration: { top1: 0, top10: 0 },
            distinctTraders: null,
          },
          supply: 1000n,
          setAside: new Set(),
          fromBlock: 0,
          toBlock: 1,
        },
      ),
    ).rejects.toThrow(/could not be read/);
  });
});
