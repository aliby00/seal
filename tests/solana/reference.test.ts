import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeBase58, isSolanaAddress } from '../../src/lib/solana/address';
import {
  PUMP_FUN_PROGRAM,
  PUMP_SWAP_PROGRAM,
  pumpBondingCurveAddress,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from '../../src/lib/solana/programs';
import { accountBytes, parsedAccount, type AccountInfo } from '../../src/lib/solana/rpc';
import { fakeRpcFor, SOLANA_FIXTURES } from './fixtures';

type Reference = { slug: string; mint: string; why: string; verified: string[]; fixture: string };
const reference = JSON.parse(readFileSync(join(SOLANA_FIXTURES, 'REFERENCE.json'), 'utf8')) as {
  readAt: string;
  tokens: Reference[];
};
const bySlug = new Map(reference.tokens.map((t) => [t.slug, t]));

type MintInfo = {
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions?: { extension: string; state: Record<string, unknown> }[];
};

async function mintOf(slug: string): Promise<{ owner: string; info: MintInfo }> {
  const token = bySlug.get(slug) as Reference;
  const rpc = fakeRpcFor('reference', [`${slug}.json`]);
  const account = (await rpc.getAccountInfo(token.mint, { encoding: 'jsonParsed' })) as AccountInfo;
  const parsed = parsedAccount(account)?.parsed as { type: string; info: MintInfo };
  expect(parsed.type).toBe('mint');
  return { owner: account.owner, info: parsed.info };
}

async function curveOf(slug: string) {
  const token = bySlug.get(slug) as Reference;
  const rpc = fakeRpcFor('reference', [`${slug}.json`]);
  const account = (await rpc.getAccountInfo(pumpBondingCurveAddress(token.mint))) as AccountInfo;
  expect(account.owner).toBe(PUMP_FUN_PROGRAM);
  const bytes = accountBytes(account) as Uint8Array;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PUMP_PROGRAM_README: 8-byte discriminator, five u64, `complete`, `creator`.
  return {
    tokenTotalSupply: view.getBigUint64(40, true).toString(),
    complete: bytes[48],
    creator: encodeBase58(bytes.subarray(49, 81)),
  };
}

describe('the reference tokens', () => {
  it('are twelve distinct mints, each with its fixture', () => {
    expect(reference.tokens).toHaveLength(12);
    expect(new Set(reference.tokens.map((t) => t.mint)).size).toBe(12);
    for (const token of reference.tokens) {
      expect(isSolanaAddress(token.mint), token.slug).toBe(true);
      expect(token.verified.length, token.slug).toBeGreaterThan(0);
      expect(existsSync(join(SOLANA_FIXTURES, token.fixture)), token.fixture).toBe(true);
    }
  });

  it('USDC keeps its mint and freeze authorities', async () => {
    const { owner, info } = await mintOf('usdc');
    expect(owner).toBe(TOKEN_PROGRAM);
    expect(info.mintAuthority).toBe('BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG');
    expect(info.freezeAuthority).toBe('7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar');
  });

  it('PYUSD is a Token-2022 mint with a permanent delegate', async () => {
    const { owner, info } = await mintOf('pyusd');
    expect(owner).toBe(TOKEN_2022_PROGRAM);
    const names = (info.extensions ?? []).map((e) => e.extension);
    expect(names).toEqual(
      expect.arrayContaining([
        'permanentDelegate',
        'transferHook',
        'mintCloseAuthority',
        'transferFeeConfig',
      ]),
    );
  });

  it('BERN charges a transfer fee', async () => {
    const { owner, info } = await mintOf('bern');
    expect(owner).toBe(TOKEN_2022_PROGRAM);
    const fee = info.extensions?.find((e) => e.extension === 'transferFeeConfig')?.state as {
      newerTransferFee: { transferFeeBasisPoints: number };
    };
    expect(fee.newerTransferFee.transferFeeBasisPoints).toBe(269);
  });

  it('known tokens renounced both authorities', async () => {
    for (const slug of ['bonk', 'jup', 'raydium-old', 'many-holders', 'meteora-dbc']) {
      const { info } = await mintOf(slug);
      expect([info.mintAuthority, info.freezeAuthority], slug).toEqual([null, null]);
    }
  });

  it('pump.fun mints are Token-2022 with metadata extensions', async () => {
    for (const slug of ['pump-curve', 'pump-bundled', 'pump-creator-sold', 'pump-graduated']) {
      const { owner, info } = await mintOf(slug);
      expect(owner, slug).toBe(TOKEN_2022_PROGRAM);
      expect(
        (info.extensions ?? []).map((e) => e.extension),
        slug,
      ).toEqual(['metadataPointer', 'tokenMetadata']);
    }
  });

  it('the curve says which launch is still on it and which graduated', async () => {
    const onCurve = await curveOf('pump-curve');
    expect(onCurve.complete).toBe(0);
    expect(onCurve.tokenTotalSupply).toBe((await mintOf('pump-curve')).info.supply);
    // The creator the curve names is not the creation transaction's fee payer.
    expect(onCurve.creator).toBe('B7VKZzqyCJCJ12yu4AkVdaTvQjd3TSiUJMtCppGP38xg');
    expect((await curveOf('pump-graduated')).complete).toBe(1);
  });

  it('the graduated token trades in a PumpSwap pool whose base is the mint', async () => {
    const token = bySlug.get('pump-graduated') as Reference;
    const rpc = fakeRpcFor('reference', ['pump-graduated.json']);
    const pool = (await rpc.getAccountInfo(
      'DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB',
    )) as AccountInfo;
    expect(pool.owner).toBe(PUMP_SWAP_PROGRAM);
    const bytes = accountBytes(pool) as Uint8Array;
    // PUMP_SWAP_README: discriminator 8, bump 1, index 2, creator 32, base_mint 32.
    expect(encodeBase58(bytes.subarray(43, 75))).toBe(token.mint);
  });

  it('the creator of FB5e… sold in one transaction all it bought at launch', async () => {
    const token = bySlug.get('pump-creator-sold') as Reference;
    const rpc = fakeRpcFor('reference', ['pump-creator-sold.json']);
    const creator = (await curveOf('pump-creator-sold')).creator;
    const ata = '4CgQM3CBPKvByMwBWJCyxiqT7LfP97FS18zVb4CCM8TW';
    await expect(rpc.getAccountInfo(ata, { encoding: 'jsonParsed' })).resolves.toBeNull();
    const signatures = await rpc.getSignaturesForAddress(ata);
    let net = 0n;
    const moves: bigint[] = [];
    for (const { signature } of [...signatures].reverse()) {
      const tx = await rpc.getTransaction(signature);
      let delta = 0n;
      for (const b of tx?.meta?.preTokenBalances ?? []) {
        if (b.mint === token.mint && b.owner === creator) delta -= BigInt(b.uiTokenAmount.amount);
      }
      for (const b of tx?.meta?.postTokenBalances ?? []) {
        if (b.mint === token.mint && b.owner === creator) delta += BigInt(b.uiTokenAmount.amount);
      }
      moves.push(delta);
      net += delta;
    }
    expect(moves).toEqual([119064729176629n, -119064729176629n]);
    expect(net).toBe(0n);
  });
});
