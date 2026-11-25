import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58 } from '../../src/lib/solana/address';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import { UpstreamError } from '../../src/lib/errors';
import {
  COARSE_SAMPLE_MAX,
  FULL_READ_MAX_ACCOUNTS,
  readHolders,
  SAMPLE_RATIO,
  type SolanaHolders,
} from '../../src/lib/solana/holders';
import {
  MethodUnavailableError,
  type ProgramAccount,
  type RecordedCall,
  type SolanaRpc,
} from '../../src/lib/solana/rpc';
import { loadRecordings } from './fixtures';

/**
 * Holders read from answers recorded on mainnet on 24-25/11/2026
 * (tests/fixtures/solana/holders/README.md says what each one is). The public
 * node refuses getTokenLargestAccounts: its real answer (429) is
 * `public-refuses-largest.json`, served with every token read through it.
 */

const MINTS = {
  pumpCurve: 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump',
  meteoraDbc: '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx',
  jupLock: '2gmnGtsLYHdttFCn4jVpRFbsNPgHfNkgPh2mGFmopump',
  streamflow: '4iNowernM7VnmA79FyedcUGnM22GMm2keEtwbaJepump',
  launchlab: '8tLjXE3MRduPL3qZcFZ4k2Covpuk6Zax4A1aqDTfLoat',
  burn: '8YbE2LfQJmUYVw9Uhdy5EC53iuUNV7qfQq8naiGiGgan',
  goat: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
  mid: '8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn',
};

const NOW = () => new Date('2026-11-25T00:00:00Z');

function publicNode(file: string) {
  return createFakeSolanaRpc(loadRecordings('holders', [file, 'public-refuses-largest.json']));
}

async function read(file: string, mint: string, creator?: string) {
  const rpc = publicNode(file);
  const result = await readHolders(mint, rpc, { now: NOW, ...(creator ? { creator } : {}) });
  return { rpc, result };
}

/** The full list as the recorded getProgramAccounts answer gives it, decoded here on its own. */
function ownersFromRecording(file: string): Map<string, bigint> {
  const full = loadRecordings('holders', [file]).find(
    (e) =>
      e.method === 'getProgramAccounts' &&
      (e.params?.[1] as { dataSlice?: { length: number } }).dataSlice?.length === 40,
  ) as RecordedCall;
  const owners = new Map<string, bigint>();
  for (const entry of full.result as ProgramAccount[]) {
    const bytes = Buffer.from((entry.account.data as [string, string])[0], 'base64');
    const owner = encodeBase58(bytes.subarray(0, 32));
    owners.set(owner, (owners.get(owner) ?? 0n) + bytes.readBigUInt64LE(32));
  }
  return owners;
}

const holder = (result: SolanaHolders, address: string) =>
  result.data.top.find((h) => h.address === address);

/** How many accounts a recorded owner-prefix sample returned. */
function recordedProbe(file: string, prefix: '1' | '11'): number {
  const entry = loadRecordings('holders', [file]).find(
    (e) =>
      e.method === 'getProgramAccounts' &&
      JSON.stringify((e.params?.[1] as { filters: unknown[] }).filters.at(-1)) ===
        JSON.stringify({ memcmp: { offset: 32, bytes: prefix } }),
  );
  return (entry?.result as unknown[]).length;
}

/** Every account was read: the count, the parts and the supply agree with the raw list. */
function expectWholeList(result: SolanaHolders, file: string) {
  const owners = ownersFromRecording(file);
  const positive = [...owners].filter(([, v]) => v > 0n);
  const aside = result.data.setAside ?? [];
  expect(aside.length).toBeLessThan(10);
  expect(result.data.holderCount).toBe(positive.length - aside.length);
  expect(result.data.holdersAtLeast).toBe(result.data.holderCount);
  const asideTotal = aside.reduce((s, a) => s + (owners.get(a.address) ?? 0n), 0n);
  const total = positive.reduce((s, [, v]) => s + v, 0n);
  expect(total.toString()).toBe(result.data.supply);
  expect(BigInt(result.data.countedSupply)).toBe(total - asideTotal);
}

