import { describe, expect, it } from 'vitest';
import { decodeBase58, isOnCurve } from '../../src/lib/solana/address';
import {
  FLUXBEAM_PROGRAM,
  INCINERATOR,
  JUPITER_LOCK_PROGRAM,
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DBC_PROGRAM,
  METEORA_DLMM_PROGRAM,
  METEORA_VAULT_PROGRAM,
  NATIVE_MINT,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_FUN_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_LAUNCHLAB_PROGRAM,
  TOKEN_PROGRAM,
} from '../../src/lib/solana/programs';
import {
  anchorDiscriminator,
  isSelfOwnedTokenAccount,
  poolAuthorities,
  roleFromAccount,
  roleWithoutAccount,
  TOKEN_SWAP_POOL_SIZE,
  tokenSwapAuthority,
} from '../../src/lib/solana/roles';
import { accountBytes, parsedAccount, type AccountInfo } from '../../src/lib/solana/rpc';
import { fakeRpcFor } from './fixtures';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/**
 * Pools read on mainnet on 24/11/2026 (DexScreener lists each under its
 * venue): the pool account, and one of its vaults, a token account. The
 * offset is where the pool account holds the vault's address.
 */
const POOLS = [
  {
    venue: 'Raydium AMM v4 pool',
    program: RAYDIUM_AMM_V4_PROGRAM,
    pool: 'G7mw1d83ismcQJKkzt62Ug4noXCjVhu3eV7U5EMgge6Z',
    vault: 'B4kvik9yEXTJ1UScDUqTxfvhnHUkfChv5pF6zNSyEraQ',
    at: 336,
    by: 'authority',
  },
  {
    venue: 'Raydium CPMM pool',
    program: RAYDIUM_CPMM_PROGRAM,
    pool: '5hinZuqbN8Va93CMWSHZJBAUKdgN99FXAD2g3spnHy7N',
    vault: 'A3xbHH2X6UGPvgzYqP8aV73wTHCzTDqFzGfxPW67p8a1',
    at: 104,
    by: 'authority',
  },
  {
    venue: 'Raydium LaunchLab bonding curve',
    program: RAYDIUM_LAUNCHLAB_PROGRAM,
    pool: 'E4C8zuDzH6SubW9WcQeWQbZbwwKhAsfGb9niYnoL5fbq',
    vault: '3YEHEbG2LAwSAj7VLzYYf7AtMNoFkjygG39DVWJaZn5j',
    at: 269,
    by: 'authority',
  },
  {
    venue: 'Meteora DAMM v2 pool',
    program: METEORA_DAMM_V2_PROGRAM,
    pool: 'EyQ8pseyktXRxMXYm1nHMvHS6zRJyYVk2kkw2uCM69V8',
    vault: 'HYahpco3rWBUrTSMFkc3EZJvbBdeNZKpmNwHCGjiYBV5',
    at: 264,
    by: 'authority',
  },
  {
    venue: 'Meteora Dynamic Bonding Curve',
    program: METEORA_DBC_PROGRAM,
    pool: 'DbdgjtiiRBWY2C3F3cLssjgfaFQXkRWuoHjduEvexJ9f',
    vault: 'FDygJSer6JV3GfB2UFVeSG1VSFBB6o4rKLYRJ74wsyjN',
    at: 168,
    by: 'authority',
  },
  {
    venue: 'Orca Whirlpool pool',
    program: ORCA_WHIRLPOOL_PROGRAM,
    pool: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
    vault: '4dmvFGeQH2eqa3ktNHMgm4wZ8vuTukBiK9M7gxW5oR9F',
    at: 213,
    by: 'pool',
  },
  {
    venue: 'Meteora DLMM pool',
    program: METEORA_DLMM_PROGRAM,
    pool: '31p1hptjhFo6ZD8oBqkfutNXQKGGPyi7YcEAfsyKW777',
    vault: 'GdRr8u8c5deY6Sn22DLoCY6wNteb3vNTRUrJjbpf7dQf',
    at: 152,
    by: 'pool',
  },
  {
    venue: 'Raydium CLMM pool',
    program: RAYDIUM_CLMM_PROGRAM,
    pool: 'GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN',
    vault: '2wzaFLYb4JcDrVs8TfU3TfkVwq1Pdp3rRgWdNJzFGXud',
    at: 169,
    by: 'pool',
  },
  {
    venue: 'PumpSwap pool',
    program: PUMP_SWAP_PROGRAM,
    pool: 'DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB',
    vault: '33J8AEXc7aFsnNoEU8wr2qNtNGQKXzRYXaZkAM54vuN3',
    at: 139,
    by: 'pool',
  },
  {
    // The vault BONK/SOL pool 278P6iwd… (Meteora DAMM v1) names at byte 104
    // for its BONK side: the pool's BONK sits in this vault's token account.
    venue: 'Meteora Dynamic Vault',
    program: METEORA_VAULT_PROGRAM,
    pool: 'J9K67PxqqvCRW9tiDHB9bAisgNQSMLU1bvExtexyd7Ve',
    vault: '66i1ucUah4Qi1sv4KhdonGRsGGr7zmGPeMC3eSzR8Bix',
    at: 19,
    by: 'pool',
  },
] as const;

