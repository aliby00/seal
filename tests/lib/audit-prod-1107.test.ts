import { describe, expect, it } from 'vitest';
import type { RpcClient } from '../../src/lib/chain/rpc';
import type { LaunchMove } from '../../src/lib/contracts/launch';
import type { HolderDistributionData } from '../../src/lib/contracts/holders';
import type { ReportFacts } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';
import { refreshBalances } from '../../src/lib/holders/chain';
import { withLaunchLinks } from '../../src/lib/holders/links';
import { flowHeadline, type SupplyFlow } from '../../src/lib/supply-flow';

/**
 * Regressions from nine live analyses on production (07/11/2026): a stale
 * balance said twice, a creator's split not linked to its holders, that split
 * and a $159 market read as reassuring.
 */

const TOKEN = '0x137a78a50b1fc70eef8cc796797bffbecd457c9d';
const CREATOR = '0xeb8dde62607334dd78d7e40df1aa532caed25a01';
const W1 = '0x991091194513d1edd9ccbd50cdd88656e64f47e7';
const W2 = '0x6bb2af1d5b2b085d14dff779bdbb82e48218cc42';

const rpcWith = (balances: Record<string, bigint>) =>
  ({
    async call() {
      throw new Error('not used');
    },
    async callBatch(requests: { params: [{ data: string }, string] }[]) {
      return requests.map(({ params }) => {
        const who = `0x${params[0].data.slice(-40)}`;
        const b = balances[who];
        return b === undefined ? { ok: false } : { ok: true, value: `0x${b.toString(16)}` };
      });
    },
  }) as unknown as RpcClient;

const data = (): HolderDistributionData => ({
  token: TOKEN,
  countedSupply: '1000',
  holderCount: 3,
  top: [
    { address: W1, balance: '232', share: 0.232, kind: 'wallet' },
    { address: CREATOR, balance: '29', share: 0.029, kind: 'wallet' },
    { address: W2, balance: '217', share: 0.217, kind: 'wallet' },
  ],
  concentration: { top1: 0.232, top10: 0.478 },
  distinctTraders: null,
});

describe('holders: balances read again on chain', () => {
  it('drops a creator Blockscout still listed at 2.9 % while the chain says zero', async () => {
    const out = await refreshBalances(rpcWith({ [W1]: 207n, [CREATOR]: 0n, [W2]: 217n }), data());
    expect(out.top.map((h) => h.address)).toEqual([W2, W1]);
    expect(out.top[1]!.share).toBe(0.207);
    expect(out.concentration.top1).toBe(0.217);
  });

  it('keeps Blockscout’s figure for a balance the node did not return', async () => {
    const out = await refreshBalances(rpcWith({ [W1]: 207n }), data());
    expect(out.top.find((h) => h.address === CREATOR)?.share).toBe(0.029);
  });
});

const move = (actor: string, share: number): LaunchMove => ({
  kind: 'allocation',
  seconds: 1,
  block: 4,
  actor,
  counterparty: CREATOR,
  actorKind: 'wallet',
  share,
  actorIsCreator: false,
  counterpartyIsCreator: true,
  heldNow: share,
  transaction: '0x1',
});

describe('holders: what the creator handed out at launch is a link', () => {
  it('marks holders the replay saw receive from the creator, and adds them to the links', () => {
    const read = {
      ...data(),
      creatorLinks: {
        sentTo: 0,
        burned: 0,
        holders: [],
        distributors: [],
        recipients: [],
        sentShare: 0,
      },
    };
    const out = withLaunchLinks(read, [move(W1, 0.2), move(W2, 0.188)]);
    expect(out.top.find((h) => h.address === W1)?.fromCreator).toEqual({ share: 0.2, via: null });
    expect(out.creatorLinks?.sentTo).toBe(2);
    expect(out.creatorLinks?.holders.map((h) => h.address)).toEqual([W1, W2]);
    expect(out.creatorLinks?.sentShare).toBeCloseTo(0.388);
  });

  it('marks the holders only when the creator’s own transfers were not read', () => {
    const out = withLaunchLinks(data(), [move(W1, 0.2)], false);
    expect(out.top[0]!.fromCreator).toEqual({ share: 0.2, via: null });
    expect(out.creatorLinks).toBeUndefined();
  });
});

describe('supply flow: what the creator passed on leads', () => {
  it('says the creator handed 67 % to five wallets in the same second', () => {
    const child = (address: string, received: number) => ({
      address,
      kind: 'wallet' as const,
      name: 'a wallet',
      tradable: true,
      received,
      heldNow: received,
      at: 1,
      children: [],
    });
    const flow: SupplyFlow = {
      launchpad: null,
      windowSeconds: 152,
      roots: [
        {
          address: CREATOR,
          kind: 'creator',
          name: 'the creator',
          tradable: true,
          received: 1,
          heldNow: 0,
          at: 1,
          children: [
            child(W1, 0.2),
            child(W2, 0.188),
            child('0x3', 0.141),
            child('0x4', 0.092),
            child('0x5', 0.05),
          ],
        },
      ],
      buys: 14,
    } as SupplyFlow;
    const { sentence, creatorKept } = flowHeadline(flow, CREATOR);
    expect(sentence).toBe(
      '100% to the creator at launch, 67.1% passed on by the creator to 5 addresses in the same second, which hold 67.1% today.',
    );
    expect(creatorKept).toBe(true);
  });
});

describe('glance: a thin market deserves attention', () => {
  it('FOBO: $159 of liquidity is said first, as worth attention', () => {
    const facts = {
      creator: {
        measured: false,
        address: null,
        launched: 0,
        detailed: 0,
        graduated: 0,
        abandoned: 0,
        undetermined: 0,
        active: 0,
        checked: 0,
        soldIntoPool: 0,
        liquidityPulled: 0,
      },
      holders: { measured: false, holderCount: null, top1: 0, top10: 0, top: [] },
      market: {
        measured: true,
        priceUsd: null,
        liquidityUsd: 159,
        volume24hUsd: 400,
        buys24h: 100,
        sells24h: 34,
        fdvUsd: null,
        graduation: null,
      },
    } as unknown as ReportFacts;
    const item = buildGlance({ facts })!.items.find((i) => i.id === 'market')!;
    expect(item.tone).toBe('attention');
    expect(item.title).toBe(
      'Its market holds only $159 of liquidity: a sale of a few hundred dollars moves its price.',
    );
  });
});