describe('readHolders on a pump.fun token still on its curve', () => {
  it('reads every account, sets the curve aside and counts the holders exactly', async () => {
    const { rpc, result } = await read(
      'pump-curve.json',
      MINTS.pumpCurve,
      'B7VKZzqyCJCJ12yu4AkVdaTvQjd3TSiUJMtCppGP38xg',
    );
    expect(result.completeness).toBe('full');
    expect(result.sources).toEqual([{ name: 'solana-rpc', fetchedAt: NOW().toISOString() }]);
    expect(result.data).toMatchObject({
      chain: 'solana',
      program: 'token-2022',
      decimals: 6,
      supply: '1000000000000000',
      method: 'all-accounts',
      accountsRead: 160,
      holderCount: 13,
    });
    expectWholeList(result, 'pump-curve.json');
    // The curve PDA [bonding-curve, mint], owned by pump.fun.
    expect(result.data.setAside).toEqual([
      {
        address: '8j8apXSGYWc9m9XySAADCYmUzhetFzs2ZMoj36opQ8YA',
        role: 'curve',
        share: 0.962868,
        name: 'pump.fun bonding curve',
      },
    ]);
    expect(result.data.ofSupply).toEqual({
      largestWallet: 0.004353,
      top10Wallets: 0.033937,
      pools: 0,
      curves: 0.962868,
      burned: 0,
      locked: 0,
    });
    const top = result.data.top[0]!;
    expect(top).toMatchObject({
      address: 'EqDxcwrZMNYBSySXu3NbhwPtHAx4pPkkCQ4n5H4cfJdc',
      kind: 'wallet',
      balance: '4353328308414',
      ofSupply: 0.004353,
    });
    // Measured on what circulates (supply less the curve), as the EVM read does.
    expect(top.share).toBe(
      Number((4353328308414n * 1_000_000n) / BigInt(result.data.countedSupply)) / 1_000_000,
    );
    expect(result.data.concentration.top1).toBe(top.share);
    // The creator named on the curve holds none of it any more: read from the full list, no call.
    expect(result.data.creator).toEqual({
      address: 'B7VKZzqyCJCJ12yu4AkVdaTvQjd3TSiUJMtCppGP38xg',
      balance: '0',
      ofSupply: 0,
      share: 0,
      tokenAccounts: 0,
    });
    expect(rpc.calls.map((c) => c.method)).toEqual([
      'getAccountInfo',
      'getTokenLargestAccounts',
      'getProgramAccounts',
      'getProgramAccounts',
      'getProgramAccounts',
      'getMultipleAccounts',
    ]);
  });

  it('asks a Token-2022 mint without a size filter, and samples owners starting with two zero bytes, then one', async () => {
    const { rpc } = await read('pump-curve.json', MINTS.pumpCurve);
    const [coarse, sample, full] = rpc.calls.filter((c) => c.method === 'getProgramAccounts');
    expect(coarse!.params[1]).toEqual({
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { memcmp: { offset: 0, bytes: MINTS.pumpCurve } },
        { memcmp: { offset: 32, bytes: '11' } },
      ],
    });
    expect(decodeBase58('11')).toEqual(Uint8Array.of(0, 0));
    expect(sample!.params[1]).toEqual({
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { memcmp: { offset: 0, bytes: MINTS.pumpCurve } },
        { memcmp: { offset: 32, bytes: '1' } },
      ],
    });
    expect(full!.params[1]).toEqual({
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 32, length: 40 },
      filters: [{ memcmp: { offset: 0, bytes: MINTS.pumpCurve } }],
    });
    expect(decodeBase58('1')).toEqual(Uint8Array.of(0));
  });

  it('takes the mint as already read, without asking for it again', async () => {
    const rpc = publicNode('pump-curve.json');
    const result = await readHolders(MINTS.pumpCurve, rpc, {
      mint: { program: 'token-2022', decimals: 6, supply: '1000000000000000' },
    });
    expect(result.data.holderCount).toBe(13);
    expect(rpc.calls.map((c) => c.method)).not.toContain('getAccountInfo');
  });
});

