import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findClaims, withoutClaims } from '../../src/lib/agent/claims';
import { renderReport, SYSTEM_PROMPT } from '../../src/lib/agent/prompt';
import { draftMoves, readLaunchReplay, tallyLaunch } from '../../src/lib/chain/launch';
import { fetchDeployerHistory, findVenues } from '../../src/lib/chain/deployer';
import { launchInfrastructure } from '../../src/lib/chain/launchpads';
import type { RawLog } from '../../src/lib/chain/logs';
import type { RpcClient } from '../../src/lib/chain/rpc';
import { findRoutedSales, isRoutedSale, natureOf } from '../../src/lib/chain/trades';
import { resetFunderProfiles } from '../../src/lib/chain/funding';
import type { CreatorSends, HolderDistributionData, TokenReport } from '../../src/lib/contracts';
import { toFacts, type ReportFacts } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';
import { computeDistribution, type BlockscoutHolder } from '../../src/lib/holders';
import { linkCreatorToHolders, withLinks } from '../../src/lib/holders/links';
import { CATALOG } from '../../src/lib/specialists/catalog';
import { gatherFunding } from '../../src/lib/specialists/context';
import type { SpecialistContext } from '../../src/lib/specialists/types';
import { makeReport } from '../specialists/helpers';

/**
 * Regressions from the third audit of displayed facts (staging, 30 live
 * tokens, 18/10/2026). Each fixture uses the addresses and values read on
 * chain for that token.
 */

const E27 = 10n ** 27n;
const of = (share: number, supply = E27) =>
  (supply * BigInt(Math.round(share * 1_000_000))) / 1_000_000n;
const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const MODIFY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
const INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';

const transfer = (
  token: string,
  from: string,
  to: string,
  value: bigint,
  tx: string,
  block = 1,
  logIndex = 0,
): RawLog => ({
  address: token,
  topics: [TRANSFER, pad(from), pad(to)],
  data: `0x${word(value)}`,
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: tx,
  logIndex: `0x${logIndex.toString(16)}`,
});

const holder = (hash: string, value: bigint, isContract = false): BlockscoutHolder => ({
  address: { hash, is_contract: isContract },
  value: value.toString(),
});

// ---------------------------------------------------------------------------
// 1. A funder delegating under EIP-7702 is a wallet, in the app and the indexer

