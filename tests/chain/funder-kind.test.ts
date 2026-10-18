import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as indexed from '../../indexer/src/funder-kind';
import * as app from '../../src/lib/chain/funder-kind';
import type { FunderKind, FunderProfile } from '../../src/lib/chain/funder-kind';

/**
 * The real first funders of Robinhood Chain creators, read on 2026-10-17,
 * and a few edges around the thresholds. The app and the indexer each keep a
 * copy of the classifier: both must answer the same.
 */
const p = (
  address: string,
  isContract: boolean,
  name: string | null,
  txCount: number | null,
  tags: string[] = [],
): FunderProfile => ({ address, isContract, name, txCount, tags });

const TABLE: [string, FunderProfile | null, FunderKind][] = [
  [
    'exchange or relayer hot wallet (EOA, 2.27M txs)',
    p('0xf70da97812cb96acdf810712aa562db8dfa3dbef', false, null, 2_266_426),
    'service',
  ],
  [
    'ERC1967Proxy with 880k txs',
    p('0xd29c85f15df544ba632c9e25829fd29d767d7978', true, 'ERC1967Proxy', 880_000),
    'service',
  ],
  [
    'RelayRouterV3',
    p('0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', true, 'RelayRouterV3', 12_000),
    'service',
  ],
  ['RelayDepository', p('0x4cd00e38', true, 'RelayDepository', 9_000), 'service'],
  ['UniversalRouter (33.9M txs)', p('0x88767899', true, 'UniversalRouter', 33_900_000), 'service'],
  ['MulticallHandler, few txs', p('0xa8ad2e87', true, 'MulticallHandler', 1_200), 'service'],
  ['exchange hot wallet EOA, 0.5M txs', p('0xhot', false, null, 500_000), 'service'],
  [
    'GasliteDrop airdrop tool (1M txs)',
    p('0xe68d0bbc023de3febda04f413db23ce9c5ea1934', true, 'GasliteDrop', 1_000_000),
    'tool',
  ],
  [
    'BatchTransfer tool (51k txs)',
    p('0x3f43479c8536f7ee8180d0f67a050980dc5bc8c8', true, 'BatchTransfer', 51_000),
    'tool',
  ],
  ['Disperse', p('0xd1', true, 'Disperse', 300), 'tool'],
  ['MultiSendCallOnly', p('0xd2', true, 'MultiSendCallOnly', 300), 'tool'],
  ['a tool name on an EOA is not a tool', p('0xd3', false, 'Airdrop', 30), 'wallet'],
  ['EOA with 33 txs that funded 16 creators', p('0xf0fc3118', false, null, 33), 'wallet'],
  // A contract is never "a wallet that funded others", whatever its count.
  ['contract with 232 txs', p('0x22749939', true, null, 232), 'service'],
  ['contract with 568 txs', p('0x519b2f24', true, null, 568), 'service'],
  ['contract with 4,074 txs', p('0xf341c935', true, null, 4_074), 'service'],
  [
    'AGEM: an 8 KB contract named "Executor", 0 txs, funded 25 creators',
    p('0xa5166c3e69a933ee547ad908c9f1474f8f61901a', true, 'Executor', 0),
    'service',
  ],
  ['a contract whose count is unread', p('0xe6', true, null, null), 'service'],
  ['just below the service threshold', p('0xe1', false, null, 49_999), 'wallet'],
  ['at the service threshold', p('0xe2', false, null, 50_000), 'service'],
  [
    'a low-volume proxy is a contract, not a wallet',
    p('0xe3', true, 'ERC1967Proxy', 40),
    'service',
  ],
  ['tagged as an exchange', p('0xe4', false, null, 900, ['Binance 14']), 'service'],
  ['transaction count unread', p('0xe5', false, null, null), 'unknown'],
  ['profile unreadable', null, 'unknown'],
];

describe.each([
  ['app', app],
  ['indexer', indexed],
])('funder classifier (%s copy)', (_, impl) => {
  it.each(TABLE)('%s', (_label, profile, kind) => {
    expect(impl.classifyFunder(profile)).toBe(kind);
  });

  it('puts the threshold at 50,000 transactions', () => {
    expect(impl.SERVICE_TX_COUNT).toBe(50_000);
  });

  it('groups a tool funding by its sender, one level only', () => {
    expect(impl.effectiveFunder({ funder: '0xa', kind: 'wallet' })).toEqual({
      effective: '0xa',
      kind: 'wallet',
    });
    expect(impl.effectiveFunder({ funder: '0xtool', kind: 'tool' })).toEqual({
      effective: null,
      kind: 'unknown',
    });
    expect(
      impl.effectiveFunder({
        funder: '0xtool',
        kind: 'tool',
        origin: '0xb',
        originKind: 'service',
      }),
    ).toEqual({ effective: '0xb', kind: 'service' });
    expect(
      impl.effectiveFunder({ funder: '0xtool', kind: 'tool', origin: '0xb', originKind: 'tool' }),
    ).toEqual({ effective: '0xb', kind: 'unknown' });
  });

  it('reads a Blockscout v2 address and its counters', () => {
    expect(
      impl.parseProfile(
        '0xE68D0BBC023DE3FEBDA04F413DB23CE9C5EA1934',
        { is_contract: true, name: 'GasliteDrop', metadata: { tags: [{ name: 'Airdrop' }] } },
        { transactions_count: '1000000' },
      ),
    ).toEqual({
      address: '0xe68d0bbc023de3febda04f413db23ce9c5ea1934',
      isContract: true,
      name: 'GasliteDrop',
      txCount: 1_000_000,
      tags: ['Airdrop'],
    });
    expect(impl.parseProfile('0xa', { is_contract: false }, {})).toMatchObject({ txCount: null });
    expect(impl.parseProfile('0xa', null, {})).toBeNull();
  });
});

describe('the two copies', () => {
  it('stay identical but for the line naming the other copy', () => {
    const strip = (path: string) =>
      readFileSync(new URL(path, import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => !/copy in|imports nothing/.test(line))
        .join('\n');
    expect(strip('../../indexer/src/funder-kind.ts')).toBe(
      strip('../../src/lib/chain/funder-kind.ts'),
    );
  });
});