describe('pool roles, checked on real pools', () => {
  const rpc = fakeRpcFor('holders', ['pools.json']);

  for (const p of POOLS) {
    it(`${p.venue}: the pool holds its vault's address, and the vault's owner is recognised`, async () => {
      const pool = (await rpc.getAccountInfo(p.pool)) as AccountInfo;
      expect(pool.owner).toBe(p.program);
      const bytes = accountBytes(pool) as Uint8Array;
      expect(hex(bytes.subarray(p.at, p.at + 32))).toBe(hex(decodeBase58(p.vault)));

      const vault = (await rpc.getAccountInfo(p.vault, { encoding: 'jsonParsed' })) as AccountInfo;
      const owner = (parsedAccount(vault)?.parsed as { info: { owner: string; mint: string } })
        .info;
      expect(isOnCurve(owner.owner)).toBe(false);

      if (p.by === 'pool') {
        // The vault belongs to the pool itself: recognised by program and account type.
        expect(owner.owner).toBe(p.pool);
        const role = roleFromAccount(owner.owner, owner.mint, {
          owner: pool.owner,
          head: bytes.subarray(0, 64),
        });
        expect(role).toMatchObject({ kind: 'pool', name: p.venue, program: p.program });
        // Without the account, nothing is said.
        expect(roleWithoutAccount(owner.owner)).toBeUndefined();
      } else {
        // The vault belongs to the venue's authority, derived from the program's seed.
        expect(poolAuthorities().get(owner.owner)?.program).toBe(p.program);
        expect(roleWithoutAccount(owner.owner)).toMatchObject({
          name: p.venue,
          program: p.program,
        });
      }
    });
  }

  it('derives the five authorities', () => {
    expect([...poolAuthorities()].map(([address, a]) => [address, a.program, a.kind])).toEqual([
      ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', RAYDIUM_AMM_V4_PROGRAM, 'pool'],
      ['GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', RAYDIUM_CPMM_PROGRAM, 'pool'],
      ['WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', RAYDIUM_LAUNCHLAB_PROGRAM, 'curve'],
      ['HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', METEORA_DAMM_V2_PROGRAM, 'pool'],
      ['FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', METEORA_DBC_PROGRAM, 'curve'],
    ]);
  });
});