describe('readHolders names what holds the supply', () => {
  it('Meteora DBC: the curve authority, and a Streamflow escrow found by its contract', async () => {
    const { rpc, result } = await read('meteora-dbc.json', MINTS.meteoraDbc);
    expect(result.completeness).toBe('full');
    expect(result.data.program).toBe('spl-token');
    expect(result.data.holderCount).toBe(66);
    expectWholeList(result, 'meteora-dbc.json');
    expect(result.data.setAside).toEqual([
      {
        address: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
        role: 'curve',
        share: 0.37626,
        name: 'Meteora Dynamic Bonding Curve',
      },
      {
        address: '9SsbKv1hDz7rkAiWrkvpUv2ZyYro37A4iMYSkZZp8qDy',
        role: 'vesting',
        share: 0.031818,
        name: 'Streamflow escrow',
      },
    ]);
    expect(result.data.ofSupply.locked).toBe(0.031818);
    // SPL Token: the size filter is there; the Streamflow contract is looked up by the escrow.
    const programCalls = rpc.calls.filter((c) => c.method === 'getProgramAccounts');
    expect(programCalls).toHaveLength(4);
    for (const probe of programCalls.slice(0, 3)) {
      expect((probe.params[1] as { filters: unknown[] }).filters[0]).toEqual({ dataSize: 165 });
    }
    expect(programCalls[3]!.params[0]).toBe('strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m');
  });

  it('Jupiter Lock escrows and a PumpSwap pool are set aside; an unknown program owner stays a holder', async () => {
    const { result } = await read(
      'jup-lock.json',
      MINTS.jupLock,
      'H1Z5EArHXi1CBPBpkWjCE9uj5ezeFvz3Z7ACtmBwLzZS',
    );
    expect(result.completeness).toBe('full');
    expect(result.data.holderCount).toBe(80);
    expectWholeList(result, 'jup-lock.json');
    const aside = result.data.setAside ?? [];
    expect(aside.filter((a) => a.name === 'Jupiter Lock escrow')).toHaveLength(5);
    expect(aside.find((a) => a.role === 'pool')).toEqual({
      address: 'G5UUUUYjV1MjNXJ6x2AVK6ZtM9MVCD5oyKUZjoxxrz9E',
      role: 'pool',
      share: 0.013374,
      name: 'PumpSwap pool',
    });
    expect(result.data.ofSupply.locked).toBe(0.949667);
    expect(result.data.ofSupply.pools).toBe(0.013374);
    expect(holder(result, 'DfS5qkYy5ndwBo446ziDFFbWur3ouEfkKp5kPi1UVt9n')).toMatchObject({
      kind: 'contract',
      name: 'program account',
      owner: {
        kind: 'program-account',
        program: 'gLHaGJsZ6G7AXZxoDL9EsSWkRbKAWhFHi73gVfNXuzK',
      },
    });
    expect(result.data.creator?.balance).toBe('0');
  });

  it('Raydium AMM v4 and CLMM pools, a Streamflow escrow and an emptied pump.fun curve', async () => {
    const { result } = await read('streamflow.json', MINTS.streamflow);
    expect(result.completeness).toBe('full');
    expect(result.data.holderCount).toBe(108);
    expectWholeList(result, 'streamflow.json');
    expect(result.data.setAside?.map((a) => [a.address, a.role, a.name])).toEqual([
      ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'pool', 'Raydium AMM v4 pool'],
      ['hvJRymHFQrPmjnKxeZHrnd1WQ5KUNm6suhASPiH7UAU', 'vesting', 'Streamflow escrow'],
      ['25DCNCnWv6JaEnyVhStQaQytH3LodVxn8JUEuT6M6VDJ', 'pool', 'Raydium CLMM pool'],
      ['3jdXJxSmRiyuukeMsJmiywYEYoHp1mKXVNt3jmHetUjJ', 'curve', 'pump.fun bonding curve'],
    ]);
    expect(result.data.ofSupply.pools).toBe(0.842245);
    expect(result.data.ofSupply.locked).toBe(0.034857);
  });

  it('the incinerator is burned, a DAMM v2 pool and a DBC curve set aside', async () => {
    const { result } = await read('burn.json', MINTS.burn);
    expect(result.completeness).toBe('full');
    expect(result.data.holderCount).toBe(1041);
    expectWholeList(result, 'burn.json');
    expect(result.data.setAside?.map((a) => [a.address, a.role, a.share])).toEqual([
      ['1nc1nerator11111111111111111111111111111111', 'burn', 0.439611],
      ['HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', 'pool', 0.011794],
      ['FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', 'curve', 0.0004],
    ]);
    expect(result.data.ofSupply.burned).toBe(0.439611);
    // With more than 20 holders, the top lists holders only: what is set aside is in `setAside`.
    expect(result.data.top).toHaveLength(20);
    expect(result.data.top.every((h) => h.kind === 'wallet' || h.kind === 'contract')).toBe(true);
    expect(holder(result, '1nc1nerator11111111111111111111111111111111')).toBeUndefined();
  });

  it('a LaunchLab token still on its curve', async () => {
    const { result } = await read('launchlab.json', MINTS.launchlab);
    expect(result.data).toMatchObject({ method: 'all-accounts', accountsRead: 4, holderCount: 2 });
    expect(result.data.ofSupply.curves).toBe(0.999709);
    expect(result.data.setAside?.[0]?.name).toBe('Raydium LaunchLab bonding curve');
  });
});

