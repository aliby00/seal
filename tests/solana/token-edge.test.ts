import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { findViolations } from '../../src/lib/agent/guardrails';
import { addressBytes } from '../../src/lib/solana/address';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import { metadataAddress, TOKEN_2022_PROGRAM } from '../../src/lib/solana/programs';
import { parsedAccount, type AccountInfo, type RecordedCall } from '../../src/lib/solana/rpc';
import {
  decodeMintAccount,
  readToken,
  tokenPowers,
  type SolanaToken,
  type TokenExtension,
  type TokenPower,
} from '../../src/lib/solana/token';
import { fakeRpcFor, loadRecordings } from './fixtures';

/**
 * The cases token.test.ts leaves out: addresses that hold a token program's
 * other accounts (recorded on mainnet on 25/11/2026), a metadata pointer that
 * names the Metaplex account, the four extensions no mainnet mint showed, and
 * the sentences of rules no recorded mint carries.
 */

const READ_AT = new Date('2026-11-25T00:00:00Z');

const NOT_MINTS = {
  /** PYUSD's mint authority: a Token-2022 multisig the node parses as `multisig`. */
  'multisig-2022': 'DRXA1H9SjZPyPCEeuAWpfwk8GqVW6dZsKFAtdfpFwApX',
  /** USDC's mint authority: an SPL Token multisig. */
  'multisig-spl': 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG',
  /** A USDC token account of Raydium's AMM v4 authority (SPL Token, 165 bytes). */
  'spl-token-account': '1yYy5Vcy5Zop8Q2cPeJhyPtGpn5G46XWMZCR4s6F4y',
} as const;

const PUMP = 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump';

/** A recording whose first account's bytes are changed by `change`. */
function withBytes(file: string, change: (bytes: Uint8Array) => Uint8Array): RecordedCall[] {
  return loadRecordings('token', [file]).map((entry) => {
    if (entry.method !== 'getMultipleAccounts') return entry;
    const result = entry.result as { context: unknown; value: (AccountInfo | null)[] };
    const [first, ...rest] = result.value;
    const data = (first as AccountInfo).data as [string, 'base64'];
    const bytes = change(base64.decode(data[0]));
    const changed = { ...(first as AccountInfo), data: [base64.encode(bytes), 'base64'] };
    return { ...entry, result: { ...result, value: [changed, ...rest] } };
  });
}

async function token(file: string, mint: string): Promise<SolanaToken> {
  const result = await readToken(mint, fakeRpcFor('token', [file]), { now: () => READ_AT });
  expect(result.data, file).not.toBeNull();
  return result.data as SolanaToken;
}

/** `token` with one extension's state replaced. */
function withState<N extends TokenExtension['extension']>(
  base: SolanaToken,
  name: N,
  change: (state: Extract<TokenExtension, { extension: N }>['state']) => object,
): SolanaToken {
  return {
    ...base,
    extensions: base.extensions.map((e) =>
      e.extension === name ? ({ ...e, state: change(e.state as never) } as TokenExtension) : e,
    ),
  };
}

function powerOf(token: SolanaToken, power: TokenPower['power']): TokenPower | undefined {
  return tokenPowers(token).find((p) => p.power === power);
}

const every: string[] = [];
function said(power: TokenPower | undefined): TokenPower {
  expect(power).toBeDefined();
  every.push((power as TokenPower).sentence);
  return power as TokenPower;
}

