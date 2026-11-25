import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DexScreenerPair } from '../../src/lib/market';
import { solanaListedPools } from '../../src/lib/market/solana';
import {
  SOLANA_LAUNCHPADS,
  creationInstruction,
  findLaunchAccount,
  launchFromTransaction,
  launchLabPoolAddress,
  launchpadOfAccount,
  readSolanaLaunch,
} from '../../src/lib/solana/launchpads';
import {
  METEORA_DBC_PROGRAM,
  PUMP_FUN_PROGRAM,
  RAYDIUM_LAUNCHLAB_PROGRAM,
  knownProgram,
  pumpBondingCurveAddress,
} from '../../src/lib/solana/programs';
import type { AccountInfo, SolanaTransaction } from '../../src/lib/solana/rpc';
import { SOLANA_FIXTURES, fakeRpcFor, loadRecordings } from './fixtures';

/**
 * Which launchpad a token came from, on accounts and transactions recorded
 * on mainnet on 24-25/11/2026 (tests/fixtures/solana/market/, reference/).
 */

const at = () => new Date('2026-11-25T00:00:00.000Z');

/** The hints the zone passes: the token's listed pools, as recorded. */
function hintsOf(slug: string, mint: string): string[] {
  const pairs = JSON.parse(
    readFileSync(join(SOLANA_FIXTURES, 'market', 'dexscreener', `${slug}.json`), 'utf8'),
  ) as DexScreenerPair[];
  return solanaListedPools(mint, pairs).map((p) => p.id);
}

function transaction(zone: string, file: string, signature: string): SolanaTransaction {
  const entry = loadRecordings(zone, [file]).find(
    (e) => e.method === 'getTransaction' && (e.params?.[0] as string) === signature,
  );
  if (!entry?.result) throw new Error(`no transaction ${signature} in ${zone}/${file}`);
  return entry.result as SolanaTransaction;
}

/** The first account answer recorded for an address, in any multi or single read. */
function recordedAccount(file: string, address: string): AccountInfo {
  for (const e of loadRecordings('market', [file])) {
    if (e.method === 'getMultipleAccounts') {
      const keys = e.params?.[0] as string[];
      const i = keys.indexOf(address);
      const value = (e.result as { value: (AccountInfo | null)[] }).value[i];
      if (i >= 0 && value) return value;
    }
    if (e.method === 'getProgramAccounts') {
      const hit = (e.result as { pubkey: string; account: AccountInfo }[]).find(
        (a) => a.pubkey === address,
      );
      if (hit) return hit.account;
    }
  }
  throw new Error(`no account ${address} in ${file}`);
}

describe('the launchpads', () => {
  it('are the programs checked executable on mainnet', () => {
    expect(SOLANA_LAUNCHPADS.map((l) => [l.id, knownProgram(l.program)?.kind])).toEqual([
      ['pump.fun', 'launchpad'],
      ['meteora-dbc', 'launchpad'],
      ['raydium-launchlab', 'launchpad'],
    ]);
  });

  it('LaunchLab pool: seeds ["pool", mint, quote], as the creation transaction names it', () => {
    // 2hDbZUkt… created FnYLY1FQ… against Xsc9qvGR…, its pool_state BYa8uA3e….
    expect(
      launchLabPoolAddress(
        'FnYLY1FQqbfNiMdDpedMPwpKWdM8RtAkwWBvWYNAwq4T',
        'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
      ),
    ).toBe('BYa8uA3enWj8QfxhQsgxwRYgF8yt89yauE6RpQVPTgWR');
    expect(launchLabPoolAddress('B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk')).toBe(
      '8pDPWkN9ThmR6P9nqHBHftrGw3AbRAwHb1J1dU11XW6y',
    );
  });
});