describe('readHolders on a node that lists the largest accounts', () => {
  it('fewer than 20 accounts is every account: exact, without reading them all', async () => {
    const rpc = createFakeSolanaRpc(
      loadRecordings('holders', ['launchlab-keyed.json', 'launchlab-largest-derived.json']),
    );
    const result = await readHolders(MINTS.launchlab, rpc, { now: NOW });
    expect(result.completeness).toBe('full');
    expect(result.data).toMatchObject({ method: 'all-accounts', accountsRead: 4, holderCount: 2 });
    expect(result.data.ofSupply.curves).toBe(0.999714);
    expect(rpc.calls.map((c) => c.method)).toEqual([
      'getAccountInfo',
      'getTokenLargestAccounts',
      'getMultipleAccounts',
    ]);
  });

  it('GOAT (76,517 owners): the 20 largest accounts give the top, and the count only as a floor', async () => {
    const rpc = createFakeSolanaRpc(
      loadRecordings('holders', ['many-holders.json', 'many-holders-largest-derived.json']),
    );
    const result = await readHolders(MINTS.goat, rpc, {
      now: NOW,
      creator: 'AMMgF5EQA9sCinwyzRqfgq4tX5gTW6VFqmFxUzfQP4kX',
    });
    expect(result.completeness).toBe('partial');
    expect(result.sources[0]?.note).toContain('only the 20 largest token accounts were read');
    expect(result.data.method).toBe('largest-accounts');
    expect(result.data.holderCount).toBeNull();
    expect(result.data.holdersAtLeast).toBe(19);
    // Read from all 249,244 accounts at the same time (README): the same top.
    expect(result.data.ofSupply).toMatchObject({
      largestWallet: 0.067251,
      top10Wallets: 0.448981,
      pools: 0.050304,
    });
    expect(result.data.setAside).toEqual([
      {
        address: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
        role: 'pool',
        share: 0.050304,
        name: 'Raydium AMM v4 pool',
      },
    ]);
    // The wallet asked about is read on its own accounts, whatever the list.
    expect(result.data.creator).toMatchObject({
      balance: '64834013000000',
      ofSupply: 0.064835,
      tokenAccounts: 1,
    });
    expect(rpc.calls.map((c) => c.method)).toEqual([
      'getAccountInfo',
      'getTokenLargestAccounts',
      'getProgramAccounts',
      'getMultipleAccounts',
      'getMultipleAccounts',
      'getTokenAccountsByOwner',
    ]);
  });
});

