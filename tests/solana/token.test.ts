import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import type { SolanaMint } from '../../src/lib/contracts';
import { findViolations } from '../../src/lib/agent/guardrails';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import { parsedAccount, type AccountInfo, type RecordedCall } from '../../src/lib/solana/rpc';
import {
  formatTokens,
  MAX_TOKEN_CALLS,
  readToken,
  tokenPowers,
  type SolanaToken,
  type TokenPower,
} from '../../src/lib/solana/token';
import { fakeRpcFor, loadRecordings } from './fixtures';

/**
 * Every answer here was recorded on mainnet on 24/11/2026 (public node,
 * commitment confirmed) into tests/fixtures/solana/token/<slug>.json: the
 * calls readToken made, then the node's jsonParsed of the same mint.
 */
const TOKENS = {
  pyusd: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  bern: 'CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo',
  'pump-curve': 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump',
  usdg: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  tslax: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  spyx: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  'sgt-group': 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te',
  'sgt-member': '62vJ96UJHgPucPCS1wDme8Kgi3CF93uQNmoEKPveA83Z',
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  ray: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  goat: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
  'meteora-dbc': '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx',
} as const;
type Slug = keyof typeof TOKENS;

/** Addresses that hold no mint, read the same day. */
const NOT_MINTS = {
  /** PumpSwap pool's base token account (Token-2022). */
  'token-account': '33J8AEXc7aFsnNoEU8wr2qNtNGQKXzRYXaZkAM54vuN3',
  /** The pump.fun program. */
  program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  /** The incinerator: no account. */
  'no-account': '1nc1nerator11111111111111111111111111111111',
} as const;

const READ_AT = new Date('2026-11-24T23:00:00Z');

async function read(slug: Slug, recordings?: RecordedCall[]) {
  const rpc = recordings ? createFakeSolanaRpc(recordings) : fakeRpcFor('token', [`${slug}.json`]);
  const result = await readToken(TOKENS[slug], rpc, { now: () => READ_AT });
  return { rpc, result };
}

async function token(slug: Slug): Promise<SolanaToken> {
  const { result } = await read(slug);
  expect(result.data, slug).not.toBeNull();
  return result.data as SolanaToken;
}

/** "status power holder", one line a power. */
function summary(powers: TokenPower[]): string[] {
  return powers.map((p) => `${p.status} ${p.power} ${p.holder ?? '-'}`);
}

function sentenceOf(powers: TokenPower[], power: TokenPower['power']): string | undefined {
  return powers.find((p) => p.power === power)?.sentence;
}

// ── Decoding, checked against the node's jsonParsed ─────────────────────────

/**
 * jsonParsed writes u64 as JSON numbers and some floats as strings: both
 * sides are compared as numbers.
 */