describe('roles from the owner itself', () => {
  it('the incinerator burns; a key on the curve is a wallet', () => {
    expect(roleWithoutAccount(INCINERATOR)?.kind).toBe('burn');
    expect(roleWithoutAccount('EqDxcwrZMNYBSySXu3NbhwPtHAx4pPkkCQ4n5H4cfJdc')?.kind).toBe('wallet');
  });

  it('the Anchor discriminators are those read on the accounts', () => {
    expect(hex(anchorDiscriminator('BondingCurve'))).toBe('17b7f83760d8ac60');
    expect(hex(anchorDiscriminator('Pool'))).toBe('f19a6d0411b16dbc');
    expect(hex(anchorDiscriminator('PoolState'))).toBe('f7ede3f5d7c3de46');
    expect(hex(anchorDiscriminator('Whirlpool'))).toBe('3f95d10ce1806309');
    expect(hex(anchorDiscriminator('LbPair'))).toBe('210b3162b565b10d');
    expect(hex(anchorDiscriminator('VestingEscrow'))).toBe('f477b704497487c3');
    expect(hex(anchorDiscriminator('Vault'))).toBe('d308e82b02987577');
  });

  it('a pump.fun curve is the curve only of its own mint', () => {
    const head = new Uint8Array(64);
    head.set(anchorDiscriminator('BondingCurve'));
    const curve = '8j8apXSGYWc9m9XySAADCYmUzhetFzs2ZMoj36opQ8YA';
    const account = { owner: PUMP_FUN_PROGRAM, head };
    expect(
      roleFromAccount(curve, 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump', account).kind,
    ).toBe('curve');
    expect(
      roleFromAccount(curve, '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx', account),
    ).toMatchObject({
      kind: 'program-account',
      name: 'pump.fun program account',
    });
  });

  it('a lock program account of another type is not a lock', () => {
    const head = new Uint8Array(64);
    head.set(anchorDiscriminator('Pool'));
    expect(
      roleFromAccount('EBqzUQPBDcKhXNUGgdVviyJR2bEjkPFjiFLqrArXpZha', 'x', {
        owner: JUPITER_LOCK_PROGRAM,
        head,
      }).kind,
    ).toBe('program-account');
  });

  it('a Streamflow escrow needs its contract to name the mint', () => {
    const escrow = 'hvJRymHFQrPmjnKxeZHrnd1WQ5KUNm6suhASPiH7UAU';
    const head = new Uint8Array(64);
    head.set(decodeBase58(escrow), 32);
    const account = { owner: TOKEN_PROGRAM, head };
    expect(isSelfOwnedTokenAccount(escrow, account)).toBe(true);
    const mint = '4iNowernM7VnmA79FyedcUGnM22GMm2keEtwbaJepump';
    expect(roleFromAccount(escrow, mint, account, mint).kind).toBe('lock');
    expect(roleFromAccount(escrow, mint, account, null).kind).toBe('program-account');
    expect(roleFromAccount(escrow, mint, account, 'another').kind).toBe('program-account');
  });

  it('an address with no account is a program account, never guessed', () => {
    expect(
      roleFromAccount('Bo8VDWw7UPMbtAX3rauZc4kfM7rPTnmvwasvaZbNRA4d', 'x', null),
    ).toMatchObject({
      kind: 'program-account',
      name: 'program account',
    });
  });
});

describe('token-swap pools, whose vaults belong to an address with no account', () => {
  const rpc = fakeRpcFor('holders', ['pools.json']);
  // BERN, and the FluxBeam pool DexScreener lists as its main pair (25/11/2026).
  const BERN = 'CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo';
  const POOL = 'Ebbpz3PWLaQxj2oyK967RgEPbcPypjQCoZ3tpB4fwLsk';
  const VAULT = 'Ft1URsGGW7phzUQWwoDL3ijBuBAE46M2AiPguZKLXUWN';
  const AUTHORITY = 'GZHYAsikiCAAeMzJ6wX2oUx8Z9eh78wKUA9WyabB53tB';

  it('FluxBeam: the pool names its BERN vault, whose owner is the address derived from the pool', async () => {
    const pool = (await rpc.getAccountInfo(POOL)) as AccountInfo;
    expect(pool.owner).toBe(FLUXBEAM_PROGRAM);
    const data = accountBytes(pool) as Uint8Array;
    expect(data.length).toBe(TOKEN_SWAP_POOL_SIZE);
    expect(hex(data.subarray(35, 67))).toBe(hex(decodeBase58(VAULT)));

    const vault = (await rpc.getAccountInfo(VAULT, { encoding: 'jsonParsed' })) as AccountInfo;
    const info = (parsedAccount(vault)?.parsed as { info: { owner: string; mint: string } }).info;
    expect(info).toMatchObject({ owner: AUTHORITY, mint: BERN });
    // No account lives at the owner: on its own it says nothing more.
    expect(roleFromAccount(AUTHORITY, BERN, null).kind).toBe('program-account');

    // Read with its pool, it is the pool's.
    expect(tokenSwapAuthority({ address: POOL, program: pool.owner, data }, BERN)).toEqual({
      authority: AUTHORITY,
      vault: VAULT,
      role: {
        kind: 'pool',
        name: 'FluxBeam pool',
        program: FLUXBEAM_PROGRAM,
        evidence: `owner of vault ${VAULT}, which FluxBeam pool ${POOL} names at byte 35; derived from the pool's address`,
      },
    });
    // Its other side, wrapped SOL, has its own vault under the same authority.
    expect(
      tokenSwapAuthority({ address: POOL, program: pool.owner, data }, NATIVE_MINT),
    ).toMatchObject({
      authority: AUTHORITY,
      vault: 'DNbwqtq4iKBmnjxGpjw6c1RHfukdeLSnq2LVTfQtAguL',
    });
  });

  it('says nothing for another mint, another program, or a pool cut short', async () => {
    const pool = (await rpc.getAccountInfo(POOL)) as AccountInfo;
    const data = accountBytes(pool) as Uint8Array;
    const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    expect(tokenSwapAuthority({ address: POOL, program: FLUXBEAM_PROGRAM, data }, BONK)).toBeNull();
    expect(
      tokenSwapAuthority({ address: POOL, program: METEORA_DAMM_V1_PROGRAM, data }, BERN),
    ).toBeNull();
    expect(
      tokenSwapAuthority(
        { address: POOL, program: FLUXBEAM_PROGRAM, data: data.subarray(0, 100) },
        BERN,
      ),
    ).toBeNull();
    // The owner comes from the pool's own address: read under another, it is another address.
    expect(
      tokenSwapAuthority(
        {
          address: 'J9K67PxqqvCRW9tiDHB9bAisgNQSMLU1bvExtexyd7Ve',
          program: FLUXBEAM_PROGRAM,
          data,
        },
        BERN,
      )?.authority,
    ).not.toBe(AUTHORITY);
  });
});