describe('readHolders when the list cannot be read', () => {
  it('GOAT on the public node: too many accounts and no largest ones, only the wallet asked about', async () => {
    const { rpc, result } = await read(
      'many-holders.json',
      MINTS.goat,
      'AMMgF5EQA9sCinwyzRqfgq4tX5gTW6VFqmFxUzfQP4kX',
    );
    // 5 owners starting with two zero bytes (×65,536): the 1-in-256 sample
    // (1,020 accounts on 24/11) is not even asked, nor the full read.
    const probes = rpc.calls.filter((c) => c.method === 'getProgramAccounts');
    expect(probes).toHaveLength(1);
    expect((probes[0]!.params[1] as { filters: unknown[] }).filters.at(-1)).toEqual({
      memcmp: { offset: 32, bytes: '11' },
    });
    expect(recordedProbe('many-holders.json', '11')).toBe(5);
    expect(5).toBeGreaterThan(COARSE_SAMPLE_MAX);
    expect(result.completeness).toBe('partial');
    expect(result.data).toMatchObject({
      method: 'none',
      holderCount: null,
      holdersAtLeast: 0,
      top: [],
      pooledShare: null,
    });
    expect(result.data.ofSupply).toEqual({
      largestWallet: null,
      top10Wallets: null,
      pools: null,
      curves: null,
      burned: null,
      locked: null,
    });
    expect(result.data.creator?.balance).toBe('64834013000000');
    expect(result.sources[0]?.note).toContain('too many token accounts to read them all');
    expect(result.sources[0]?.note).toContain('largest token accounts not read');
  });

  it('the real client, refusing the method without asking the node, gives no list either', async () => {
    const fake = createFakeSolanaRpc(loadRecordings('holders', ['many-holders.json']));
    const rpc: SolanaRpc = {
      ...fake,
      getTokenLargestAccounts: () =>
        Promise.reject(new MethodUnavailableError('getTokenLargestAccounts')),
    };
    const result = await readHolders(MINTS.goat, rpc);
    expect(result.completeness).toBe('unavailable');
    expect(result.data.method).toBe('none');
    expect(result.sources[0]?.note).toContain('not served by the configured nodes');
  });

  it('says so when no account lives at the address, or when it is not a mint', async () => {
    const rpc = createFakeSolanaRpc(loadRecordings('holders', ['edge.json']));
    const none = await readHolders('1nc1nerator11111111111111111111111111111111', rpc);
    expect(none.completeness).toBe('unavailable');
    expect(none.sources[0]?.note).toBe('no account at this address');
    const pool = await readHolders('DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB', rpc);
    expect(pool.completeness).toBe('unavailable');
    expect(pool.sources[0]?.note).toBe('not a token mint');
    expect(pool.data.program).toBeNull();
  });

  it('stops at its call allowance and says what it read', async () => {
    const rpc = publicNode('pump-curve.json');
    const result = await readHolders(MINTS.pumpCurve, rpc, { maxCalls: 2 });
    expect(result.completeness).toBe('unavailable');
    expect(result.sources[0]?.note).toContain('call allowance used up');
    expect(rpc.calls).toHaveLength(2);
  });

  it('stops at its time allowance', async () => {
    const fake = publicNode('pump-curve.json');
    const rpc: SolanaRpc = { ...fake, getProgramAccounts: () => new Promise(() => {}) };
    const result = await readHolders(MINTS.pumpCurve, rpc, { timeoutMs: 30 });
    expect(result.completeness).toBe('unavailable');
    expect(result.sources[0]?.note).toContain('time allowance used up');
  });

  it('lets a programming error through instead of calling it a source failure', async () => {
    const rpc = createFakeSolanaRpc([]);
    await expect(readHolders(MINTS.pumpCurve, rpc)).rejects.toThrow(/no recording/);
  });

  it('a token between the two samples: few owners start with two zero bytes, too many with one', async () => {
    // ZEREBRO, 25/11/2026: 1 owner in 65,536 (≤ 3), then 698 in 256 (≈ 178,688 accounts).
    const { rpc, result } = await read('mid-holders.json', MINTS.mid);
    expect(recordedProbe('mid-holders.json', '11')).toBeLessThanOrEqual(COARSE_SAMPLE_MAX);
    expect(recordedProbe('mid-holders.json', '1') * SAMPLE_RATIO).toBeGreaterThan(
      FULL_READ_MAX_ACCOUNTS,
    );
    // Both samples asked, never the full read.
    expect(rpc.calls.filter((c) => c.method === 'getProgramAccounts')).toHaveLength(2);
    expect(result.completeness).toBe('unavailable');
    expect(result.data.method).toBe('none');
    expect(result.data.program).toBe('spl-token');
    expect(result.sources[0]?.note).toContain('too many token accounts to read them all');
  });

  it('asks nothing for a string that is not a Solana address (addresses are case-sensitive)', async () => {
    for (const bad of ['notAnAddress0OIl', MINTS.pumpCurve.toLowerCase(), '']) {
      const rpc = createFakeSolanaRpc([]);
      const result = await readHolders(bad, rpc);
      expect(result.completeness).toBe('unavailable');
      expect(result.sources[0]?.note).toBe('not a Solana address');
      expect(rpc.calls).toHaveLength(0);
    }
  });

  it('does not report a balance for a creator that is not a Solana address', async () => {
    const { rpc, result } = await read('pump-curve.json', MINTS.pumpCurve, 'not-a-wallet');
    expect(result.completeness).toBe('partial');
    expect(result.data.creator).toBeUndefined();
    expect(result.data.holderCount).toBe(13);
    expect(result.sources[0]?.note).toBe("creator's balance not read (not a Solana address)");
    expect(rpc.calls.map((c) => c.method)).not.toContain('getTokenAccountsByOwner');
  });
});