function normalize(value: unknown): unknown {
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

type ParsedMint = {
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions?: unknown[];
};

describe('readToken decodes the mint as the node parses it', () => {
  it.each(Object.keys(TOKENS) as Slug[])('%s', async (slug) => {
    const { rpc, result } = await read(slug);
    const decoded = result.data as SolanaToken;
    expect(decoded).not.toBeNull();
    const account = (await rpc.getAccountInfo(TOKENS[slug], {
      encoding: 'jsonParsed',
    })) as AccountInfo;
    const parsed = parsedAccount(account)?.parsed as { type: string; info: ParsedMint };
    expect(parsed.type).toBe('mint');
    expect(decoded.program).toBe(
      parsedAccount(account)?.program === 'spl-token-2022' ? 'token-2022' : 'spl-token',
    );
    expect(decoded.decimals).toBe(parsed.info.decimals);
    expect(decoded.supply).toBe(parsed.info.supply);
    expect(decoded.mintAuthority).toBe(parsed.info.mintAuthority);
    expect(decoded.freezeAuthority).toBe(parsed.info.freezeAuthority);
    expect(normalize(decoded.extensions)).toEqual(normalize(parsed.info.extensions ?? []));
  });

  it('keeps u64 exact where jsonParsed cannot (BERN maximumFee)', async () => {
    const fee = (await token('bern')).extensions.find((e) => e.extension === 'transferFeeConfig');
    if (fee?.extension !== 'transferFeeConfig') throw new Error('no transfer fee');
    expect(fee.state.newerTransferFee.maximumFee).toBe('3906250000000000000');
    expect(fee.state.newerTransferFee.transferFeeBasisPoints).toBe(269);
    expect(fee.state.olderTransferFee.transferFeeBasisPoints).toBe(420);
    expect(fee.state.transferFeeConfigAuthority).toBe(
      'BeRNwDN8aGHvxYRVhNyMkF1wsxuEeceux2xn5deFWyEe',
    );
  });

  it('is a SolanaMint of the contracts', async () => {
    const asMint: SolanaMint = await token('pyusd');
    expect(asMint.extensions).toHaveLength(8);
  });
});

// ── What a read returns ──────────────────────────────────────────────────────

describe('readToken', () => {
  it('reads a classic mint and its Metaplex account in one call (USDC)', async () => {
    const { rpc, result } = await read('usdc');
    expect(result.completeness).toBe('full');
    expect(result.sources).toEqual([{ name: 'solana-rpc', fetchedAt: READ_AT.toISOString() }]);
    expect(rpc.calls.map((c) => c.method)).toEqual(['getMultipleAccounts']);
    const data = result.data as SolanaToken;
    expect(data.program).toBe('spl-token');
    expect(data.extensions).toEqual([]);
    expect(data.metadata).toEqual({
      source: 'metaplex',
      account: '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq',
      name: 'USD Coin',
      symbol: 'USDC',
      uri: '',
      updateAuthority: '2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9',
      isMutable: true,
      additionalMetadata: [],
    });
  });

  it('reads Token-2022 metadata from the mint itself (pump.fun)', async () => {
    const data = await token('pump-curve');
    expect(data.program).toBe('token-2022');
    expect(data.extensions.map((e) => e.extension)).toEqual(['metadataPointer', 'tokenMetadata']);
    expect(data.metadata).toMatchObject({
      source: 'tokenMetadata',
      account: TOKENS['pump-curve'],
      name: 'Bouncer',
      symbol: 'BOUNCER',
      updateAuthority: null,
      isMutable: false,
    });
  });

  it('tells a mutable Metaplex account from a frozen one', async () => {
    expect((await token('bonk')).metadata).toMatchObject({ name: 'Bonk', isMutable: true });
    expect((await token('goat')).metadata).toMatchObject({
      name: 'Goatseus Maximus',
      isMutable: false,
      updateAuthority: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
    });
    // An all-zero update authority is nobody.
    expect((await token('meteora-dbc')).metadata).toMatchObject({
      name: 'Claryx',
      isMutable: false,
      updateAuthority: null,
    });
  });

  it('follows a metadata pointer to another mint (Seeker Genesis Token member)', async () => {
    const { rpc, result } = await read('sgt-member');
    expect(result.completeness).toBe('full');
    expect(rpc.calls.map((c) => c.method)).toEqual(['getMultipleAccounts', 'getAccountInfo']);
    expect(result.data?.metadata).toMatchObject({
      source: 'tokenMetadata',
      account: TOKENS['sgt-group'],
      otherMint: TOKENS['sgt-group'],
      name: 'Seeker Genesis Token',
    });
    expect(result.data?.extensions.find((e) => e.extension === 'tokenGroupMember')?.state).toEqual({
      mint: TOKENS['sgt-member'],
      group: TOKENS['sgt-group'],
      memberNumber: expect.any(String),
    });
  });

  it('reads the epoch only when the two transfer fees differ', async () => {
    const bern = await read('bern');
    expect(bern.rpc.calls.map((c) => c.method)).toEqual(['getMultipleAccounts', 'getEpochInfo']);
    expect(bern.result.data?.epoch).toBe(1096);
    const pyusd = await read('pyusd');
    expect(pyusd.rpc.calls.map((c) => c.method)).toEqual(['getMultipleAccounts']);
    expect(pyusd.result.data?.epoch).toBeNull();
  });

  it(`spends at most ${MAX_TOKEN_CALLS} calls`, async () => {
    for (const slug of Object.keys(TOKENS) as Slug[]) {
      const { rpc } = await read(slug);
      expect(rpc.calls.length, slug).toBeLessThanOrEqual(MAX_TOKEN_CALLS);
    }
  });

  it.each([
    ['token-account', 'the account is a Token-2022 token account, not a mint'],
    [
      'program',
      'the account is owned by BPFLoaderUpgradeab1e11111111111111111111111, not a token program',
    ],
    ['no-account', 'no account at this address'],
  ] as const)('says what lives at an address that holds no mint (%s)', async (slug, note) => {
    const result = await readToken(NOT_MINTS[slug], fakeRpcFor('token', [`${slug}.json`]), {
      now: () => READ_AT,
    });
    expect(result).toEqual({
      completeness: 'full',
      sources: [{ name: 'solana-rpc', fetchedAt: READ_AT.toISOString(), note }],
      data: null,
    });
  });

  it('throws on an input that is not an address', async () => {
    const rpc = fakeRpcFor('token', ['usdc.json']);
    await expect(readToken('0xabc', rpc)).rejects.toThrow(TypeError);
    // Too short, and a character outside base58 ('0').
    await expect(readToken('EPjFWdd5', rpc)).rejects.toThrow(TypeError);
    await expect(readToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt10', rpc)).rejects.toThrow(
      TypeError,
    );
    expect(rpc.calls).toEqual([]);
  });
});

describe('readToken when the node fails', () => {
  it('is unavailable, without throwing, when the mint cannot be read', async () => {
    const { result } = await read('usdc', [
      { method: 'getMultipleAccounts', error: { code: 429, message: 'Too many requests' } },
    ]);
    expect(result.completeness).toBe('unavailable');
    expect(result.data).toBeNull();
    expect(result.sources[0]?.note).toBe('the mint account could not be read (rate-limit)');
  });

  it('is unavailable when the node does not answer in time', async () => {
    const rpc = {
      ...fakeRpcFor('token', ['usdc.json']),
      getMultipleAccounts: () => new Promise<never>(() => {}),
    };
    const result = await readToken(TOKENS.usdc, rpc, { timeoutMs: 20 });
    expect(result.completeness).toBe('unavailable');
    expect(result.sources[0]?.note).toBe('the mint account could not be read (timeout)');
  });

  it('is partial when the epoch is missing, and says the fee is not known', async () => {
    const recordings = [
      ...loadRecordings('token', ['bern.json']).filter((r) => r.method !== 'getEpochInfo'),
      { method: 'getEpochInfo', error: { code: -32005, message: 'Node is behind' } },
    ];
    const { result } = await read('bern', recordings);
    expect(result.completeness).toBe('partial');
    expect(result.data?.epoch).toBeNull();
    expect(result.data?.gaps).toEqual([
      'the current epoch could not be read (upstream): which transfer fee applies is not known',
    ]);
    const powers = tokenPowers(result.data as SolanaToken);
    const fee = powers.find((p) => p.power === 'transfer-fee');
    expect(fee?.status).toBe('unknown');
    expect(fee?.sentence).toMatch(
      /^Every transfer pays a fee of 4\.2% before epoch \d+ and 2\.69% from it; the current epoch was not read\.$/,
    );
  });

  it('is partial when the account a metadata pointer names cannot be read', async () => {
    const recordings = loadRecordings('token', ['sgt-member.json']).filter(
      (r) => !(r.method === 'getAccountInfo' && r.params?.[0] === TOKENS['sgt-group']),
    );
    const { result } = await read('sgt-member', recordings);
    expect(result.completeness).toBe('partial');
    expect(result.data?.metadata).toBeNull();
    expect(result.data?.gaps[0]).toMatch(
      /^the metadata account GT22s89n\w+ the pointer names could not be read/,
    );
  });
});

describe('an extension SEAL does not know', () => {
  /** The pump.fun mint's real bytes, with the first TLV type (offset 166) changed. */
  function withFirstType(type: number): RecordedCall[] {
    return loadRecordings('token', ['pump-curve.json']).map((entry) => {
      if (entry.method !== 'getMultipleAccounts') return entry;
      const result = entry.result as { context: unknown; value: (AccountInfo | null)[] };
      const [mint, ...rest] = result.value;
      const data = (mint as AccountInfo).data as [string, 'base64'];
      const bytes = base64.decode(data[0]);
      new DataView(bytes.buffer, bytes.byteOffset).setUint16(166, type, true);
      const changed = { ...(mint as AccountInfo), data: [base64.encode(bytes), 'base64'] };
      return { ...entry, result: { ...result, value: [changed, ...rest] } };
    });
  }

  it('is kept as unknown and makes the read partial', async () => {
    const { result } = await read('pump-curve', withFirstType(200));
    expect(result.completeness).toBe('partial');
    expect(result.data?.extensions[0]).toEqual({
      extension: 'unknown',
      state: { type: 200, length: 64, reason: 'a type SEAL does not decode' },
    });
    // Without a pointer read, the metadata in the mint is still found.
    expect(result.data?.metadata?.name).toBe('Bouncer');
    const powers = tokenPowers(result.data as SolanaToken);
    expect(powers.at(-1)).toEqual({
      power: 'unknown',
      status: 'unknown',
      holder: null,
      from: 'unknown',
      sentence:
        'The mint carries an extension SEAL cannot read (type 200): what it allows is unknown.',
    });
  });

  it('names a token-account extension found on a mint', async () => {
    const { result } = await read('pump-curve', withFirstType(7));
    expect(result.data?.gaps[0]).toBe(
      'extension type 7 not read: a token-account extension, not expected on a mint',
    );
  });

  it('refuses a known extension whose length is not its layout', async () => {
    // Type 12 (permanentDelegate) is 32 bytes; this entry has the pointer's 64.
    const { result } = await read('pump-curve', withFirstType(12));
    expect(result.data?.extensions[0]).toEqual({
      extension: 'unknown',
      state: { type: 12, length: 64, reason: 'permanentDelegate with 64 bytes, its layout has 32' },
    });
  });
});

// ── Powers ───────────────────────────────────────────────────────────────────

describe('tokenPowers', () => {
  it('PYUSD: every power held, the zero fee said as such', async () => {
    const powers = tokenPowers(await token('pyusd'));
    const issuer = '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk';
    expect(summary(powers)).toEqual([
      'held mint DRXA1H9SjZPyPCEeuAWpfwk8GqVW6dZsKFAtdfpFwApX',
      `held freeze ${issuer}`,
      `held permanent-delegate ${issuer}`,
      `held transfer-hook ${issuer}`,
      `held transfer-fee-change ${issuer}`,
      `held close-mint ${issuer}`,
      `held confidential-transfers ${issuer}`,
      `held metadata-update ${issuer}`,
      `held metadata-pointer ${issuer}`,
    ]);
    expect(sentenceOf(powers, 'permanent-delegate')).toBe(
      "Someone can take or burn any holder's tokens (permanent delegate).",
    );
    expect(sentenceOf(powers, 'transfer-fee-change')).toBe(
      'Transfers pay no fee today, but someone can set one of up to 100%, starting two epochs later (transfer fee authority).',
    );
    expect(sentenceOf(powers, 'transfer-hook')).toBe(
      'No extra program runs on transfers today, but someone can add one that can refuse them (transfer hook authority).',
    );
  });

  it('USDC: mint, freeze and metadata held', async () => {
    expect(summary(tokenPowers(await token('usdc')))).toEqual([
      'held mint BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG',
      'held freeze 7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar',
      'held metadata-update 2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9',
    ]);
  });

  it('a pump.fun Token-2022 mint: nothing held, each said', async () => {
    const powers = tokenPowers(await token('pump-curve'));
    expect(summary(powers)).toEqual([
      'none mint -',
      'none freeze -',
      'none metadata-update -',
      'none metadata-pointer -',
    ]);
    expect(powers.map((p) => p.sentence)).toEqual([
      'No one can create new tokens: there is no mint authority.',
      "No one can freeze holders' tokens: there is no freeze authority.",
      "No one can change the token's name, symbol or image link.",
      'No one can point the token to other metadata.',
    ]);
  });

  it('BERN: the fee in force at the epoch read, and who collects it', async () => {
    const powers = tokenPowers(await token('bern'));
    const authority = 'BeRNwDN8aGHvxYRVhNyMkF1wsxuEeceux2xn5deFWyEe';
    expect(summary(powers)).toEqual([
      'none mint -',
      'none freeze -',
      `held transfer-fee ${authority}`,
      `held transfer-fee-change ${authority}`,
    ]);
    // The maximum fee is above the supply: no cap worth saying.
    expect(sentenceOf(powers, 'transfer-fee')).toBe(
      'Every transfer pays a 2.69% fee, which someone can collect (withdraw authority).',
    );
    expect(sentenceOf(powers, 'transfer-fee-change')).toBe(
      'Someone can change the transfer fee, up to 100%, starting two epochs later (transfer fee authority).',
    );
  });

  it('an xStock: pause, default state and display multiplier', async () => {
    const powers = tokenPowers(await token('tslax'));
    expect(summary(powers)).toEqual([
      'held mint 7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj',
      'held freeze JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs',
      'held permanent-delegate 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq',
      'held pause JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs',
      'held transfer-hook 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq',
      'held default-account-state JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs',
      'held ui-multiplier S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS',
      'held confidential-transfers 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq',
      'held metadata-update 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq',
      'held metadata-pointer 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq',
    ]);
    expect(sentenceOf(powers, 'pause')).toBe(
      'Someone can pause all transfers, minting and burning (pause authority).',
    );
    expect(sentenceOf(powers, 'default-account-state')).toBe(
      'New token accounts start usable, but the freeze authority can make new ones start frozen.',
    );
    expect(sentenceOf(powers, 'ui-multiplier')).toBe(
      'Wallets show balances as they are; someone can change that multiplier (scaled amount authority).',
    );
  });

  it('SPYx: the multiplier in force, and the one coming before its date', async () => {
    const spyx = await token('spyx');
    expect(sentenceOf(tokenPowers(spyx), 'ui-multiplier')).toBe(
      'Wallets show every balance multiplied by 1.0074741; someone can change that multiplier (scaled amount authority).',
    );
    // Read before 2026-10-31T13:45:00Z, the switch time the mint holds.
    const before = { ...spyx, readAt: '2026-10-01T00:00:00.000Z' };
    expect(sentenceOf(tokenPowers(before), 'ui-multiplier')).toBe(
      'Wallets show every balance multiplied by 1.0057322, and by 1.0074741 from 2026-10-31; someone can change that multiplier (scaled amount authority).',
    );
  });

  it('a frozen Metaplex account and an empty update key: no one can change the metadata', async () => {
    for (const slug of ['goat', 'meteora-dbc'] as const) {
      expect(summary(tokenPowers(await token(slug))), slug).toEqual([
        'none mint -',
        'none freeze -',
        'none metadata-update -',
      ]);
    }
  });

  it('Seeker Genesis Token: group extensions are not powers over holders', async () => {
    const authority = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
    expect(summary(tokenPowers(await token('sgt-member')))).toEqual([
      `held mint ${authority}`,
      `held freeze ${authority}`,
      `held permanent-delegate ${authority}`,
      `held close-mint ${authority}`,
      `held metadata-update ${authority}`,
      `held metadata-pointer ${authority}`,
    ]);
  });

  it('never uses a verdict, a score or advice', async () => {
    const sentences: string[] = [];
    for (const slug of Object.keys(TOKENS) as Slug[]) {
      const data = await token(slug);
      sentences.push(...tokenPowers(data).map((p) => p.sentence));
      // The same token read before the epoch and multiplier switches, and with the epoch missing.
      sentences.push(
        ...tokenPowers({ ...data, readAt: '2020-01-01T00:00:00.000Z', epoch: null }).map(
          (p) => p.sentence,
        ),
      );
    }
    for (const sentence of sentences) expect(findViolations(sentence), sentence).toEqual([]);
  });
});

describe('formatTokens', () => {
  it('writes raw units as tokens', () => {
    expect(formatTokens('1500000000', 6)).toBe('1,500');
    expect(formatTokens('123', 2)).toBe('1.23');
    expect(formatTokens('3906250000000000000', 5)).toBe('39,062,500,000,000');
    expect(formatTokens('5', 0)).toBe('5');
  });
});
