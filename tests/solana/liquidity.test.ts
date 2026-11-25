import { describe, expect, it } from 'vitest';
import { RateLimitError } from '../../src/lib/errors';
import { BudgetExhaustedError } from '../../src/lib/http';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import {
  MAX_LIQUIDITY_POOLS,
  RAYDIUM_LOCK_CP_AUTHORITY,
  lpLockAccounts,
  readSolanaLiquidity,
} from '../../src/lib/solana/liquidity';
import { TOKEN_PROGRAM } from '../../src/lib/solana/programs';
import type { SolanaRpc } from '../../src/lib/solana/rpc';
import { fakeRpcFor, loadRecordings } from './fixtures';

/**
 * What became of a pool's liquidity, one kind of pool after another, each on
 * a real pool recorded on mainnet on 24-25/11/2026
 * (tests/fixtures/solana/market/). The recordings come from the public
 * node, which does not serve getTokenLargestAccounts: LP holders are not
 * listed there, and the read says so.
 */

const at = () => new Date('2026-11-25T00:00:00.000Z');

/** The pools the zone asked for, as recorded: the second getMultipleAccounts (base64) of the file. */
function recordedPools(file: string): string[] {
  const reads = loadRecordings('market', [file]).filter(
    (e) =>
      e.method === 'getMultipleAccounts' &&
      (e.params?.[1] as { encoding: string }).encoding === 'base64',
  );
  return reads[reads.length - 1]?.params?.[0] as string[];
}

async function liquidity(slug: string, mint: string) {
  const rpc = fakeRpcFor('market', [`${slug}.json`]);
  const read = await readSolanaLiquidity(rpc, mint, recordedPools(`${slug}.json`), { now: at });
  return { read, rpc };
}

describe('derived lock accounts', () => {
  it('Raydium Burn & Earn: ["lock_cp_authority_seed"], its LP vault the authority’s ATA', () => {
    expect(RAYDIUM_LOCK_CP_AUTHORITY).toBe('3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH');
    // The locked LP of B4aJyVCi…'s CPMM pool sits in DK2d2pye… (read).
    expect(lpLockAccounts('GmSHP7BqKKTqXpmPKddmqheTYbsnx2nu5BLgKaYaVCbE', TOKEN_PROGRAM).lock).toBe(
      'DK2d2pye9qgRZNp32orJqLg8mFVfsfm1TaX3Fei477KT',
    );
  });
});