describe('funders delegating under EIP-7702 (item 1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetFunderProfiles();
  });

  it('the indexer keeps the same 7702 helper as the app', () => {
    const app = readFileSync(new URL('../../src/lib/chain/code.ts', import.meta.url), 'utf8');
    const indexed = readFileSync(new URL('../../indexer/src/code.ts', import.meta.url), 'utf8');
    expect(indexed).toBe(app);
  });

  // GNRG (0x6587…e250): first funded by 0x526c…4729, which Blockscout flags as
  // a contract (139 transactions); its code is a 7702 delegation, nonce 138.
  const GNRG_CREATOR = '0x00000000000000000000000000000000000000c9';
  const GNRG_FUNDER = '0x526cd5f2446732ed30aa78ea7e4eb38fdd2c4729';
  const DELEGATION = '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b';

  it('GNRG: an indexer row stored as a contract is read again when its code is a delegation', async () => {
    vi.stubEnv('INDEXER_URL', 'http://indexer.test');
    vi.stubEnv('INDEXER_TOKEN', 'x'.repeat(32));
    vi.stubEnv('BLOCKSCOUT_API_KEY', 'test-key');
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/creator/${GNRG_CREATOR}`) {
        return Response.json({
          creator: GNRG_CREATOR,
          indexedTo: 1,
          launchCount: 1,
          truncated: false,
          launches: [],
          fundingState: 'found',
          funding: {
            funder: GNRG_FUNDER,
            txHash: '0x1',
            block: 1,
            kind: 'tx',
            funderKind: 'service',
            funderName: null,
            funderTxCount: 139,
            effective: GNRG_FUNDER,
            effectiveKind: 'service',
            otherCreatorsFunded: [],
          },
        });
      }
      if (url.pathname.endsWith(`/addresses/${GNRG_FUNDER}/counters`)) {
        return Response.json({ transactions_count: '139' });
      }
      if (url.pathname.endsWith(`/addresses/${GNRG_FUNDER}`)) {
        return Response.json({ is_contract: true, name: null, metadata: null });
      }
      if (url.pathname === `/v1/funder/${GNRG_FUNDER}`) {
        return Response.json({ funder: GNRG_FUNDER, indexedTo: 1, profile: null, creators: [] });
      }
      if (url.pathname === `/v1/network/${GNRG_CREATOR}`) {
        return Response.json({ creator: GNRG_CREATOR, indexedTo: 1, network: null });
      }
      throw new Error(`no call expected to ${url.pathname}`);
    });
    const rpc = {
      call: async (method: string, params: unknown[]) =>
        method === 'eth_getCode' && params[0] === GNRG_FUNDER ? DELEGATION : null,
    } as unknown as Parameters<typeof gatherFunding>[0];
    const funding = await gatherFunding(
      rpc,
      '0x6587e8bdf0f6a55e13c013e158bb66a949bbe250',
      GNRG_CREATOR,
    );
    expect(funding).toMatchObject({ funderKind: 'wallet', funderTxCount: 139 });
    const answer = CATALOG['funding-trace'].run({
      token: '0x6587e8bdf0f6a55e13c013e158bb66a949bbe250',
      funding,
    } as SpecialistContext);
    expect(answer.facts.join(' ')).not.toMatch(/a contract, or an address tagged as an exchange/);
  });

  it('AI: without a Blockscout key, the indexer’s count decides once the code says wallet', async () => {
    vi.stubEnv('INDEXER_URL', 'http://indexer.test');
    vi.stubEnv('INDEXER_TOKEN', 'x'.repeat(32));
    vi.stubEnv('BLOCKSCOUT_API_KEY', '');
    const creator = '0x00000000000000000000000000000000000000ca';
    const funder = '0xc02b561f033292c4f10f1e3a9c271480fa0156c5';
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/creator/${creator}`) {
        return Response.json({
          creator,
          indexedTo: 1,
          launchCount: 1,
          truncated: false,
          launches: [],
          fundingState: 'found',
          funding: {
            funder,
            txHash: '0x2',
            block: 1,
            kind: 'tx',
            funderKind: 'service',
            funderName: null,
            funderTxCount: 433,
            effective: funder,
            effectiveKind: 'service',
            otherCreatorsFunded: [],
          },
        });
      }
      if (url.pathname === `/v1/network/${creator}`) {
        return Response.json({ creator, indexedTo: 1, network: null });
      }
      throw new Error(`no call expected to ${url.pathname}`);
    });
    // Its code, read on chain: a delegation, nonce 416.
    const rpc = {
      call: async (method: string) =>
        method === 'eth_getCode' ? '0xef0100612373d7003d694220f7800eeaf8e3924c0951d3' : null,
    } as unknown as Parameters<typeof gatherFunding>[0];
    const funding = await gatherFunding(rpc, '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', creator);
    expect(funding?.funderKind).toBe('wallet');
  });

  it('a real contract stays a service', async () => {
    vi.stubEnv('INDEXER_URL', 'http://indexer.test');
    vi.stubEnv('INDEXER_TOKEN', 'x'.repeat(32));
    vi.stubEnv('BLOCKSCOUT_API_KEY', '');
    const creator = '0x00000000000000000000000000000000000000cb';
    const router = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/creator/${creator}`) {
        return Response.json({
          creator,
          indexedTo: 1,
          launchCount: 1,
          truncated: false,
          launches: [],
          fundingState: 'found',
          funding: {
            funder: router,
            txHash: '0x3',
            block: 1,
            kind: 'tx',
            funderKind: 'service',
            funderName: 'RelayRouterV3',
            funderTxCount: 12_000,
            effective: router,
            effectiveKind: 'service',
            otherCreatorsFunded: [],
          },
        });
      }
      throw new Error(`no call expected to ${url.pathname}`);
    });
    const rpc = {
      call: async () => '0x6080604052',
    } as unknown as Parameters<typeof gatherFunding>[0];
    expect((await gatherFunding(rpc, '0x01', creator))?.funderKind).toBe('service');
  });
});

// ---------------------------------------------------------------------------
// 6, 7. Claims the facts contradict are not served

/** A report with the creator's own token, patched case by case. */
function reportFor(
  token: string,
  own: Partial<TokenReport['creator']['data']['tokens'][number]>,
  patch: (r: TokenReport) => void = () => {},
): TokenReport {
  return makeReport(token, (r) => {
    r.creator.data.tokens = [
      {
        address: token,
        pool: '0x',
        launchedAtBlock: 1,
        launchedAt: null,
        outcome: 'active',
        graduationProgress: 0,
        liquidityPulled: false,
        creatorDumped: false,
        ...own,
      },
    ];
    patch(r);
  });
}

const MIKE = '0xf4a530f2c6f9935170eebcfa50b8718dd11e144c';
const DELTA = '0xe8ffd7e24187f72afb08d75b1bb13088a989a791';

describe('the model may not call a record clean, nor a creator new (items 6, 7)', () => {
  // The text served for Mike (ponsLast), word for word.
  const MIKE_TEXT = [
    'What is reassuring',
    "No liquidity removal was observed in the first 11 days, and the creator's wallet is established, with 1088 transactions and no earlier launches that were abandoned. The creator history is fully read, but it covers only this one token.",
    'What deserves attention',
    'Almost nothing circulates: 99.75% of supply sits in the pool and launch contracts, and the 0.25% outside is mostly in one contract. The creator bought 71.88% in the launch block, and its recorded sales cover this token’s whole life.',
    'Where the signals diverge',
    'The creator\'s own record looks clean, but the funding trail shows a wider group of launches whose outcomes are not shown here. "No liquidity removed" sounds comforting, but with no trades and almost no float there was little to remove or test.',
  ].join('\n\n');

  it('Mike: with a creator sale measured, "looks clean" and "only this one token" are cut', () => {
    const report = reportFor(MIKE, { creatorDumped: true });
    const claims = findClaims(MIKE_TEXT, report).map((c) => c.kind);
    expect(claims).toEqual(expect.arrayContaining(['only-token', 'clean-record']));
    const { text, dropped } = withoutClaims(MIKE_TEXT, report);
    expect(dropped).toHaveLength(2);
    expect(text).not.toMatch(/clean|only this one token/);
    // The rest of each section is served.
    expect(text).toContain('with 1088 transactions');
    expect(text).toContain('"No liquidity removed" sounds comforting');
  });

  it('DELTA: "launched only this one token" is never served, the launchpads read being some only', () => {
    const report = reportFor(DELTA, {});
    const text =
      'What is reassuring\n\nThe creator has launched only this one token. Liquidity was not removed.\n\nWhat deserves attention\n\nOne contract holds 10.7%.\n\nWhere the signals diverge\n\nLittle else.';
    expect(findClaims(text, report).map((c) => c.kind)).toEqual(['only-token']);
    expect(withoutClaims(text, report).text).not.toContain('only this one token');
    // The wording the prompt asks for passes.
    expect(
      findClaims('No other launch was found on the launchpads SEAL can list.', report),
    ).toEqual([]);
    expect(findClaims('This is the creator’s first token.', report)).toHaveLength(1);
  });

  // Sixth audit: a section left with nothing to say is left out, not the whole text.
  it('a section left with nothing to say is left out, and no text when none is left', () => {
    const report = reportFor(MIKE, { creatorDumped: true });
    const text =
      'What is reassuring\n\nThe creator’s record looks clean.\n\nWhat deserves attention\n\nA.\n\nWhere the signals diverge\n\nB.';
    expect(withoutClaims(text, report).text).toBe(
      'What deserves attention\n\nA.\n\nWhere the signals diverge\n\nB.',
    );
    expect(
      withoutClaims('What is reassuring\n\nThe creator’s record looks clean.', report).text,
    ).toBeNull();
  });

  it('"clean" is not cut when no sale is measured', () => {
    const report = reportFor(MIKE, { creatorDumped: false });
    expect(findClaims('The creator’s record looks clean.', report)).toEqual([]);
  });

  it('the prompt carries the measured sale and the transaction count of a pons creator', () => {
    const report = reportFor(MIKE, { creatorDumped: true }, (r) => {
      r.creator.data.origin = {
        source: 'pons',
        role: 'launcher',
        launchpad: { id: 'pons', name: 'pons', address: '0xa24d' },
        creatorFrom: 'launch-record',
        launchesListed: true,
        launchpadsRead: ['pons'],
        launchpadsNotRead: ['Doppler', 'contracts deployed directly'],
        transactionCount: 1088,
      };
    });
    const prompt = renderReport(report);
    expect(prompt).toContain('Transactions sent by this wallet: 1088.');
    expect(prompt).toContain('the creator sold this token into its market');
    expect(prompt).toMatch(/Never write that the creator launched only this token/);
    expect(SYSTEM_PROMPT).toMatch(/never call its record or behavior clean/);
    expect(SYSTEM_PROMPT).toMatch(/no other launch found on the launchpads SEAL can list/);
    expect(toFacts(report).creator.transactionCount).toBe(1088);
  });
});

// ---------------------------------------------------------------------------
// 9. The current token is not one of the creator's "other" tokens

describe('ASTEROID: the other launches are counted without this one (item 9)', () => {
  const ASTEROID = '0xfd82d8db539b6ace0d50815845133767e24f1e18';
  // 11 launches, 10 checked (this one included); this one and 7 others sold.
  const sold = [null, true, true, true, true, true, true, true, true, false, false];
  const addresses = [
    '0x52f8cb',
    '0x57c488',
    '0x6e47d9',
    '0x0ecaad',
    '0x133df3',
    '0x5c2e7b',
    '0xa91dab',
    '0x9c227a',
    ASTEROID,
    '0x06f4a8',
    '0x3c8352',
  ];
  const report = makeReport(ASTEROID, (r) => {
    r.creator.data.tokens = addresses.map((address, i) => ({
      address,
      pool: '0x',
      launchedAtBlock: i,
      launchedAt: null,
      outcome: 'undetermined',
      graduationProgress: 0,
      liquidityPulled: null,
      creatorDumped: sold[i] ?? null,
    }));
    r.creator.data.counts.launched = 11;
  });

  it('says 7 of the 9 others checked, where it said "checked on the 10 most recent"', () => {
    const answer = CATALOG['creator-history'].run({ token: ASTEROID, report } as SpecialistContext);
    expect(answer.facts[0]).toBe(
      'The creator launched 10 other token(s): 0 graduated; the creator sold into the pool on 7 of the 9 checked for sales: 7 of the 9 most recent of its 10 launches on pons; liquidity removals could not be checked on them (each in the first 11 days after its launch; this token not counted).',
    );
  });

  it('the glance counts this one among the 10 checked, and says so', () => {
    const facts = toFacts(report);
    expect(facts.creator).toMatchObject({ salesChecked: 10, soldIntoPool: 8 });
    const timeline = addresses.map((address, i) => ({
      address,
      launchedAt: null,
      block: i,
      outcome: 'undetermined' as const,
      progress: 0,
      sold: sold[i] ?? null,
      pulled: null,
      current: address === ASTEROID,
    }));
    const sales = buildGlance({ facts, timeline })!.items.find((i) => i.id === 'sales');
    expect(sales?.title).toBe(
      'The creator sold into the pool on 8 of 10 launches checked, this token included. On its other launches: 7 of the 9 most recent of its 10 launches on pons.',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Which of today's holders received from the creator

function distribution(
  token: string,
  top: { address: string; share: number; kind: 'wallet' | 'contract' }[],
  holderCount: number,
): HolderDistributionData {
  return {
    token,
    countedSupply: '0',
    holderCount,
    top: top.map((h) => ({ ...h, balance: '0' })),
    concentration: { top1: top[0]?.share ?? 0, top10: top.reduce((n, h) => n + h.share, 0) },
    distinctTraders: null,
  };
}

/** An RPC that answers codes and the distributors' outgoing transfers. */
function linksRpc(
  codes: Record<string, string>,
  logs: (address: string, fromTopic: string) => RawLog[] = () => [],
): RpcClient {
  return {
    async call() {
      throw new Error('not used');
    },
    async callBatch(batch: { method: string; params: unknown[] }[]) {
      return batch.map((r) => {
        if (r.method === 'eth_getCode') {
          return { ok: true, value: codes[String(r.params[0])] ?? '0x' };
        }
        if (r.method === 'eth_getLogs') {
          const p = r.params[0] as { address: string; topics: string[] };
          return { ok: true, value: logs(p.address, p.topics[1] ?? '') };
        }
        return { ok: true, value: null };
      });
    },
  } as unknown as RpcClient;
}

describe('creator-to-holder links (item 4)', () => {
  it('DELTA: the largest holder received its 10 % directly from the creator', async () => {
    // DELTA 0xe8ff…a791 (pons): the creator's transfers of the token, read
    // live; today's largest holder 0xd0f7…c32f holds 10.68 % of the float.
    const sends: CreatorSends = {
      recipients: [
        {
          address: '0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f',
          value: '99999999999999989864766406',
        },
        {
          address: '0x134b701c4a7ed2412be4e87a7c3c4d68bc504ba8',
          value: '28851383775340723049815153',
        },
        {
          address: '0xf2e43e00c58f13144ab49ae92a12a85e6b37521b',
          value: '6000000000000000000000000',
        },
      ],
      distinct: 11,
      burned: '0',
    };
    const holders = distribution(
      DELTA,
      [
        {
          address: '0xD0f7d8c6e9f6D80c297bEbe4F7fD1B9C8125C32F',
          share: 0.106776,
          kind: 'contract',
        },
        { address: '0x2dBAf98620aC5Bbe3441f756fEfF82702D095b1a', share: 0.032158, kind: 'wallet' },
      ],
      17_427,
    );
    // 0xd0f7… is a contract that passed nothing on: a holder, not a distributor.
    const links = await linkCreatorToHolders(
      linksRpc({
        '0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f': '0x6080',
        '0x134b701c4a7ed2412be4e87a7c3c4d68bc504ba8': '0x',
      }),
      { token: DELTA, sends, holders, supply: E27, setAside: new Set(), fromBlock: 1, toBlock: 2 },
    );
    expect(links.holders).toEqual([
      { address: '0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f', share: 0.099999, via: null },
    ]);
    expect(links.distributors).toEqual([]);

    const report = makeReport(DELTA, (r) => {
      r.holders.data = withLinks(holders, links);
      r.holders.data.pooledShare = 0.063464;
    });
    const facts = toFacts(report);
    expect(facts.holders.top[0]?.fromCreator).toEqual({ share: 0.099999, via: null });
    const supply = buildGlance({ facts })!.items.find((i) => i.id === 'supply');
    expect(supply?.title).toBe(
      'One contract holds 11% of the tokens held outside its pools (10.0% of the whole supply). It received 10.0% of the supply directly from the creator.',
    );
    expect(supply?.tone).toBe('attention');
    const prompt = renderReport(report);
    expect(prompt).toContain(
      '- 0xD0f7d8c6e9f6D80c297bEbe4F7fD1B9C8125C32F (holder today, 10.68% of the share outside pools) received 10.00% of the total supply directly from the creator.',
    );
    expect(prompt).toContain(
      'never write that there is no link between the creator and the holders',
    );
    // And the model may not claim the contrary.
    const said =
      'What deserves attention\n\nNothing links the creator to the largest holder; there is no link between them.\n\nWhat is reassuring\n\nA.';
    expect(findClaims(said, report).map((c) => c.kind)).toContain('no-link');
  });

  it('HYPURRT: the creator’s 3.99 % burn is said', async () => {
    const HYPURRT = '0xff6a3387cf21ef2ed2e94da324bce290ca9abc3b';
    const links = await linkCreatorToHolders(linksRpc({}), {
      token: HYPURRT,
      sends: { recipients: [], distinct: 0, burned: of(0.039912).toString() },
      holders: distribution(HYPURRT, [], 298),
      supply: E27,
      setAside: new Set(),
      fromBlock: 1,
      toBlock: 2,
    });
    expect(links.burned).toBe(0.039912);
    const facts = { holders: { creatorLinks: links, top: [] } } as unknown as ReportFacts;
    const { creatorLinkWords } = await import('../../src/lib/glance');
    expect(creatorLinkWords(facts.holders).words).toBe('The creator burned 4.0% of the supply.');
  });
});

// ---------------------------------------------------------------------------
// 5. What the creator's own launch transaction delivered is creator-linked

describe('MUT8: the creator’s launch transaction delivered 71.4 % to three contracts (item 5)', () => {
  const MUT8 = '0x48d343cae84ab737c46ce63cb74c926609eb03bb';
  const CREATOR = '0x619af567afd627f560a55d03cb722e0ed86a3a84';
  const LAUNCH_TX = '0xc8f6de6899152ab92be1ff76b0b0a4c4d99ce9bcf67d6637a8d901f586e0449a';
  const CURVE = '0x78dd2f4e84af6d0cc36e5f418d98a2eaa712dfd8';
  const PROXIES = [
    '0x92253f0dc487657c1d8fd5b71a7972b88149be9a',
    '0xac7b582cc44428b50919a5639acc6d4919f468b3',
    '0xd8d8fe098b55293cf3075e6e5950faccaf098a0c',
  ];
  const move = (kind: 'mint' | 'buy', actor: string, counterparty: string, share: number) => ({
    kind,
    actor,
    counterparty,
    value: of(share),
    block: 100,
    transaction: LAUNCH_TX,
    seconds: 0,
  });

  it('counts them as linked to the creator, not as taken by the creator', () => {
    const tally = tallyLaunch(
      [move('mint', CURVE, ZERO, 1), ...PROXIES.map((p) => move('buy', p, CURVE, 0.238095))],
      {
        creator: CREATOR,
        from: 100,
        pools: new Set([CURVE, POOL_MANAGER]),
        supply: E27,
        senders: new Map([[LAUNCH_TX, CREATOR]]),
      },
    );
    expect(tally.creatorAtLaunch).toBe(0);
    expect(tally.creatorTx?.transaction).toBe(LAUNCH_TX);
    expect([...(tally.creatorTx?.bought.keys() ?? [])]).toEqual(PROXIES);
  });

  it('the glance and the prompt say so plainly, without claiming ownership', () => {
    const launch = {
      token: MUT8,
      launchBlock: 100,
      launchedAt: null,
      windowSeconds: 600,
      supply: E27.toString(),
      moves: [],
      movesInWindow: 1628,
      summary: {
        moves: 1628,
        earlySeconds: 60,
        creatorAtLaunch: 0,
        creatorBought: 0,
        creatorSold: 0,
        creatorFirstBuyAt: null,
        creatorLastSaleAt: null,
        creatorTx: {
          transaction: LAUNCH_TX,
          addresses: 3,
          share: 0.714285,
          heldNow: 0.645435,
          contracts: 3,
        },
        early: {
          wallets: 190,
          share: 0.97652,
          within: 59.7,
          heldNow: 0.645948,
          unread: 94,
          contracts: null,
        },
        bundle: {
          transaction: LAUNCH_TX,
          wallets: 3,
          share: 0.714285,
          seconds: 0,
          heldNow: 0.645435,
          unread: 0,
          contracts: 3,
        },
        receiptsRead: 60,
        receiptsWanted: 1099,
        balancesRead: 100,
        balancesWanted: 194,
      },
    };
    const report = makeReport(MUT8, (r) => {
      r.creator.data.creator = CREATOR;
      r.launch = { completeness: 'partial', sources: [], data: launch };
    });
    const item = buildGlance({ facts: toFacts(report), launch })!.items.find(
      (i) => i.id === 'launch-buys',
    );
    expect(item?.title).toBe(
      'The creator’s own launch transaction delivered 71% of the supply to 3 contracts other than the creator’s wallet, none of them a pool; who controls them is not shown.',
    );
    expect(renderReport(report)).toContain('the transaction sent by the creator');
    // "It took no supply in the launch block", as served for MUT8, is cut.
    const said =
      'What is reassuring\n\nThe creator wallet shows no sales, and it took no supply in the launch block. The rules have no upgrade slot.';
    expect(findClaims(said, report).map((c) => c.kind)).toEqual(['took-nothing']);
  });
});

// ---------------------------------------------------------------------------
// AML (Doppler): its launch transaction, its creator's routed sale and fees

const AML = '0xd202f27a48649524b8555eac3365d366be8a1e18';
const AML_CREATOR = '0x0b4c63dcc14ea61d0108f08c851baffadcba1dc0';
const AIRLOCK = '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862';
const DOPPLER_HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
const DOPPLER_PLUGIN = '0x6f02324d20cc679d0e585290caa6b16bacbc0f77';
const HOOK_7ED5 = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const AML_MARKET = '0xf34f4259c62ef3605ab2dfc26055fffab96b8f985401c0af5c1af8595340e729';
const AML_LAUNCH = 91_141_466;
const AML_LAUNCH_TX = '0x9242748826f220c333748905e959c309de3ad6d475880028fb0cc19a452aef02';
const AML_FEES_TX = '0xadbf6150b09f2acaf8e5c67231228dd322e4038cb61e0fa62873b7eebe600fcb';
const AML_SALE_TX = '0x259e0e3ef55f57513d3285be8835d7d7e1730b0ea57bba76fc2069b9f7b8c82b';
const RELAY_ROUTER = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
const EXECUTOR = '0xec9aa0a6c2372131a0502aba6188269ab52cacb5';
const SOLD = 0x2e5d586a494b76b3fc00n;

/** AML's launch transaction, its transfers and `Initialize` as read on chain. */
const AML_LAUNCH_LOGS: RawLog[] = [
  transfer(AML, ZERO, AIRLOCK, 0x033b2e3c9fd0803ce8000000n, AML_LAUNCH_TX, AML_LAUNCH, 1),
  {
    address: POOL_MANAGER,
    topics: [INITIALIZE, AML_MARKET, pad('0x6b853019228f92efd822cc3c795c2cb0dc49cfea'), pad(AML)],
    data:
      '0x00000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000' +
      '4e3468951d49f2eea976ed0d6e75ffcb44a9a544' +
      '00000000000000000000000000000000000000c2c0fbdaec17e6eb58f313ba6a0000000000000000000000000000000000000000000000000000000000019be0',
    blockNumber: `0x${AML_LAUNCH.toString(16)}`,
    transactionHash: AML_LAUNCH_TX,
    logIndex: '0x4',
  },
  transfer(AML, AIRLOCK, DOPPLER_HOOK, 0x033b2e3c9fd0803ce8000000n, AML_LAUNCH_TX, AML_LAUNCH, 5),
  transfer(
    AML,
    DOPPLER_HOOK,
    POOL_MANAGER,
    0x033b2e3c9fd0803ce7ffff65n,
    AML_LAUNCH_TX,
    AML_LAUNCH,
    8,
  ),
  transfer(AML, DOPPLER_HOOK, AIRLOCK, 0x9bn, AML_LAUNCH_TX, AML_LAUNCH, 11),
  transfer(AML, AIRLOCK, DEAD, 0x9bn, AML_LAUNCH_TX, AML_LAUNCH, 13),
];

describe('holders: markets’ hooks and Doppler’s contracts are set aside (item 2)', () => {
  it('AML: the hook named in its Initialize is read with its market', () => {
    const venues = findVenues(AML, AML_LAUNCH_LOGS, AIRLOCK);
    expect(venues.v4Markets).toEqual([AML_MARKET]);
    expect(venues.hooks).toEqual([DOPPLER_HOOK]);
  });

  it('HYPURRT and AML: the 0x7ed5 hook, Doppler’s hook and its plug-in are not holders', () => {
    expect(launchInfrastructure().get(HOOK_7ED5)).toBe('hook');
    expect(launchInfrastructure().get(DOPPLER_HOOK)).toBe('hook');
    expect(launchInfrastructure().get(DOPPLER_PLUGIN)).toBe('hook');
    // HYPURRT 0xff6a…bc3b: the 0x7ed5 hook was its largest holder, 2.68 % of the supply.
    const hypurrt = computeDistribution(
      '0xff6a3387cf21ef2ed2e94da324bce290ca9abc3b',
      [
        holder(POOL_MANAGER, of(0.248651), true),
        holder(HOOK_7ED5, of(0.026824), true),
        holder('0xa60fe0b9d2c0e753c775daf7871bb2f927796671', of(0.02673)),
      ],
      {},
      { holders: 3, supply: E27 },
    );
    expect(hypurrt.top.find((h) => h.address === HOOK_7ED5)).toMatchObject({
      kind: 'pool',
      role: 'hook',
      share: 0,
    });
    expect(hypurrt.top[0]?.address).toBe('0xa60fe0b9d2c0e753c775daf7871bb2f927796671');
    // AML: Doppler's hook held 50.8 % of the float, its plug-in 3.2 %.
    const aml = computeDistribution(
      AML,
      [
        holder(POOL_MANAGER, of(0.99664), true),
        holder(DOPPLER_HOOK, of(0.001706), true),
        holder('0xb09f2a5e9c9473fe6dacb989a1e10966a3835b3f', of(0.001333)),
        holder(DOPPLER_PLUGIN, of(0.000106), true),
      ],
      {},
      { holders: 4, supply: E27 },
    );
    expect(aml.top.filter((h) => h.kind === 'wallet' || h.kind === 'contract')).toHaveLength(1);
    expect(aml.setAside?.map((s) => s.role)).toEqual(['pool-manager', 'hook', 'hook']);
  });
});

describe('Doppler: the PoolManager seeded at launch, no dust move (item 8)', () => {
  it('AML: the Airlock and the hook only relay; the mint goes to the PoolManager', () => {
    const markets = new Set([POOL_MANAGER]);
    const pools = new Set([POOL_MANAGER, ...launchInfrastructure().keys()]);
    const moves = draftMoves(AML_LAUNCH_LOGS, pools, markets);
    expect(moves.map((m) => [m.kind, m.actor, m.counterparty])).toEqual([
      ['mint', POOL_MANAGER, ZERO],
      ['mint', DEAD, ZERO],
    ]);
    expect(moves[0]?.value).toBe(0x033b2e3c9fd0803ce7ffff65n);
  });

  it('the replay draws the seeding as a mint and leaves the 155-wei burn out', async () => {
    const rpc = {
      async call<T>(method: string): Promise<T> {
        if (method === 'eth_call') return `0x${E27.toString(16)}` as T;
        return AML_LAUNCH_LOGS.filter((l) => l.address === AML) as T;
      },
      async callBatch(requests: { method: string; params: unknown[] }[]) {
        return requests.map((r) => {
          if (r.method === 'eth_getBlockByNumber')
            return { ok: true, value: { timestamp: '0x6a000000' } };
          if (r.method === 'eth_getTransactionReceipt')
            return { ok: true, value: { from: AML_CREATOR, logs: [] } };
          if (r.method === 'eth_getCode') return { ok: true, value: '0x' };
          return { ok: true, value: '0x0' };
        });
      },
    } as unknown as RpcClient;
    const replay = await readLaunchReplay(rpc, AML as `0x${string}`, {
      launchBlock: AML_LAUNCH,
      latestBlock: AML_LAUNCH,
      pools: [],
      hooks: [DOPPLER_HOOK],
      creator: AML_CREATOR,
    });
    expect(replay.data.moves.map((m) => [m.kind, m.actor, m.share])).toEqual([
      ['mint', POOL_MANAGER, 0.999999],
    ]);
  });
});

describe('AML: a sale routed through a router, and fees collected (item 3)', () => {
  const V4_SWAP_DATA = '0x' + '0'.repeat(64);
  const saleReceipt = {
    from: AML_CREATOR,
    contractAddress: null,
    logs: [
      transfer(AML, AML_CREATOR, RELAY_ROUTER, SOLD, AML_SALE_TX, 91_146_163, 0),
      transfer(AML, RELAY_ROUTER, EXECUTOR, SOLD, AML_SALE_TX, 91_146_163, 4),
      transfer(AML, EXECUTOR, POOL_MANAGER, SOLD - 1n, AML_SALE_TX, 91_146_163, 5),
      {
        address: POOL_MANAGER,
        topics: [V4_SWAP, AML_MARKET, pad(EXECUTOR)],
        data: V4_SWAP_DATA,
        blockNumber: '0x56ebdd3',
        transactionHash: AML_SALE_TX,
        logIndex: '0x6',
      },
    ],
  };

  it('a sale is the creator’s transaction reaching the PoolManager, whatever the hops', () => {
    const markets = new Set([POOL_MANAGER]);
    const detail = {
      nature: natureOf(saleReceipt.logs, markets),
      from: AML_CREATOR,
      logs: saleReceipt.logs,
    };
    expect(detail.nature).toBe('swap');
    expect(isRoutedSale(detail, AML, AML_CREATOR, markets)).toBe(true);
    // Someone else's transaction is not the creator's sale.
    expect(isRoutedSale({ ...detail, from: RELAY_ROUTER }, AML, AML_CREATOR, markets)).toBe(false);
  });

  it('the history counts it, and the fee collection of +387 s', async () => {
    // ModifyLiquidity of zero, twice, in the creator's call to Doppler's hook.
    const modify = (tickLower: string, tickUpper: string, salt: string): RawLog => ({
      address: POOL_MANAGER,
      topics: [MODIFY, AML_MARKET, pad(DOPPLER_HOOK)],
      data: `0x${tickLower}${tickUpper}${'0'.repeat(64)}${salt}`,
      blockNumber: `0x${(91_145_282).toString(16)}`,
      transactionHash: AML_FEES_TX,
      logIndex: '0x0',
    });
    const fees = [
      modify(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec80',
        '0000000000000000000000000000000000000000000000000000000000019be0',
        '0'.repeat(64),
      ),
    ];
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(batch: { method: string; params: unknown[] }[]) {
        return batch.map((r) => {
          const p = r.params[0] as { address?: string; topics?: string[] };
          let value: unknown = null;
          if (r.method === 'eth_getLogs') {
            value =
              p.address === AML
                ? [
                    transfer(AML, AML_CREATOR, RELAY_ROUTER, SOLD, AML_SALE_TX, 91_146_163),
                    transfer(AML, DOPPLER_HOOK, AML_CREATOR, 1n, AML_FEES_TX, 91_145_282),
                  ].filter((l) => l.topics[1] === p.topics?.[1])
                : p.address === POOL_MANAGER && p.topics?.[0] === MODIFY
                  ? fees
                  : [];
          } else if (r.method === 'eth_getCode') value = '0x';
          else if (r.method === 'eth_getTransactionCount') value = '0x13';
          else if (r.method === 'eth_getBlockByNumber') value = { timestamp: '0x6a000000' };
          else if (r.method === 'eth_getTransactionReceipt')
            value = r.params[0] === AML_SALE_TX ? saleReceipt : null;
          else if (r.method === 'eth_getTransactionByHash') value = { from: AML_CREATOR };
          return { ok: true, value };
        });
      },
    } as unknown as RpcClient;
    const history = await fetchDeployerHistory(
      rpc,
      {
        token: AML,
        creator: AML_CREATOR,
        role: 'launcher',
        launchContract: AIRLOCK,
        blockNumber: AML_LAUNCH,
        transactionHash: AML_LAUNCH_TX,
        venues: {
          pools: [],
          v4Markets: [AML_MARKET],
          hooks: [DOPPLER_HOOK],
          saleRecipients: [POOL_MANAGER],
        },
      },
      {
        latestBlock: 91_150_000,
        maxListingQueries: 0,
        now: () => new Date('2026-10-18T00:00:00Z'),
      },
    );
    const own = history.data.tokens.find((t) => t.address === AML);
    expect(own).toMatchObject({ creatorDumped: true, liquidityPulled: false, feesCollected: true });
    const facts = toFacts({
      ...makeReport(AML),
      creator: history,
    });
    expect(facts.creator).toMatchObject({ soldIntoPool: 1, liquidityPulled: 0, feesCollected: 1 });
    const glance = buildGlance({ facts })!;
    expect(glance.items.find((i) => i.id === 'sales')?.title).toBe(
      'The creator sold into the pool on the launch checked.',
    );
    expect(glance.items.find((i) => i.id === 'liquidity')?.title).toBe(
      'The creator never removed liquidity on the 1 launch checked. The creator did collect trading fees from the market’s liquidity position on it.',
    );
    // "has not been seen selling", as served for AML, is cut.
    const said =
      'What is reassuring\n\nThe creator has not been seen selling or removing liquidity over this token’s whole life. The hook has no upgrade slot.';
    expect(findClaims(said, { ...makeReport(AML), creator: history }).map((c) => c.kind)).toEqual([
      'no-sale',
    ]);
  });

  it('a pons creator’s routed sale is found too', async () => {
    const rpc = {
      async call() {
        throw new Error('not used');
      },
      async callBatch(batch: { method: string; params: unknown[] }[]) {
        return batch.map((r) =>
          r.method === 'eth_getTransactionReceipt'
            ? { ok: true, value: saleReceipt }
            : { ok: true, value: null },
        );
      },
    } as unknown as RpcClient;
    const sold = await findRoutedSales(
      rpc,
      AML_CREATOR,
      [{ token: AML, to: RELAY_ROUTER, hash: AML_SALE_TX }],
      () => new Set([POOL_MANAGER]),
    );
    expect([...sold]).toEqual([AML]);
  });
});

describe('BOOMER, AGEM, moon: the links read live (item 4)', () => {
  const BOOMER = '0x127cdc74e44e3c60422b7e792ebe480c0f873ed5';
  const DISTRIBUTOR_A = '0xa7e40b342146af9d9db4a559a9dfc99756027082';
  const DISTRIBUTOR_B = '0x60a17578ebb96910c1b033c523f6d18f9e0ac02c';

  it('BOOMER: 65.2 % and 9.6 % to two contracts that airdropped to 1,281 and 65 addresses', async () => {
    // BOOMER's supply and its creator's two transfers, read on chain.
    const supply = 69373540762521697467898773691n;
    const sends: CreatorSends = {
      recipients: [
        { address: DISTRIBUTOR_A, value: '45251342185220276733715681963' },
        { address: DISTRIBUTOR_B, value: '6658978726053661065163499420' },
      ],
      distinct: 2,
      burned: '0',
    };
    const top = '0x06e52db5d5922c07891bf3a1db751563580b1988';
    const recipients = (from: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        transfer(
          BOOMER,
          from,
          i === 0 && from === DISTRIBUTOR_A ? top : `0x${(i + 1).toString(16).padStart(40, '0')}`,
          i === 0 && from === DISTRIBUTOR_A ? 739_628_000n * 10n ** 18n : 10n ** 18n,
          `0x${from.slice(2, 10)}${i}`,
        ),
      );
    const links = await linkCreatorToHolders(
      linksRpc({ [DISTRIBUTOR_A]: '0x6080', [DISTRIBUTOR_B]: '0x6080' }, (_, t) =>
        t === pad(DISTRIBUTOR_A) ? recipients(DISTRIBUTOR_A, 1281) : recipients(DISTRIBUTOR_B, 65),
      ),
      {
        token: BOOMER,
        sends,
        holders: distribution(BOOMER, [{ address: top, share: 0.021816, kind: 'wallet' }], 1949),
        supply,
        setAside: new Set(),
        fromBlock: 1,
        toBlock: 2,
      },
    );
    expect(links.distributors.map((d) => [d.address, d.share, d.recipients])).toEqual([
      [DISTRIBUTOR_A, 0.652285, 1281],
      [DISTRIBUTOR_B, 0.095987, 65],
    ]);
    expect(links.holders).toEqual([{ address: top, share: 0.010661, via: DISTRIBUTOR_A }]);
    const holders = withLinks(
      distribution(BOOMER, [{ address: top, share: 0.021816, kind: 'wallet' }], 1949),
      links,
    );
    const facts = toFacts(makeReport(BOOMER, (r) => (r.holders.data = holders)));
    const { creatorLinkWords } = await import('../../src/lib/glance');
    expect(creatorLinkWords(facts.holders).words).toBe(
      'It received 1.1% of the supply from a contract the creator had sent tokens to. The creator sent 75% of the supply to 2 contracts that passed it on to 1,346 addresses.',
    );
  });

  it('AGEM and moon: today’s largest holder received the creator’s launch buy', async () => {
    const cases = [
      // AGEM 0x7c04…9aef: the creator's 17.94 % went to 0x910e…c72e, a contract.
      [
        '0x7c0495053f47ec52eb4b678c4ad8f572df745bfe',
        '0x910e19bcc4bce46999994ed7297e0fc4431ec72e',
        0.179372,
      ],
      // moon 0x862c…7777: its 26.74 % launch buy went to 0x20ae…c00d.
      [
        '0x862cdccb67c8a22fdb247d09a08b1dad09447777',
        '0x20ae13c30960e1069c5212927f99fcffb635c00d',
        0.267353,
      ],
    ] as const;
    for (const [token, top, share] of cases) {
      const links = await linkCreatorToHolders(linksRpc({ [top]: '0x6080' }), {
        token,
        sends: {
          recipients: [{ address: top, value: of(share).toString() }],
          distinct: 1,
          burned: '0',
        },
        holders: distribution(token, [{ address: top, share: 0.2, kind: 'wallet' }], 900),
        supply: E27,
        setAside: new Set(),
        fromBlock: 1,
        toBlock: 2,
      });
      expect(links.holders).toEqual([{ address: top, share, via: null }]);
    }
  });
});