describe("addresses that hold a token program's other accounts", () => {
  it.each([
    ['multisig-2022', 'multisig', 'the account is a Token-2022 multisig, not a mint'],
    ['multisig-spl', 'multisig', 'the account is an SPL Token multisig, not a mint'],
    ['spl-token-account', 'account', 'the account is an SPL Token token account, not a mint'],
  ] as const)('%s', async (slug, nodeType, note) => {
    const rpc = fakeRpcFor('token', [`${slug}.json`]);
    // What the node itself says is there, read the same minute.
    const parsed = parsedAccount(
      (await rpc.getAccountInfo(NOT_MINTS[slug], { encoding: 'jsonParsed' })) as AccountInfo,
    )?.parsed as { type: string };
    expect(parsed.type).toBe(nodeType);
    const result = await readToken(NOT_MINTS[slug], rpc, { now: () => READ_AT });
    expect(result).toEqual({
      completeness: 'full',
      sources: [{ name: 'solana-rpc', fetchedAt: READ_AT.toISOString(), note }],
      data: null,
    });
  });

  it('never reads a multisig as a mint, whatever its byte 165 holds', async () => {
    const recordings = withBytes('multisig-2022.json', (bytes) => {
      const copy = bytes.slice();
      copy[165] = 1;
      return copy;
    });
    const result = await readToken(NOT_MINTS['multisig-2022'], createFakeSolanaRpc(recordings), {
      now: () => READ_AT,
    });
    expect(result.data).toBeNull();
    expect(result.sources[0]?.note).toBe('the account is a Token-2022 multisig, not a mint');
  });
});

describe('a metadata pointer naming the Metaplex account', () => {
  it('says the account is missing instead of staying silent', async () => {
    // pump.fun mint bytes: metadataPointer is the first entry (type at 166),
    // its value at 170: authority 32 bytes, then the address at 202.
    const pda = metadataAddress(PUMP);
    const recordings = withBytes('pump-curve.json', (bytes) => {
      const copy = bytes.slice();
      copy.set(addressBytes(pda), 202);
      return copy;
    });
    const rpc = createFakeSolanaRpc(recordings);
    const result = await readToken(PUMP, rpc, { now: () => READ_AT });
    expect(rpc.calls.map((c) => c.method)).toEqual(['getMultipleAccounts']);
    expect(result.completeness).toBe('partial');
    expect(result.data?.metadata).toBeNull();
    expect(result.data?.gaps).toEqual([
      `the metadata pointer names ${pda}, where no account lives`,
    ]);
  });
});