describe('LP-token pools', () => {
  it('PumpSwap (pump.fun graduate): every LP token burned', async () => {
    const { read } = await liquidity(
      'pump-graduated',
      'B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump',
    );
    expect(read.data.pools[0]).toEqual({
      pool: 'DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB',
      program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      kind: 'pumpswap',
      programName: 'PumpSwap',
      known: true,
      burnedShare: 1,
      lockedShare: 0,
      withdrawableShare: 0,
      holders: [],
      holdersCount: null,
      note: null,
    });
  });

  it('Raydium CPMM (LaunchLab graduate): part burned, the rest locked in Burn & Earn', async () => {
    const { read } = await liquidity(
      'launchlab-cpmm',
      'B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk',
    );
    const [cpmm] = read.data.pools;
    expect(cpmm).toMatchObject({
      kind: 'raydium-cpmm',
      known: true,
      withdrawableShare: 0,
      holders: [],
      note: null,
    });
    expect(cpmm?.burnedShare).toBeCloseTo(0.731941415, 8);
    expect(cpmm?.lockedShare).toBeCloseTo(0.268058584, 8);
    expect((cpmm?.burnedShare ?? 0) + (cpmm?.lockedShare ?? 0)).toBeCloseTo(1, 6);
  });

  it('Raydium AMM v4 (LaunchLab graduate): nearly all burned, the rest withdrawable', async () => {
    const { read } = await liquidity(
      'launchlab-amm',
      'CDBdbNqmrLu1PcgjrFG52yxg71QnFhBZcUE6PSFdbonk',
    );
    const [amm] = read.data.pools;
    expect(amm?.kind).toBe('raydium-amm-v4');
    expect(amm?.burnedShare).toBeCloseTo(0.999735771, 8);
    expect(amm?.withdrawableShare).toBeCloseTo(0.000263321, 8);
    expect(amm?.lockedShare).toBe(0);
    expect(amm?.note).toMatch(/getTokenLargestAccounts/);
  });

  it('Raydium AMM v4 of an old pump.fun graduate (GOAT, 2024): 99.7 % burned', async () => {
    const { read } = await liquidity(
      'pump-raydium-era',
      'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
    );
    expect(read.data.pools[0]?.burnedShare).toBeCloseTo(0.996657243, 8);
  });

  it('a long-standing pool (RAY/USDC): LP in holders’ hands, nearly none burned', async () => {
    const { read } = await liquidity('ray', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R');
    expect(read.data.pools[0]?.withdrawableShare).toBeGreaterThan(0.99);
    expect(read.data.pools[0]?.burnedShare).toBeLessThan(0.01);
  });

  it('with a node that lists the largest LP accounts, the holders and their owners', async () => {
    // getTokenLargestAccounts is not served by the public node: its answer
    // here is what getProgramAccounts (SPL Token, memcmp on the LP mint)
    // read on 24/11/2026, one account holding the whole supply. The owner
    // lookup is a recorded answer (largest-owner.json).
    const base = fakeRpcFor('market', ['launchlab-amm.json', 'largest-owner.json']);
    const rpc: SolanaRpc = {
      ...base,
      getTokenLargestAccounts: async () => [
        {
          address: 'FGHBr5hqjPRbAEX4oVA6QyJf7NYdgLnSLZT6EQGy3RSe',
          amount: '290144486',
          decimals: 6,
          uiAmount: 290.144486,
          uiAmountString: '290.144486',
        },
      ],
    };
    const read = await readSolanaLiquidity(
      rpc,
      'CDBdbNqmrLu1PcgjrFG52yxg71QnFhBZcUE6PSFdbonk',
      recordedPools('launchlab-amm.json'),
      { now: at },
    );
    expect(read.data.pools[0]?.holders).toEqual([
      {
        account: 'FGHBr5hqjPRbAEX4oVA6QyJf7NYdgLnSLZT6EQGy3RSe',
        owner: 'HYhsoBHofTm68KdeZPtvwPNrgF2aSoRytgdVBxspevnu',
        share: read.data.pools[0]?.withdrawableShare,
        kind: 'wallet',
      },
    ]);
    expect(read.data.pools[0]?.note).toBeNull();
  });

  it('a spent allowance is not mistaken for a node that does not list holders', async () => {
    const base = fakeRpcFor('market', ['launchlab-amm.json']);
    const rpc: SolanaRpc = {
      ...base,
      getTokenLargestAccounts: async () => {
        throw new BudgetExhaustedError('solana-rpc', 1);
      },
    };
    const read = await readSolanaLiquidity(
      rpc,
      'CDBdbNqmrLu1PcgjrFG52yxg71QnFhBZcUE6PSFdbonk',
      recordedPools('launchlab-amm.json'),
    );
    // The shares already read stand; the holders are missing for the reason they are.
    const [amm] = read.data.pools;
    expect(amm).toMatchObject({
      known: true,
      holders: [],
      note: 'the LP holders were not listed: the read ran out of calls',
    });
    expect(amm?.burnedShare).toBeCloseTo(0.999735771, 8);
  });

  it('a pool whose own reads fail is reported unknown with the reason; the other pools are still described', async () => {
    const base = fakeRpcFor('market', ['dbc-migrated-usdc.json']);
    const rpc: SolanaRpc = {
      ...base,
      getProgramAccounts: async () => {
        throw new RateLimitError('solana-rpc');
      },
    };
    const pools = recordedPools('dbc-migrated-usdc.json');
    const read = await readSolanaLiquidity(
      rpc,
      'Ax5dAamJPeuaLpFUzs9FdcpoUhHDcxyjPzxCJQidjups',
      pools,
      { now: at },
    );
    expect(read.data.pools).toHaveLength(pools.length);
    expect(read.data.pools[0]).toMatchObject({
      kind: 'meteora-damm-v2',
      known: false,
      lockedShare: null,
    });
    expect(read.data.pools[0]?.note).toMatch(/^the pool could not be read: /);
    expect(
      read.data.pools
        .slice(1)
        .every((p) => p.kind === 'meteora-dlmm' && /Meteora DLMM/.test(p.note ?? '')),
    ).toBe(true);
    expect(read.completeness).toBe('unavailable');
  });

  it('a bug is not swallowed as an unknown pool', async () => {
    const base = fakeRpcFor('market', ['dbc-migrated-usdc.json']);
    const rpc: SolanaRpc = {
      ...base,
      getProgramAccounts: async () => {
        throw new TypeError('boom');
      },
    };
    await expect(
      readSolanaLiquidity(
        rpc,
        'Ax5dAamJPeuaLpFUzs9FdcpoUhHDcxyjPzxCJQidjups',
        recordedPools('dbc-migrated-usdc.json'),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('Meteora DAMM v2', () => {
  it('a pool locked for good (DBC graduate on bags): 100 % permanent lock, two positions', async () => {
    const { read } = await liquidity(
      'dbc-migrated-sol',
      '8X6SyaSgYdPfmZTc1B7Kc7YytMwUYJVTWXgSxJWMBAGS',
    );
    expect(read.completeness).toBe('full');
    expect(read.data.pools[0]).toMatchObject({
      kind: 'meteora-damm-v2',
      known: true,
      lockedShare: 1,
      withdrawableShare: 0,
      holdersCount: 2,
      burnedShare: null,
    });
  });

  it('a pool with positions beside the locked ones (Jupiter studio, USDC)', async () => {
    const { read } = await liquidity(
      'dbc-migrated-usdc',
      'Ax5dAamJPeuaLpFUzs9FdcpoUhHDcxyjPzxCJQidjups',
    );
    const [damm] = read.data.pools;
    expect(damm?.lockedShare).toBeCloseTo(0.990724257, 8);
    expect(damm?.withdrawableShare).toBeCloseTo(0.009275742, 8);
    expect(damm?.holdersCount).toBe(8);
    // The positions add up to the pool; who holds the withdrawable ones is not read, and said.
    expect(damm?.note).toBe('who holds the positions that can be withdrawn is not read');
  });

  it('DAMM v2 positions that do not add up to the pool are said to fall short', async () => {
    const base = fakeRpcFor('market', ['dbc-migrated-usdc.json']);
    const rpc: SolanaRpc = {
      ...base,
      // One position of the eight recorded is left out.
      getProgramAccounts: async (program, options) =>
        (await base.getProgramAccounts(program, options)).slice(1),
    };
    const read = await readSolanaLiquidity(
      rpc,
      'Ax5dAamJPeuaLpFUzs9FdcpoUhHDcxyjPzxCJQidjups',
      recordedPools('dbc-migrated-usdc.json'),
      { now: at },
    );
    expect(read.data.pools[0]?.holdersCount).toBe(7);
    expect(read.data.pools[0]?.note).toMatch(/do not add up to the pool’s liquidity/);
  });
});

describe('what is not read', () => {
  it('concentrated pools: unknown, never guessed', async () => {
    const { read } = await liquidity(
      'pump-raydium-era',
      'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
    );
    expect(read.completeness).toBe('partial');
    expect(read.data.pools.slice(1).map((p) => [p.kind, p.known, p.lockedShare])).toEqual([
      ['orca-whirlpool', false, null],
      ['raydium-clmm', false, null],
    ]);
    expect(read.sources[0]?.note).toMatch(/2 of 3 pools/);
  });

  it('Meteora DLMM: unknown', async () => {
    const { read } = await liquidity(
      'pump-graduated',
      'B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump',
    );
    expect(read.data.pools.slice(1).every((p) => p.kind === 'meteora-dlmm' && !p.known)).toBe(true);
  });

  it('a launchpad curve given as a pool', async () => {
    const recordings = loadRecordings('market', ['pump-curve-sol.json']);
    const curve = 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2';
    const firstMulti = recordings.find((e) => e.method === 'getMultipleAccounts');
    const rpc = createFakeSolanaRpc([
      {
        method: 'getMultipleAccounts',
        params: [[curve], { commitment: 'confirmed', encoding: 'base64' }],
        result: {
          context: { slot: 0 },
          value: [(firstMulti?.result as { value: unknown[] }).value[0]],
        },
      },
    ]);
    // The answer above is the curve's recorded account, asked alone.
    const read = await readSolanaLiquidity(
      rpc,
      'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump',
      [curve],
      { now: at },
    );
    expect(read.data.pools[0]?.note).toBe('a launchpad curve, not a pool: see the graduation');
    expect(read.completeness).toBe('unavailable');
  });

  it('the CPMM pool read for a token it does not hold', async () => {
    const rpc = fakeRpcFor('market', ['launchlab-cpmm.json']);
    const pools = recordedPools('launchlab-cpmm.json');
    const read = await readSolanaLiquidity(
      rpc,
      'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump',
      pools,
      { now: at },
    );
    expect(read.data.pools[0]?.note).toBe('the pool does not hold this token');
  });

  it('no pool: unavailable, no call; at most MAX_LIQUIDITY_POOLS read', async () => {
    const rpc = fakeRpcFor('market', ['ray.json']);
    const none = await readSolanaLiquidity(rpc, '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', []);
    expect(none.completeness).toBe('unavailable');
    expect(rpc.calls).toEqual([]);
    expect(MAX_LIQUIDITY_POOLS).toBe(3);
  });
});
