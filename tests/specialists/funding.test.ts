import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { renderSpecialists } from '../../src/lib/agent/prompt';
import { isCompliant } from '../../src/lib/agent/guardrails';
import { resetFunderProfiles } from '../../src/lib/chain/funding';
import type { ReportFacts } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';
import { answerAll, type SpecialistAnswer } from '../../src/lib/specialists/brief';
import { CATALOG } from '../../src/lib/specialists/catalog';
import { gatherFunding } from '../../src/lib/specialists/context';
import type { FundingFacts, SpecialistContext } from '../../src/lib/specialists/types';
import { makeReport } from './helpers';

const token = '0x00000000000000000000000000000000000000aa';
const CREATOR = '0x00000000000000000000000000000000000000c1';
const EXCHANGE = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';
const GASLITE = '0xe68d0bbc023de3febda04f413db23ce9c5ea1934';
const WALLET = '0xf0fc311800000000000000000000000000000001';

const run = (funding: FundingFacts | null | undefined) =>
  CATALOG['funding-trace'].run({ token, funding } as SpecialistContext);

describe('funding-trace by kind of funder', () => {
  it('says a high-volume service tells nothing, quietly', () => {
    const f = run({
      funder: EXCHANGE,
      funderKind: 'service',
      funderName: null,
      funderTxCount: 2_266_426,
      otherCreatorsFunded: 0,
    });
    expect(f.signal).toBe('quiet');
    expect(f.facts).toEqual([
      'The creator wallet was first funded from a high-volume service (unnamed, 2,266,426 transactions), such as an exchange, bridge or router. That says nothing about who is behind the wallet.',
    ]);
    expect(f.funding).toMatchObject({ kind: 'service', linkedCreators: 0 });
  });

  it('quotes a service’s contract name as data', () => {
    const f = run({
      funder: '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f',
      funderKind: 'service',
      funderName: 'RelayRouterV3',
      funderTxCount: 12_000,
      otherCreatorsFunded: 0,
    });
    expect(f.facts[0]).toContain('("RelayRouterV3", 12,000 transactions)');
  });

  it('follows the sender behind a batch-sending tool', () => {
    const f = run({
      funder: GASLITE,
      funderKind: 'tool',
      funderName: 'GasliteDrop',
      funderTxCount: 1_000_000,
      origin: WALLET,
      originKind: 'wallet',
      originTxCount: 33,
      otherCreatorsFunded: 16,
    });
    expect(f.signal).toBe('concern');
    expect(f.facts[0]).toBe(
      `The creator wallet was first funded with a transfer sent through a batch-sending tool ("GasliteDrop") by ${WALLET}.`,
    );
    expect(f.facts[1]).toMatch(
      /^The wallet that funded the creator \(0xf0fc.*, 33 transactions\) also funded 16 other token creators\.$/,
    );
    expect(f.funding?.path[0]).toMatchObject({ address: WALLET, via: { address: GASLITE } });
  });

  it('a tool whose sender was not read is unknown, and says why', () => {
    const f = run({
      funder: GASLITE,
      funderKind: 'tool',
      funderName: 'GasliteDrop',
      otherCreatorsFunded: 0,
    });
    expect(f.signal).toBe('unknown');
    expect(f.limits[0]).toMatch(/who sent the funding through that tool was not read/);
  });

  it('a tool sent by an exchange is a service', () => {
    const f = run({
      funder: GASLITE,
      funderKind: 'tool',
      funderName: 'GasliteDrop',
      origin: EXCHANGE,
      originKind: 'service',
      originTxCount: 2_266_426,
      otherCreatorsFunded: 0,
    });
    expect(f.signal).toBe('quiet');
    expect(f.facts[1]).toMatch(/^That sender is a high-volume service/);
  });

  it('a wallet that funded nobody else is quiet', () => {
    const f = run({
      funder: WALLET,
      funderKind: 'wallet',
      funderTxCount: 33,
      otherCreatorsFunded: 0,
    });
    expect(f.signal).toBe('quiet');
    expect(f.facts).toEqual([
      `The creator wallet was first funded by ${WALLET}, 33 transactions.`,
      'No other token creator funded by that wallet is on record.',
    ]);
  });

  it('does not say "none" when the other creators were not looked up', () => {
    const f = run({
      funder: WALLET,
      funderKind: 'wallet',
      funderTxCount: 33,
      otherCreatorsFunded: 0,
      otherCreatorsChecked: false,
    });
    expect(f.facts.join(' ')).not.toMatch(/No other/);
    expect(f.limits).toContain('whether that wallet funded other token creators was not looked up');
  });

  it('states the network the indexer walked, and what it could not read', () => {
    const f = run({
      funder: WALLET,
      funderKind: 'wallet',
      funderTxCount: 33,
      otherCreatorsFunded: 4,
      network: {
        creators: 16,
        launches: 41,
        launchpads: { pons: 38, flap: 3 },
        depth: 2,
        incomplete: true,
        reason: 'the first funding of 0xabcd…0001 has not been read yet',
        capped: false,
        path: [
          { address: WALLET, kind: 'wallet', name: null, txCount: 33 },
          {
            address: '0xabcd000000000000000000000000000000000001',
            kind: 'wallet',
            name: null,
            txCount: 120,
          },
        ],
      },
    });
    expect(f.signal).toBe('concern');
    expect(f.facts[0]).toBe(
      `The wallet that funded the creator (${WALLET}, 33 transactions) also funded 16 other token creators, linked through 2 funding steps. Together they launched 41 tokens.`,
    );
    expect(f.facts[1]).toBe('Their launches by launchpad: pons 38, flap 3.');
    expect(f.limits[0]).toBe(
      'the funding chain could not be followed further: the first funding of 0xabcd…0001 has not been read yet',
    );
    expect(f.funding).toMatchObject({ kind: 'wallet', linkedCreators: 16, launches: 41, depth: 2 });
    expect(f.funding?.path).toHaveLength(2);
  });

  it('an unidentified funder is unknown, never a wallet', () => {
    const f = run({ funder: WALLET, funderKind: 'unknown', otherCreatorsFunded: 0 });
    expect(f.signal).toBe('unknown');
    expect(f.facts).toEqual([`The creator wallet was first funded by ${WALLET}.`]);
    expect(f.limits[0]).toMatch(/could not be read, so other creators it funded are not counted/);
  });

  it('never words a verdict, whatever the kind', () => {
    const kinds: FundingFacts[] = [
      { funder: EXCHANGE, funderKind: 'service', funderTxCount: 2_266_426, otherCreatorsFunded: 0 },
      { funder: WALLET, funderKind: 'wallet', funderTxCount: 33, otherCreatorsFunded: 16 },
      { funder: WALLET, funderKind: 'unknown', otherCreatorsFunded: 0 },
      { funder: GASLITE, funderKind: 'tool', funderName: 'GasliteDrop', otherCreatorsFunded: 0 },
    ];
    for (const funding of kinds) {
      const f = run(funding);
      for (const line of [...f.facts, ...f.limits]) expect(isCompliant(line), line).toBe(true);
      expect(f.facts.join(' ')).not.toMatch(/suspicious|scam|rug|safe|risky/i);
    }
  });
});