describe('extensions no mainnet mint showed, built from the source layouts', () => {
  /**
   * The pump.fun mint's first 166 bytes (base, padding, account type 1), then
   * one TLV entry each, laid out as the structs in
   * https://github.com/solana-program/token-2022/tree/main/interface/src/extension
   * (non_transferable.rs, interest_bearing_mint/mod.rs,
   * confidential_mint_burn/mod.rs, permissioned_burn/mod.rs).
   */
  function syntheticMint(): AccountInfo {
    const recorded = loadRecordings('token', ['pump-curve.json']).find(
      (entry) => entry.method === 'getMultipleAccounts',
    )?.result as { value: AccountInfo[] };
    const data = (recorded.value[0] as AccountInfo).data as [string, 'base64'];
    const head = base64.decode(data[0]).slice(0, 166);
    const authority = addressBytes('2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk');
    const entry = (type: number, value: Uint8Array) => {
      const out = new Uint8Array(4 + value.length);
      const view = new DataView(out.buffer);
      view.setUint16(0, type, true);
      view.setUint16(2, value.length, true);
      out.set(value, 4);
      return out;
    };
    const interest = new Uint8Array(52);
    const iv = new DataView(interest.buffer);
    interest.set(authority, 0);
    iv.setBigInt64(32, 1_700_000_000n, true);
    iv.setInt16(40, 250, true);
    iv.setBigInt64(42, 1_750_000_000n, true);
    iv.setInt16(50, -125, true);
    const ciphertexts = Uint8Array.from({ length: 196 }, (_, i) => i + 1);
    const parts = [
      head,
      entry(9, new Uint8Array(0)),
      entry(10, interest),
      entry(24, ciphertexts),
      entry(28, authority),
    ];
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return {
      lamports: 0,
      owner: TOKEN_2022_PROGRAM,
      executable: false,
      rentEpoch: 0,
      space: bytes.length,
      data: [base64.encode(bytes), 'base64'],
    };
  }

  it('decodes each field where the source puts it', () => {
    const decoded = decodeMintAccount(syntheticMint());
    if (!decoded.ok) throw new Error(decoded.why);
    expect(decoded.gaps).toEqual([]);
    const bytes = Uint8Array.from({ length: 196 }, (_, i) => i + 1);
    expect(decoded.extensions).toEqual([
      { extension: 'nonTransferable', state: {} },
      {
        extension: 'interestBearingConfig',
        state: {
          rateAuthority: '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk',
          initializationTimestamp: 1_700_000_000,
          preUpdateAverageRate: 250,
          lastUpdateTimestamp: 1_750_000_000,
          currentRate: -125,
        },
      },
      {
        extension: 'confidentialMintBurn',
        state: {
          confidentialSupply: base64.encode(bytes.slice(0, 64)),
          decryptableSupply: base64.encode(bytes.slice(64, 100)),
          supplyElgamalPubkey: base64.encode(bytes.slice(100, 132)),
          pendingBurn: base64.encode(bytes.slice(132, 196)),
        },
      },
      {
        extension: 'permissionedBurnConfig',
        state: { authority: '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk' },
      },
    ]);
  });

  it('says what each one allows', async () => {
    const decoded = decodeMintAccount(syntheticMint());
    if (!decoded.ok) throw new Error(decoded.why);
    const base = await token('pump-curve.json', PUMP);
    const synthetic: SolanaToken = { ...base, extensions: decoded.extensions, metadata: null };
    const authority = '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk';
    expect(said(powerOf(synthetic, 'non-transferable'))).toMatchObject({
      status: 'fixed',
      sentence: 'Holders cannot transfer these tokens to anyone (non-transferable).',
    });
    expect(said(powerOf(synthetic, 'interest-rate'))).toMatchObject({
      status: 'held',
      holder: authority,
      sentence:
        'Wallets show balances shrinking by 1.25% a year, with no new tokens created; someone can change that rate (rate authority).',
    });
    // pump.fun mints have no mint authority: nobody can mint, hidden or not.
    expect(said(powerOf(synthetic, 'confidential-mint-burn'))).toMatchObject({
      status: 'none',
      holder: null,
      sentence:
        'No one can create tokens with hidden amounts: there is no mint authority (confidential mint and burn).',
    });
    expect(
      said(powerOf({ ...synthetic, mintAuthority: authority }, 'confidential-mint-burn')),
    ).toMatchObject({ status: 'held', holder: authority });
    expect(said(powerOf(synthetic, 'permissioned-burn'))).toMatchObject({
      status: 'held',
      holder: authority,
      sentence: "Holders need someone's approval to burn their tokens (permissioned burn).",
    });
    expect(
      said(
        powerOf(
          withState(synthetic, 'permissionedBurnConfig', () => ({ authority: null })),
          'permissioned-burn',
        ),
      ),
    ).toMatchObject({ status: 'none' });
    expect(
      said(
        powerOf(
          withState(synthetic, 'interestBearingConfig', (s) => ({
            ...s,
            rateAuthority: null,
            currentRate: 300,
          })),
          'interest-rate',
        ),
      ).sentence,
    ).toBe(
      'Wallets show balances growing by 3% a year, with no new tokens created; no one can change that rate.',
    );
  });
});