describe('findLaunchAccount', () => {
  const cases = [
    [
      'pump-curve-xmr',
      'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump',
      'pump.fun',
      '8j8apXSGYWc9m9XySAADCYmUzhetFzs2ZMoj36opQ8YA',
      1,
    ],
    [
      'pump-raydium-era',
      'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
      'pump.fun',
      '5JH9u8yJ9WBcH8PfoMLxo6JKafJ1J44n3zQqGz9Ti5ET',
      1,
    ],
    [
      'dbc-curve',
      '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx',
      'meteora-dbc',
      'DbdgjtiiRBWY2C3F3cLssjgfaFQXkRWuoHjduEvexJ9f',
      1,
    ],
    [
      'dbc-migrated-sol',
      '8X6SyaSgYdPfmZTc1B7Kc7YytMwUYJVTWXgSxJWMBAGS',
      'meteora-dbc',
      'CxCuu9t9eB9K8PqEbCEZZrCepy4pi2fjZJCkqVn3Goao',
      2,
    ],
    [
      'launchlab-cpmm',
      'B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk',
      'raydium-launchlab',
      '8pDPWkN9ThmR6P9nqHBHftrGw3AbRAwHb1J1dU11XW6y',
      1,
    ],
    [
      'launchlab-curve',
      'FnYLY1FQqbfNiMdDpedMPwpKWdM8RtAkwWBvWYNAwq4T',
      'raydium-launchlab',
      'BYa8uA3enWj8QfxhQsgxwRYgF8yt89yauE6RpQVPTgWR',
      3,
    ],
  ] as const;

  for (const [slug, mint, launchpad, account, calls] of cases) {
    it(`${slug}: ${launchpad}, account ${account.slice(0, 8)}…, ${calls} call(s)`, async () => {
      const rpc = fakeRpcFor('market', [`${slug}.json`]);
      const found = await findLaunchAccount(rpc, mint, { hints: hintsOf(slug, mint) });
      expect(found?.launchpad).toBe(launchpad);
      expect(found?.address).toBe(account);
      expect(rpc.calls.length).toBe(calls);
    });
  }

  it('the DBC pool listed by DexScreener is found from the hint, without a program scan', async () => {
    const rpc = fakeRpcFor('market', ['dbc-curve.json']);
    const found = await findLaunchAccount(rpc, '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx', {
      hints: ['DbdgjtiiRBWY2C3F3cLssjgfaFQXkRWuoHjduEvexJ9f'],
    });
    expect(found?.launchpad).toBe('meteora-dbc');
    expect(rpc.calls.map((c) => c.method)).toEqual(['getMultipleAccounts']);
  });

  it('RAY: no launchpad, after both program scans', async () => {
    const rpc = fakeRpcFor('market', ['ray.json']);
    const found = await findLaunchAccount(rpc, '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', {
      hints: hintsOf('ray', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'),
    });
    expect(found).toBeNull();
    expect(rpc.calls.map((c) => c.method)).toEqual([
      'getMultipleAccounts',
      'getProgramAccounts',
      'getProgramAccounts',
    ]);
  });
});

describe('launchpadOfAccount: owner, discriminator and mint must agree', () => {
  const curve = recordedAccount(
    'pump-curve-sol.json',
    'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2',
  );
  const dbc = recordedAccount(
    'dbc-migrated-sol.json',
    'CxCuu9t9eB9K8PqEbCEZZrCepy4pi2fjZJCkqVn3Goao',
  );
  const pumpMint = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
  const dbcMint = '8X6SyaSgYdPfmZTc1B7Kc7YytMwUYJVTWXgSxJWMBAGS';

  it('accepts the real accounts', () => {
    expect(pumpBondingCurveAddress(pumpMint)).toBe('NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2');
    expect(launchpadOfAccount(pumpMint, 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2', curve)).toBe(
      'pump.fun',
    );
    expect(launchpadOfAccount(dbcMint, 'CxCuu9t9eB9K8PqEbCEZZrCepy4pi2fjZJCkqVn3Goao', dbc)).toBe(
      'meteora-dbc',
    );
  });

  it('refuses a curve at another address than the mint derives, a pool of another mint, another owner', () => {
    expect(
      launchpadOfAccount(dbcMint, 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2', curve),
    ).toBeNull();
    expect(
      launchpadOfAccount(pumpMint, 'CxCuu9t9eB9K8PqEbCEZZrCepy4pi2fjZJCkqVn3Goao', dbc),
    ).toBeNull();
    expect(
      launchpadOfAccount(dbcMint, 'CxCuu9t9eB9K8PqEbCEZZrCepy4pi2fjZJCkqVn3Goao', {
        ...dbc,
        owner: RAYDIUM_LAUNCHLAB_PROGRAM,
      }),
    ).toBeNull();
    expect(
      launchpadOfAccount(pumpMint, 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2', {
        ...curve,
        owner: METEORA_DBC_PROGRAM,
      }),
    ).toBeNull();
    expect(launchpadOfAccount(pumpMint, 'x', null)).toBeNull();
    expect(
      launchpadOfAccount(pumpMint, 'x', {
        owner: PUMP_FUN_PROGRAM,
        data: { program: 'x', parsed: {}, space: 0 },
      }),
    ).toBeNull();
  });
});

describe('readSolanaLaunch', () => {
  it('names the launchpad and the account, from the curve', async () => {
    const launch = await readSolanaLaunch(
      fakeRpcFor('market', ['pump-curve-sol.json']),
      'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump',
      { now: at },
    );
    expect(launch).toEqual({
      completeness: 'full',
      sources: [{ name: 'solana-rpc', fetchedAt: '2026-11-25T00:00:00.000Z' }],
      data: {
        mint: 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump',
        launchpad: { id: 'pump.fun', name: 'pump.fun', program: PUMP_FUN_PROGRAM },
        account: 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2',
        foundBy: 'curve-account',
      },
    });
  });
});

describe('creationInstruction, from the token’s first transaction', () => {
  it('pump.fun create_v2 (reference pump-curve, legacy-version v0 transaction)', () => {
    const tx = transaction(
      'reference',
      'pump-curve.json',
      '2bp2ZKVjB9Zw9NWGNkAkXwGEMv13ecd4Hd1EMPDFtw3S51eCtsHjzLoFjxyycppzacmvmjjsv8uF53dxYEmWetv6',
    );
    expect(creationInstruction(tx, 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump')).toEqual({
      launchpad: { id: 'pump.fun', name: 'pump.fun', program: PUMP_FUN_PROGRAM },
      instruction: 'create_v2',
      inner: false,
    });
  });

  it('Meteora DBC initialize_virtual_pool_with_spl_token', () => {
    const tx = transaction(
      'market',
      'creations.json',
      'iHeYqyqcsa9mqRQeeADaYsd59eZSM96dBsVEc8tTgW9AzuXtGz9iEY9ZXne3Heu7gNz7hjXD4TSb3RL4Hhp5d4u',
    );
    expect(creationInstruction(tx, '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx')).toMatchObject({
      launchpad: { id: 'meteora-dbc' },
      instruction: 'initialize_virtual_pool_with_spl_token',
    });
  });

  it('Raydium LaunchLab initialize_with_token_2022, a version-1 transaction', () => {
    const tx = transaction(
      'market',
      'creations.json',
      '2hDbZUktNzqzqWoXLd2ktTAwwid5HmFiUBrDNaRiqAaGWGHX2kDRzsc7F2BXGt9W5rfgYNvvj9gtGNFJq5oTkepU',
    );
    expect(tx.version).toBe(1);
    expect(creationInstruction(tx, 'FnYLY1FQqbfNiMdDpedMPwpKWdM8RtAkwWBvWYNAwq4T')).toMatchObject({
      launchpad: { id: 'raydium-launchlab' },
      instruction: 'initialize_with_token_2022',
    });
  });

  it('a transaction that trades the token but did not create it: none (the buy beside create_v2 is not a creation)', () => {
    const tx = transaction(
      'reference',
      'pump-curve.json',
      '2bp2ZKVjB9Zw9NWGNkAkXwGEMv13ecd4Hd1EMPDFtw3S51eCtsHjzLoFjxyycppzacmvmjjsv8uF53dxYEmWetv6',
    );
    // Another mint: the create instruction does not name it.
    expect(creationInstruction(tx, 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump')).toBeNull();
    const launch = launchFromTransaction(tx, 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump', {
      now: at,
    });
    expect(launch.data.launchpad).toBeNull();
    expect(launch.sources[0]?.note).toMatch(/none of the launchpads/);
  });

  it('launchFromTransaction reports how it was found', () => {
    const tx = transaction(
      'market',
      'creations.json',
      'iHeYqyqcsa9mqRQeeADaYsd59eZSM96dBsVEc8tTgW9AzuXtGz9iEY9ZXne3Heu7gNz7hjXD4TSb3RL4Hhp5d4u',
    );
    const launch = launchFromTransaction(tx, '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx', {
      now: at,
    });
    expect(launch.data).toMatchObject({
      foundBy: 'creation-transaction',
      launchpad: { id: 'meteora-dbc' },
      account: null,
    });
    // A failed transaction created nothing.
    const failed = {
      ...tx,
      meta: {
        ...(tx.meta as NonNullable<SolanaTransaction['meta']>),
        err: { InstructionError: [0, 'Custom'] },
      },
    };
    expect(
      launchFromTransaction(failed, '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx').data.launchpad,
    ).toBeNull();
  });
});