describe('the funding answer as served', () => {
  it('carries the path, and hides a contract name that reads as a verdict', () => {
    const answers = answerAll({
      token,
      funding: {
        funder: EXCHANGE,
        funderKind: 'service',
        funderName: 'Safe Router',
        funderTxCount: 90_000,
        otherCreatorsFunded: 0,
      },
    });
    const funding = answers.find((a) => a.specialist === 'funding-trace')!;
    expect(funding.funding?.path[0]).toMatchObject({
      address: EXCHANGE,
      kind: 'service',
      name: null,
    });
    expect(funding.facts[0]).toContain('name withheld');
  });

  it('tells the model what the funder is, and the offline text says it too', () => {
    const answers = answerAll({
      token,
      funding: {
        funder: EXCHANGE,
        funderKind: 'service',
        funderTxCount: 2_266_426,
        otherCreatorsFunded: 0,
      },
    });
    expect(renderSpecialists(answers).join('\n')).toMatch(
      /financeur : service à fort volume .* ne relie ce créateur à personne/,
    );
    const text = offlineExplanation(makeReport(token), answers);
    expect(text).toMatch(/Funding: The creator wallet was first funded from a high-volume service/);
  });
});

function glanceFacts(): ReportFacts {
  return {
    creator: {
      measured: true,
      address: CREATOR,
      launched: 1,
      detailed: 1,
      graduated: 0,
      abandoned: 0,
      undetermined: 0,
      active: 1,
      checked: 0,
      soldIntoPool: 0,
      liquidityPulled: 0,
      salesChecked: 0,
      liquidityChecked: 0,
      source: 'pons',
      role: null,
      launchContract: null,
      launchesListed: true,
      transactionCount: 4,
    },
    holders: { measured: false, holderCount: null, pooled: null, top1: 0, top10: 0, top: [] },
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
  } as unknown as ReportFacts;
}