describe('sentences of rules no recorded mint carries', () => {
  const BERN = 'CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo';
  const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
  const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';

  it('a transfer fee before its newer rate starts, capped, and with nobody to collect it', async () => {
    const bern = await token('bern.json', BERN);
    // BERN's newer fee starts at epoch 698: read at 697, the older one is in force.
    const before = { ...bern, epoch: 697 };
    expect(said(powerOf(before, 'transfer-fee')).sentence).toBe(
      'Every transfer pays a 4.2% fee, which someone can collect (withdraw authority); from epoch 698 it becomes 2.69%.',
    );
    const cap = (1000n * 10n ** BigInt(bern.decimals)).toString();
    const capped = withState(before, 'transferFeeConfig', (s) => ({
      ...s,
      withdrawWithheldAuthority: null,
      olderTransferFee: { ...s.olderTransferFee, maximumFee: cap },
    }));
    expect(said(powerOf(capped, 'transfer-fee'))).toMatchObject({
      status: 'fixed',
      holder: null,
      sentence:
        'Every transfer pays a 4.2% fee, at most 1,000 tokens a transfer; no one can collect it (no withdraw authority); from epoch 698 it becomes 2.69%.',
    });
    const free = withState(before, 'transferFeeConfig', (s) => ({
      ...s,
      olderTransferFee: { ...s.olderTransferFee, transferFeeBasisPoints: 0 },
    }));
    expect(said(powerOf(free, 'transfer-fee')).sentence).toBe(
      'Transfers pay no fee today; from epoch 698 they pay 2.69%.',
    );
    const locked = withState(bern, 'transferFeeConfig', (s) => ({
      ...s,
      transferFeeConfigAuthority: null,
    }));
    expect(said(powerOf(locked, 'transfer-fee-change'))).toMatchObject({
      status: 'none',
      sentence: 'No one can change the transfer fee.',
    });
  });

  it('a mint paused right now, with and without someone to resume it', async () => {
    const tslax = await token('tslax.json', TSLAX);
    const paused = withState(tslax, 'pausableConfig', (s) => ({ ...s, paused: true }));
    expect(said(powerOf(paused, 'pause')).sentence).toBe(
      'Transfers, minting and burning are paused right now; someone can resume them (pause authority).',
    );
    const stuck = withState(tslax, 'pausableConfig', () => ({ authority: null, paused: true }));
    expect(said(powerOf(stuck, 'pause'))).toMatchObject({
      status: 'fixed',
      holder: null,
      sentence: 'Transfers, minting and burning are paused, and no one can resume them.',
    });
  });

  it('new accounts that start frozen', async () => {
    const tslax = await token('tslax.json', TSLAX);
    const frozen = withState(tslax, 'defaultAccountState', () => ({ accountState: 'frozen' }));
    expect(said(powerOf(frozen, 'default-account-state'))).toMatchObject({
      status: 'held',
      holder: tslax.freezeAuthority,
      sentence: 'New token accounts start frozen until the freeze authority unfreezes them.',
    });
    expect(
      said(powerOf({ ...frozen, freezeAuthority: null }, 'default-account-state')),
    ).toMatchObject({
      status: 'fixed',
      sentence: 'New token accounts start frozen, and no one can unfreeze them.',
    });
  });

  it('a transfer hook program set, changeable or not', async () => {
    const pyusd = await token('pyusd.json', PYUSD);
    const program = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const hooked = withState(pyusd, 'transferHook', (s) => ({ ...s, programId: program }));
    expect(said(powerOf(hooked, 'transfer-hook')).sentence).toBe(
      'Every transfer also runs program 6EF8…wF6P, which can refuse it, and someone can change that program (transfer hook).',
    );
    const fixed = withState(hooked, 'transferHook', (s) => ({ ...s, authority: null }));
    expect(said(powerOf(fixed, 'transfer-hook'))).toMatchObject({ status: 'fixed', holder: null });
    const empty = withState(pyusd, 'transferHook', () => ({ authority: null, programId: null }));
    expect(said(powerOf(empty, 'transfer-hook'))).toMatchObject({ status: 'none' });
    const noDelegate = withState(pyusd, 'permanentDelegate', () => ({ delegate: null }));
    expect(said(powerOf(noDelegate, 'permanent-delegate'))).toMatchObject({
      status: 'none',
      holder: null,
    });
  });

  it('never uses a verdict, a score or advice', () => {
    expect(every.length).toBeGreaterThan(15);
    for (const sentence of every) expect(findViolations(sentence), sentence).toEqual([]);
  });
});