describe('readHolders when owners cannot all be named', () => {
  it('an owner whose account was not read makes the count a floor, not an exact figure', async () => {
    const fake = publicNode('meteora-dbc.json');
    const rpc: SolanaRpc = {
      ...fake,
      // The owners' lookup (base64, first 64 bytes) fails; the rest answers.
      getMultipleAccounts: (addresses, options) =>
        options?.encoding === 'base64'
          ? Promise.reject(new UpstreamError('solana-rpc', 'getMultipleAccounts: node down'))
          : fake.getMultipleAccounts(addresses, options),
    };
    const result = await readHolders(MINTS.meteoraDbc, rpc, { now: NOW });
    expect(result.completeness).toBe('partial');
    expect(result.sources[0]?.note).toContain('program owners not looked up');
    // The Streamflow escrow (3.18 %) is no longer known to be one: it may be a holder or not.
    expect(result.data.holderCount).toBeNull();
    expect(result.data.holdersAtLeast).toBe(66);
    expect(holder(result, '9SsbKv1hDz7rkAiWrkvpUv2ZyYro37A4iMYSkZZp8qDy')).toMatchObject({
      kind: 'contract',
      owner: {
        kind: 'program-account',
        evidence: 'off the ed25519 curve; its account was not read in this read',
      },
    });
    // The DBC authority needs no account: still set aside.
    expect(result.data.setAside?.map((a) => a.name)).toEqual(['Meteora Dynamic Bonding Curve']);
  });

  it('looks up only as many owners as the calls left allow, and says so', async () => {
    const rpc = publicNode('jup-lock.json');
    // Mint, largest accounts (refused), two samples, the full read: nothing left.
    const result = await readHolders(MINTS.jupLock, rpc, { now: NOW, maxCalls: 5, topN: 1_000 });
    expect(rpc.calls.map((c) => c.method)).not.toContain('getMultipleAccounts');
    expect(result.completeness).toBe('partial');
    expect(result.sources[0]?.note).toContain(
      'off-curve owners not looked up (call allowance used up)',
    );
    expect(result.data.holderCount).toBeNull();
    expect(result.data.holdersAtLeast).toBe(
      result.data.top.filter((h) => h.kind === 'wallet').length,
    );
    expect(result.data.ofSupply.locked).toBe(0);
  });

  it('a method the client refuses without asking a node costs no call', async () => {
    const fake = publicNode('pump-curve.json');
    const rpc: SolanaRpc = {
      ...fake,
      getTokenLargestAccounts: () =>
        Promise.reject(new MethodUnavailableError('getTokenLargestAccounts')),
    };
    // Mint, two samples, the full read, the owners: exactly 5.
    const result = await readHolders(MINTS.pumpCurve, rpc, { now: NOW, maxCalls: 5 });
    expect(result.completeness).toBe('full');
    expect(result.data.holderCount).toBe(13);
  });
});