const fundingAnswer = (display: SpecialistAnswer['funding']): SpecialistAnswer => ({
  specialist: 'funding-trace',
  title: 'Funding Trace',
  question: 'Who paid for the creator’s wallet, and did they fund other creators?',
  signal: 'concern',
  facts: [],
  limits: [],
  ...(display ? { funding: display } : {}),
});

describe('glance: linked creators', () => {
  it('leads with the creators funded by the same wallet', () => {
    const glance = buildGlance({
      facts: glanceFacts(),
      specialists: [
        fundingAnswer({ kind: 'wallet', linkedCreators: 16, launches: 41, depth: 1, path: [] }),
      ],
    })!;
    const item = glance.items.find((i) => i.id === 'network');
    expect(item).toEqual({
      id: 'network',
      tone: 'attention',
      figure: '16',
      title:
        'The wallet that funded this creator also funded 16 other token creators, who launched 41 tokens between them.',
      detail: expect.any(String),
      href: '#question-funding-trace',
    });
    expect(glance.headline).toBe(item?.title);
  });

  it('says so when the link runs through several funding steps', () => {
    const glance = buildGlance({
      facts: glanceFacts(),
      specialists: [
        fundingAnswer({ kind: 'wallet', linkedCreators: 3, launches: null, depth: 2, path: [] }),
      ],
    })!;
    expect(glance.items.find((i) => i.id === 'network')?.title).toBe(
      'The wallets behind this creator’s funding also funded 3 other token creators.',
    );
  });

  it('never for a service, an unknown funder, or a single other creator', () => {
    for (const display of [
      { kind: 'service' as const, linkedCreators: 117, launches: 300, depth: 0, path: [] },
      { kind: 'unknown' as const, linkedCreators: 40, launches: null, depth: 0, path: [] },
      { kind: 'wallet' as const, linkedCreators: 1, launches: 2, depth: 1, path: [] },
    ]) {
      const glance = buildGlance({ facts: glanceFacts(), specialists: [fundingAnswer(display)] })!;
      expect(glance.items.some((i) => i.id === 'network')).toBe(false);
    }
  });
});

describe('direct lookup when the indexer has not read the creator', () => {
  const calls: string[] = [];
  beforeEach(() => {
    resetFunderProfiles();
    calls.length = 0;
    vi.stubEnv('BLOCKSCOUT_API_KEY', 'test-key');
    vi.stubEnv('INDEXER_URL', '');
    vi.stubEnv('INDEXER_TOKEN', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function blockscout(profiles: Record<string, { body: unknown; count: string }>) {
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      const action = url.searchParams.get('action');
      if (action === 'txlist') {
        return Response.json({
          status: '1',
          result: [{ to: CREATOR, from: GASLITE, value: '5', blockNumber: '7', hash: '0xfeed' }],
        });
      }
      if (action === 'txlistinternal') {
        return Response.json({ status: '0', message: 'No transactions found', result: [] });
      }
      const match = /\/api\/v2\/addresses\/(0x[0-9a-f]+)(\/counters)?$/.exec(url.pathname);
      const p = match ? profiles[match[1]!] : undefined;
      if (!p) return new Response('not found', { status: 404 });
      return Response.json(match![2] ? { transactions_count: p.count } : p.body);
    });
  }

  const rpc = {
    call: async <T>(method: string, params: unknown[]): Promise<T> => {
      if (method === 'eth_getTransactionByHash' && params[0] === '0xfeed') {
        return { from: EXCHANGE } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    batch: async () => [],
  } as unknown as Parameters<typeof gatherFunding>[0];

  it('classifies the tool, reads its sender by the RPC, and finds an exchange', async () => {
    blockscout({
      [GASLITE]: { body: { is_contract: true, name: 'GasliteDrop' }, count: '1000000' },
      [EXCHANGE]: { body: { is_contract: false, name: null }, count: '2266426' },
    });
    const funding = await gatherFunding(rpc, token, CREATOR);
    expect(funding).toEqual({
      funder: GASLITE,
      funderKind: 'tool',
      funderName: 'GasliteDrop',
      funderTxCount: 1_000_000,
      txHash: '0xfeed',
      origin: EXCHANGE,
      originKind: 'service',
      originTxCount: 2_266_426,
      otherCreatorsFunded: 0,
      otherCreatorsChecked: false,
    });
    expect(calls).toContain(`/4663/api/v2/addresses/${GASLITE}/counters`);
    expect(run(funding).signal).toBe('quiet');
  });

  it('caches a profile for the day: a second lookup reads no profile again', async () => {
    blockscout({
      [GASLITE]: { body: { is_contract: true, name: 'GasliteDrop' }, count: '1000000' },
      [EXCHANGE]: { body: { is_contract: false, name: null }, count: '2266426' },
    });
    await gatherFunding(rpc, token, CREATOR);
    const first = calls.filter((c) => c.includes('/v2/')).length;
    await gatherFunding(rpc, token, CREATOR);
    expect(calls.filter((c) => c.includes('/v2/')).length).toBe(first);
  });

  it('leaves the funder unknown when Blockscout cannot profile it', async () => {
    blockscout({});
    const funding = await gatherFunding(rpc, token, CREATOR);
    expect(funding).toMatchObject({
      funder: GASLITE,
      funderKind: 'unknown',
      otherCreatorsFunded: 0,
    });
    expect(run(funding).signal).toBe('unknown');
  });
});

describe('funding from a configured indexer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('takes the kind, the other creators and the network from the indexer', async () => {
    vi.stubEnv('INDEXER_URL', 'http://indexer.test');
    vi.stubEnv('INDEXER_TOKEN', 'x'.repeat(32));
    vi.stubEnv('BLOCKSCOUT_API_KEY', 'test-key');
    const creator = '0x00000000000000000000000000000000000000c7';
    vi.stubGlobal('fetch', async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `/v1/creator/${creator}`) {
        return Response.json({
          creator,
          indexedTo: 1,
          launchCount: 1,
          truncated: false,
          launches: [],
          fundingState: 'found',
          funding: {
            funder: WALLET,
            txHash: '0x1',
            block: 1,
            kind: 'tx',
            funderKind: 'wallet',
            funderName: null,
            funderTxCount: 33,
            effective: WALLET,
            effectiveKind: 'wallet',
            otherCreatorsFunded: ['0x01', '0x02'],
          },
        });
      }
      if (path === `/v1/network/${creator}`) {
        return Response.json({
          creator,
          indexedTo: 1,
          network: {
            creators: 16,
            capped: false,
            launches: 41,
            launchpads: { pons: 41 },
            firstLaunchAt: null,
            lastLaunchAt: null,
            depth: 2,
            incomplete: false,
            path: [
              {
                level: 1,
                address: WALLET,
                kind: 'wallet',
                name: null,
                txCount: 33,
                creatorsFunded: 2,
              },
            ],
          },
        });
      }
      throw new Error(`no call expected to ${path}`);
    });
    const funding = await gatherFunding({} as Parameters<typeof gatherFunding>[0], token, creator);
    expect(funding).toMatchObject({
      funderKind: 'wallet',
      otherCreatorsFunded: 2,
      network: { creators: 16, launches: 41, depth: 2 },
    });
    expect(run(funding).facts[0]).toMatch(/also funded 16 other token creators, linked through 2/);
  });
});
