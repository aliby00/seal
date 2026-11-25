import { base64 } from '@scure/base';
import type { SourceRef } from '../contracts/completeness';
import type { SolanaTokenProgram } from '../contracts/solana';
import { SealError, TimeoutError } from '../errors';
import { log } from '../logger';
import { encodeBase58, isSolanaAddress, shortAddress } from './address';
import {
  metadataAddress,
  TOKEN_2022_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  TOKEN_PROGRAM,
} from './programs';
import { abortable, accountBytes, type AccountInfo, type SolanaRpc } from './rpc';
import type {
  DefaultAccountState,
  SolanaToken,
  TokenExtension,
  TokenMetadataInfo,
  TokenPower,
  TokenRead,
  TransferFee,
} from './token-types';

export type * from './token-types';

/**
 * A Solana token as its mint account says it: program, supply, decimals,
 * mint and freeze authorities, every Token-2022 extension, and the metadata
 * (the `tokenMetadata` extension or a Metaplex account). `tokenPowers` then
 * says, one plain sentence each, what powers over the token are still held
 * and by whom.
 *
 * The mint is decoded from its raw bytes, not from the node's jsonParsed: one
 * call instead of two, and u64 values stay exact (jsonParsed writes them as
 * JSON numbers, which lose precision above 2^53). The decoding was checked
 * against the node's own jsonParsed of the same mints on 24/11/2026
 * (tests/solana/token.test.ts): PYUSD, USDG, BERN, TSLAx, SPYx, the
 * Seeker Genesis Token group and one of its members, pump.fun mints.
 *
 * Layouts, from the programs' own source:
 * - Mint (82 bytes): https://github.com/solana-program/token-2022/blob/main/interface/src/pod.rs
 *   (`PodMint`: COption<Address> 36, supply u64, decimals u8, is_initialized, COption<Address> 36).
 * - Extensions: https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
 *   A mint with extensions is padded to 165 bytes (`Account::LEN`), byte 165
 *   is the account type (1 = mint), then TLV entries: type u16 LE, length u16
 *   LE, value. Type numbers are `ExtensionType` in declaration order.
 *   Each extension's struct is in `interface/src/extension/<name>/mod.rs`.
 * - tokenMetadata: https://github.com/solana-program/token-metadata/blob/main/interface/src/state.rs (Borsh).
 * - tokenGroup / tokenGroupMember: https://github.com/solana-program/token-group/blob/main/interface/src/state.rs
 * - Metaplex: https://github.com/metaplex-foundation/mpl-token-metadata/blob/main/programs/token-metadata/program/src/state/metadata.rs
 *
 * Extensions seen on mainnet and checked against jsonParsed: transferFeeConfig,
 * mintCloseAuthority, confidentialTransferMint, defaultAccountState,
 * permanentDelegate, transferHook, confidentialTransferFeeConfig,
 * metadataPointer, tokenMetadata, groupPointer, tokenGroup,
 * groupMemberPointer, tokenGroupMember, scaledUiAmountConfig, pausableConfig.
 * No mainnet mint with nonTransferable, interestBearingConfig,
 * confidentialMintBurn or permissionedBurnConfig was found that day: those
 * four are decoded from the source alone, and an entry whose length is not
 * the one the source gives is returned as `unknown` rather than guessed.
 */

/** Calls one read spends at most: the mint and its Metaplex account, a metadata account elsewhere, the epoch. */
export const MAX_TOKEN_CALLS = 3;
/** The whole read gives up after this long; the extra calls are skipped once it is spent. */
export const TOKEN_READ_TIMEOUT_MS = 8_000;

/** SPL Token `Mint::LEN`. */
const MINT_LEN = 82;
/** `Account::LEN`: where a Token-2022 mint with extensions puts its account type. */
const ACCOUNT_TYPE_OFFSET = 165;
/**
 * `Multisig::LEN`. Token-2022 never gives an account with extensions this
 * length (`adjust_len_for_multisig` adds two bytes) and refuses to read one as
 * a mint or a token account (`check_min_len_and_not_multisig`), in
 * https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
 * Its byte 165 falls inside the signer keys, so it says nothing there.
 * Seen on mainnet 25/11/2026: PYUSD's mint authority DRXA1H9S… (Token-2022)
 * and USDC's BJE5MMbq… (SPL Token) are 355-byte accounts the node parses as
 * `multisig`.
 */
const MULTISIG_LEN = 355;
const ACCOUNT_TYPE_MINT = 1;
const TLV_START = ACCOUNT_TYPE_OFFSET + 1;
/** Metaplex `Key::MetadataV1`. */
const METAPLEX_METADATA_V1 = 4;
/** Token-2022 `MAX_FEE_BASIS_POINTS`. */
const MAX_FEE_BASIS_POINTS = 10_000;

// ── Reading bytes ───────────────────────────────────────────────────────────

class Bytes {
  private readonly view: DataView;
  offset = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get left(): number {
    return this.bytes.length - this.offset;
  }

  private take(n: number): number {
    if (n > this.left) throw new RangeError(`needs ${n} bytes at ${this.offset}, has ${this.left}`);
    const at = this.offset;
    this.offset += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new RangeError(`bool ${v} at ${this.offset - 1}`);
    return v === 1;
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }
  i16(): number {
    return this.view.getInt16(this.take(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }
  i64(): number {
    return Number(this.view.getBigInt64(this.take(8), true));
  }
  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }
  raw(n: number): Uint8Array {
    const at = this.take(n);
    return this.bytes.subarray(at, at + n);
  }
  address(): string {
    return encodeBase58(this.raw(32));
  }
  /** `MaybeNull<Address>` / `OptionalNonZeroPubkey`: 32 zero bytes mean none. */
  maybeAddress(): string | null {
    const raw = this.raw(32);
    return raw.every((b) => b === 0) ? null : encodeBase58(raw);
  }
  /** `PodCOption<Address>`: a u32 tag (0 none, 1 some), then 32 bytes either way. */
  cOptionAddress(): string | null {
    const tag = this.u32();
    const raw = this.raw(32);
    if (tag > 1) throw new RangeError(`COption tag ${tag}`);
    return tag === 1 ? encodeBase58(raw) : null;
  }
  /** Borsh string: u32 length, UTF-8. */
  string(): string {
    return new TextDecoder().decode(this.raw(this.u32()));
  }
  base64(n: number): string {
    return base64.encode(this.raw(n));
  }
}

/** Metaplex pads name, symbol and uri with NUL bytes to their maximum length. */
function unpad(text: string): string {
  return text.replace(/\0+$/, '');
}

// ── The mint ────────────────────────────────────────────────────────────────

type MintBase = {
  mintAuthority: string | null;
  supply: string;
  decimals: number;
  freezeAuthority: string | null;
};

function decodeMintBase(bytes: Uint8Array): MintBase | null {
  const r = new Bytes(bytes.subarray(0, MINT_LEN));
  const mintAuthority = r.cOptionAddress();
  const supply = r.u64().toString();
  const decimals = r.u8();
  const initialized = r.bool();
  const freezeAuthority = r.cOptionAddress();
  return initialized ? { mintAuthority, supply, decimals, freezeAuthority } : null;
}

/** `ExtensionType` numbers: interface/src/extension/mod.rs, in declaration order. */
const EXTENSION_TYPES: Record<number, TokenExtension['extension']> = {
  1: 'transferFeeConfig',
  3: 'mintCloseAuthority',
  4: 'confidentialTransferMint',
  6: 'defaultAccountState',
  9: 'nonTransferable',
  10: 'interestBearingConfig',
  12: 'permanentDelegate',
  14: 'transferHook',
  16: 'confidentialTransferFeeConfig',
  18: 'metadataPointer',
  19: 'tokenMetadata',
  20: 'groupPointer',
  21: 'tokenGroup',
  22: 'groupMemberPointer',
  23: 'tokenGroupMember',
  24: 'confidentialMintBurn',
  25: 'scaledUiAmountConfig',
  26: 'pausableConfig',
  28: 'permissionedBurnConfig',
};

/** Types that belong on token accounts, not on mints. */
const ACCOUNT_EXTENSION_TYPES = new Set([2, 5, 7, 8, 11, 13, 15, 17, 27]);

/**
 * Each fixed-size extension's length, summed from its struct: Address 32,
 * U64/I64/F64 8, U16/I16 2, Bool 1, ElGamal pubkey 32, ElGamal ciphertext 64,
 * AE ciphertext 36. `tokenMetadata` is Borsh, of variable length.
 */
const EXTENSION_LENGTHS: Partial<Record<TokenExtension['extension'], number>> = {
  transferFeeConfig: 32 + 32 + 8 + 18 + 18,
  mintCloseAuthority: 32,
  confidentialTransferMint: 32 + 1 + 32,
  defaultAccountState: 1,
  nonTransferable: 0,
  interestBearingConfig: 32 + 8 + 2 + 8 + 2,
  permanentDelegate: 32,
  transferHook: 64,
  confidentialTransferFeeConfig: 32 + 32 + 1 + 64,
  metadataPointer: 64,
  groupPointer: 64,
  tokenGroup: 32 + 32 + 8 + 8,
  groupMemberPointer: 64,
  tokenGroupMember: 32 + 32 + 8,
  confidentialMintBurn: 64 + 36 + 32 + 64,
  scaledUiAmountConfig: 32 + 8 + 8 + 8,
  pausableConfig: 33,
  permissionedBurnConfig: 32,
};

/** spl-token-2022 `AccountState`: Uninitialized, Initialized, Frozen. */
const ACCOUNT_STATES: readonly DefaultAccountState[] = ['uninitialized', 'initialized', 'frozen'];

function transferFee(r: Bytes): TransferFee {
  return {
    epoch: Number(r.u64()),
    maximumFee: r.u64().toString(),
    transferFeeBasisPoints: r.u16(),
  };
}

function decodeTokenMetadata(r: Bytes): ExtensionStates['tokenMetadata'] {
  const updateAuthority = r.maybeAddress();
  const mint = r.address();
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  const count = r.u32();
  const additionalMetadata: [string, string][] = [];
  for (let i = 0; i < count; i += 1) additionalMetadata.push([r.string(), r.string()]);
  return { updateAuthority, mint, name, symbol, uri, additionalMetadata };
}

function decodeExtension(name: TokenExtension['extension'], value: Uint8Array): TokenExtension {
  const r = new Bytes(value);
  switch (name) {
    case 'transferFeeConfig':
      return {
        extension: name,
        state: {
          transferFeeConfigAuthority: r.maybeAddress(),
          withdrawWithheldAuthority: r.maybeAddress(),
          withheldAmount: r.u64().toString(),
          olderTransferFee: transferFee(r),
          newerTransferFee: transferFee(r),
        },
      };
    case 'mintCloseAuthority':
      return { extension: name, state: { closeAuthority: r.maybeAddress() } };
    case 'confidentialTransferMint': {
      const authority = r.maybeAddress();
      const autoApproveNewAccounts = r.bool();
      const auditor = r.raw(32);
      return {
        extension: name,
        state: {
          authority,
          autoApproveNewAccounts,
          auditorElgamalPubkey: auditor.every((b) => b === 0) ? null : base64.encode(auditor),
        },
      };
    }
    case 'defaultAccountState': {
      const state = ACCOUNT_STATES[r.u8()];
      if (!state) throw new RangeError('account state out of range');
      return { extension: name, state: { accountState: state } };
    }
    case 'nonTransferable':
      return { extension: name, state: {} };
    case 'interestBearingConfig':
      return {
        extension: name,
        state: {
          rateAuthority: r.maybeAddress(),
          initializationTimestamp: r.i64(),
          preUpdateAverageRate: r.i16(),
          lastUpdateTimestamp: r.i64(),
          currentRate: r.i16(),
        },
      };
    case 'permanentDelegate':
      return { extension: name, state: { delegate: r.maybeAddress() } };
    case 'transferHook':
      return {
        extension: name,
        state: { authority: r.maybeAddress(), programId: r.maybeAddress() },
      };
    case 'confidentialTransferFeeConfig':
      return {
        extension: name,
        state: {
          authority: r.maybeAddress(),
          withdrawWithheldAuthorityElgamalPubkey: r.base64(32),
          harvestToMintEnabled: r.bool(),
          withheldAmount: r.base64(64),
        },
      };
    case 'metadataPointer':
      return {
        extension: name,
        state: { authority: r.maybeAddress(), metadataAddress: r.maybeAddress() },
      };
    case 'tokenMetadata':
      return { extension: name, state: decodeTokenMetadata(r) };
    case 'groupPointer':
      return {
        extension: name,
        state: { authority: r.maybeAddress(), groupAddress: r.maybeAddress() },
      };
    case 'tokenGroup':
      return {
        extension: name,
        state: {
          updateAuthority: r.maybeAddress(),
          mint: r.address(),
          size: r.u64().toString(),
          maxSize: r.u64().toString(),
        },
      };
    case 'groupMemberPointer':
      return {
        extension: name,
        state: { authority: r.maybeAddress(), memberAddress: r.maybeAddress() },
      };
    case 'tokenGroupMember':
      return {
        extension: name,
        state: { mint: r.address(), group: r.address(), memberNumber: r.u64().toString() },
      };
    case 'confidentialMintBurn':
      return {
        extension: name,
        state: {
          confidentialSupply: r.base64(64),
          decryptableSupply: r.base64(36),
          supplyElgamalPubkey: r.base64(32),
          pendingBurn: r.base64(64),
        },
      };
    case 'scaledUiAmountConfig':
      return {
        extension: name,
        state: {
          authority: r.maybeAddress(),
          multiplier: r.f64(),
          newMultiplierEffectiveTimestamp: r.i64(),
          newMultiplier: r.f64(),
        },
      };
    case 'pausableConfig':
      return { extension: name, state: { authority: r.maybeAddress(), paused: r.bool() } };
    case 'permissionedBurnConfig':
      return { extension: name, state: { authority: r.maybeAddress() } };
    case 'unknown':
      throw new RangeError('not a decodable extension');
  }
}

function unknownExtension(type: number, length: number, reason: string): TokenExtension {
  return { extension: 'unknown', state: { type, length, reason } };
}

/** Every TLV entry after the account type byte, decoded or marked unknown. */
function decodeExtensions(bytes: Uint8Array): { extensions: TokenExtension[]; gaps: string[] } {
  const extensions: TokenExtension[] = [];
  const gaps: string[] = [];
  let at = TLV_START;
  while (at + 4 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, 4);
    const type = view.getUint16(0, true);
    const length = view.getUint16(2, true);
    // Type 0 (`Uninitialized`) is padding: nothing follows.
    if (type === 0) break;
    const start = at + 4;
    if (start + length > bytes.length) {
      extensions.push(unknownExtension(type, length, 'runs past the end of the account'));
      gaps.push(`extension type ${type} runs past the end of the mint account`);
      break;
    }
    const value = bytes.subarray(start, start + length);
    at = start + length;
    const name = EXTENSION_TYPES[type];
    if (!name) {
      const reason = ACCOUNT_EXTENSION_TYPES.has(type)
        ? 'a token-account extension, not expected on a mint'
        : 'a type SEAL does not decode';
      extensions.push(unknownExtension(type, length, reason));
      gaps.push(`extension type ${type} not read: ${reason}`);
      continue;
    }
    const expected = EXTENSION_LENGTHS[name];
    if (expected !== undefined && expected !== length) {
      const reason = `${name} with ${length} bytes, its layout has ${expected}`;
      extensions.push(unknownExtension(type, length, reason));
      gaps.push(`extension ${reason}: not read`);
      continue;
    }
    try {
      extensions.push(decodeExtension(name, value));
    } catch (error) {
      const reason = `${name} could not be decoded (${(error as Error).message})`;
      extensions.push(unknownExtension(type, length, reason));
      gaps.push(`extension ${reason}`);
    }
  }
  return { extensions, gaps };
}

type DecodedMint =
  | {
      ok: true;
      program: SolanaTokenProgram;
      base: MintBase;
      extensions: TokenExtension[];
      gaps: string[];
    }
  | { ok: false; why: string };

/** The mint in an account, or why the account is not one. */
export function decodeMintAccount(info: AccountInfo): DecodedMint {
  const program: SolanaTokenProgram | null =
    info.owner === TOKEN_PROGRAM
      ? 'spl-token'
      : info.owner === TOKEN_2022_PROGRAM
        ? 'token-2022'
        : null;
  if (!program)
    return { ok: false, why: `the account is owned by ${info.owner}, not a token program` };
  const bytes = accountBytes(info);
  if (!bytes) return { ok: false, why: 'the account data was not sent as bytes' };
  const aProgram = program === 'token-2022' ? 'a Token-2022' : 'an SPL Token';
  if (bytes.length === MULTISIG_LEN) {
    return { ok: false, why: `the account is ${aProgram} multisig, not a mint` };
  }
  if (bytes.length === ACCOUNT_TYPE_OFFSET) {
    return { ok: false, why: `the account is ${aProgram} token account, not a mint` };
  }
  const withExtensions = program === 'token-2022' && bytes.length > ACCOUNT_TYPE_OFFSET;
  if (bytes.length !== MINT_LEN && !withExtensions) {
    return {
      ok: false,
      why: `the account is ${aProgram} account of ${bytes.length} bytes, not a mint`,
    };
  }
  if (withExtensions && bytes[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) {
    return { ok: false, why: 'the account is a Token-2022 token account, not a mint' };
  }
  const base = decodeMintBase(bytes);
  if (!base) return { ok: false, why: 'the mint is not initialized' };
  if (!withExtensions) return { ok: true, program, base, extensions: [], gaps: [] };
  return { ok: true, program, base, ...decodeExtensions(bytes) };
}

// ── Metadata ────────────────────────────────────────────────────────────────

/** A Metaplex metadata account (`Metadata`, Borsh), up to `is_mutable`. */
export function decodeMetaplex(
  account: string,
  bytes: Uint8Array,
): { mint: string; metadata: TokenMetadataInfo } | null {
  const r = new Bytes(bytes);
  if (r.u8() !== METAPLEX_METADATA_V1) return null;
  // A plain Pubkey; all zeroes (written 1111…1111) is a key nobody can sign
  // with, as on the Meteora DBC reference token: read as nobody.
  const updateAuthority = r.maybeAddress();
  const mint = r.address();
  const name = unpad(r.string());
  const symbol = unpad(r.string());
  const uri = unpad(r.string());
  r.u16(); // seller_fee_basis_points
  if (r.bool()) {
    // creators: Vec<Creator>, each address 32 + verified 1 + share 1.
    r.raw(r.u32() * 34);
  }
  r.bool(); // primary_sale_happened
  const isMutable = r.bool();
  return {
    mint,
    metadata: {
      source: 'metaplex',
      account,
      name,
      symbol,
      uri,
      updateAuthority,
      isMutable,
      additionalMetadata: [],
    },
  };
}

/** The Metaplex metadata of `mint` in these bytes; `null` when they hold another mint's or none. */
function metaplexFor(account: string, bytes: Uint8Array, mint: string): TokenMetadataInfo | null {
  const read = decodeMetaplex(account, bytes);
  return read && read.mint === mint ? read.metadata : null;
}

function fromExtension(
  account: string,
  state: ExtensionStates['tokenMetadata'],
): TokenMetadataInfo {
  return {
    source: 'tokenMetadata',
    account,
    name: state.name,
    symbol: state.symbol,
    uri: state.uri,
    updateAuthority: state.updateAuthority,
    // Token metadata processor: no update authority → ImmutableMetadata.
    isMutable: state.updateAuthority !== null,
    additionalMetadata: state.additionalMetadata,
  };
}

/** Each extension's state, by name. */
type ExtensionStates = { [E in TokenExtension as E['extension']]: E['state'] };

/** The state of the first extension named `name`, when the mint has one. */
function extensionOf<N extends keyof ExtensionStates>(
  extensions: readonly TokenExtension[],
  name: N,
): ExtensionStates[N] | undefined {
  for (const extension of extensions) {
    // `extension.extension === name`, so its state is that extension's.
    if (extension.extension === name) return extension.state as unknown as ExtensionStates[N];
  }
  return undefined;
}

// ── The read ────────────────────────────────────────────────────────────────

export type ReadTokenOptions = {
  now?: () => Date;
  /** Milliseconds for the whole read; `TOKEN_READ_TIMEOUT_MS` when omitted. */
  timeoutMs?: number;
};

/**
 * `promise`, or a TimeoutError after `ms`. The read's calls carry `cut`'s
 * signal: when time runs out, the request in flight is aborted too, instead
 * of running on unseen.
 */
async function within<T>(promise: Promise<T>, ms: number, cut: AbortController): Promise<T> {
  if (ms <= 0) {
    cut.abort(new TimeoutError('solana-rpc', 0));
    promise.catch(() => undefined);
    throw new TimeoutError('solana-rpc', 0);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new TimeoutError('solana-rpc', ms);
          cut.abort(error);
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function kindOf(error: unknown): string {
  return error instanceof SealError ? error.kind : 'error';
}

/**
 * Reads a mint: at most `MAX_TOKEN_CALLS` calls, within `timeoutMs`.
 * Never throws for the node's failures: the answer is then `unavailable`, or
 * `partial` with `gaps` saying what is missing. Throws a TypeError on an
 * input that is not a Solana address.
 */
export async function readToken(
  mint: string,
  client: SolanaRpc,
  options: ReadTokenOptions = {},
): Promise<TokenRead> {
  if (!isSolanaAddress(mint)) throw new TypeError(`not a Solana address: ${mint}`);
  // The read's time cap aborts its requests, not only its wait.
  const cut = new AbortController();
  const rpc = abortable(client, cut.signal);
  const now = options.now ?? (() => new Date());
  const readAt = now().toISOString();
  const timeoutMs = options.timeoutMs ?? TOKEN_READ_TIMEOUT_MS;
  const started = Date.now();
  const remaining = () => timeoutMs - (Date.now() - started);
  const source = (note?: string): SourceRef[] => [
    { name: 'solana-rpc', fetchedAt: readAt, ...(note ? { note } : {}) },
  ];

  const metaplexAccount = metadataAddress(mint);
  let accounts: (AccountInfo | null)[];
  try {
    accounts = await within(rpc.getMultipleAccounts([mint, metaplexAccount]), remaining(), cut);
  } catch (error) {
    log.warn('mint Solana illisible', { mint, error: kindOf(error) });
    return {
      completeness: 'unavailable',
      sources: source(`the mint account could not be read (${kindOf(error)})`),
      data: null,
    };
  }
  const [mintInfo, metaplexInfo] = accounts;
  if (!mintInfo) {
    return { completeness: 'full', sources: source('no account at this address'), data: null };
  }
  const decoded = decodeMintAccount(mintInfo);
  if (!decoded.ok) return { completeness: 'full', sources: source(decoded.why), data: null };

  const { extensions } = decoded;
  const gaps = [...decoded.gaps];

  // Metadata: where the pointer says, else Metaplex, else the extension.
  const pointer = extensionOf(extensions, 'metadataPointer');
  const inMint = extensionOf(extensions, 'tokenMetadata');
  const metaplexBytes =
    metaplexInfo?.owner === TOKEN_METADATA_PROGRAM ? accountBytes(metaplexInfo) : null;
  let metaplex: TokenMetadataInfo | null = null;
  let metaplexUnreadable = false;
  if (metaplexBytes) {
    try {
      metaplex = metaplexFor(metaplexAccount, metaplexBytes, mint);
    } catch {
      metaplexUnreadable = true;
      gaps.push(`the Metaplex metadata account ${metaplexAccount} could not be decoded`);
    }
  }

  let metadata: TokenMetadataInfo | null = null;
  const target = pointer?.metadataAddress ?? null;
  if (target === mint) {
    if (inMint) metadata = fromExtension(mint, inMint);
    else gaps.push('the metadata pointer names the mint, which holds no metadata');
  } else if (target === metaplexAccount) {
    metadata = metaplex;
    // A decoding failure already left its own gap.
    if (!metadata && !metaplexUnreadable) {
      gaps.push(
        metaplexInfo
          ? `the metadata pointer names ${target}, owned by ${metaplexInfo.owner}: not read`
          : `the metadata pointer names ${target}, where no account lives`,
      );
    }
  } else if (target) {
    try {
      const info = await within(rpc.getAccountInfo(target), remaining(), cut);
      metadata = info ? readMetadataAt(target, info, mint) : null;
      if (!metadata) {
        gaps.push(
          info
            ? `the metadata pointer names ${target}, owned by ${info.owner}: not read`
            : `the metadata pointer names ${target}, where no account lives`,
        );
      }
    } catch (error) {
      gaps.push(
        `the metadata account ${target} the pointer names could not be read (${kindOf(error)})`,
      );
    }
  }
  if (!metadata && !target) {
    metadata = metaplex ?? (inMint ? fromExtension(mint, inMint) : null);
  }
  // The epoch, only when the two fees differ: it tells which one applies.
  let epoch: number | null = null;
  const fee = extensionOf(extensions, 'transferFeeConfig');
  if (fee && !sameFee(fee.olderTransferFee, fee.newerTransferFee)) {
    try {
      const info = await within(
        rpc.call<{ epoch: number }>('getEpochInfo', [{ commitment: 'confirmed' }]),
        remaining(),
        cut,
      );
      epoch = info.epoch;
    } catch (error) {
      gaps.push(
        `the current epoch could not be read (${kindOf(error)}): which transfer fee applies is not known`,
      );
    }
  }

  return {
    completeness: gaps.length ? 'partial' : 'full',
    sources: source(gaps.length ? gaps.join('; ') : undefined),
    data: {
      mint,
      program: decoded.program,
      decimals: decoded.base.decimals,
      supply: decoded.base.supply,
      mintAuthority: decoded.base.mintAuthority,
      freezeAuthority: decoded.base.freezeAuthority,
      extensions,
      metadata,
      epoch,
      readAt,
      gaps,
    },
  };
}

/**
 * Metadata held in another account the pointer names: a Metaplex account, or
 * another Token-2022 mint's `tokenMetadata`. That metadata may name another
 * mint: every Seeker Genesis Token points to its group mint's metadata
 * (62vJ96UJ… → GT22s89n…, read 24/11/2026). It is what wallets show for this
 * token, so it is kept, with `otherMint` saying whose it is.
 */
function readMetadataAt(
  account: string,
  info: AccountInfo,
  mint: string,
): TokenMetadataInfo | null {
  const bytes = accountBytes(info);
  if (!bytes) return null;
  const tag = (metadata: TokenMetadataInfo, named: string): TokenMetadataInfo =>
    named === mint ? metadata : { ...metadata, otherMint: named };
  try {
    if (info.owner === TOKEN_METADATA_PROGRAM) {
      const read = decodeMetaplex(account, bytes);
      return read ? tag(read.metadata, read.mint) : null;
    }
    if (info.owner === TOKEN_2022_PROGRAM) {
      const other = decodeMintAccount(info);
      const state = other.ok ? extensionOf(other.extensions, 'tokenMetadata') : undefined;
      return state ? tag(fromExtension(account, state), state.mint) : null;
    }
  } catch {
    return null;
  }
  return null;
}

function sameFee(a: TransferFee, b: TransferFee): boolean {
  return a.maximumFee === b.maximumFee && a.transferFeeBasisPoints === b.transferFeeBasisPoints;
}

// ── Powers ──────────────────────────────────────────────────────────────────

/** 269 → "2.69%". */
function percent(basisPoints: number): string {
  return `${Number((basisPoints / 100).toFixed(2))}%`;
}

/** Raw units → tokens, with thousands separators: 1500000000, 6 → "1,500". */
export function formatTokens(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const unit = 10n ** BigInt(decimals);
  const whole = (value / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function multiplierText(value: number): string {
  return String(Number(value.toPrecision(8)));
}

/**
 * The powers the mint keeps over its token and holders, and who holds each:
 * one entry per role or rule the mint carries, held or not. A role nobody
 * holds is said as such ("No one can…"), never left out, so the reader sees
 * what was checked. Group extensions are not listed: they say which
 * collection a token belongs to, nothing about the holders' tokens.
 */
export function tokenPowers(token: SolanaToken): TokenPower[] {
  const powers: TokenPower[] = [];
  const add = (power: TokenPower) => powers.push(power);
  const all = token.extensions;

  add(
    token.mintAuthority
      ? {
          power: 'mint',
          status: 'held',
          holder: token.mintAuthority,
          from: 'mint',
          sentence: 'Someone can create new tokens (mint authority).',
        }
      : {
          power: 'mint',
          status: 'none',
          holder: null,
          from: 'mint',
          sentence: 'No one can create new tokens: there is no mint authority.',
        },
  );
  add(
    token.freezeAuthority
      ? {
          power: 'freeze',
          status: 'held',
          holder: token.freezeAuthority,
          from: 'mint',
          sentence:
            "Someone can freeze any holder's tokens so they cannot be moved (freeze authority).",
        }
      : {
          power: 'freeze',
          status: 'none',
          holder: null,
          from: 'mint',
          sentence: "No one can freeze holders' tokens: there is no freeze authority.",
        },
  );

  const delegate = extensionOf(all, 'permanentDelegate');
  if (delegate) {
    add(
      delegate.delegate
        ? {
            power: 'permanent-delegate',
            status: 'held',
            holder: delegate.delegate,
            from: 'permanentDelegate',
            sentence: "Someone can take or burn any holder's tokens (permanent delegate).",
          }
        : {
            power: 'permanent-delegate',
            status: 'none',
            holder: null,
            from: 'permanentDelegate',
            sentence:
              "The permanent delegate is empty: no one can take or burn holders' tokens through it.",
          },
    );
  }

  const pause = extensionOf(all, 'pausableConfig');
  if (pause) {
    const from = 'pausableConfig';
    if (pause.authority) {
      add({
        power: 'pause',
        status: 'held',
        holder: pause.authority,
        from,
        sentence: pause.paused
          ? 'Transfers, minting and burning are paused right now; someone can resume them (pause authority).'
          : 'Someone can pause all transfers, minting and burning (pause authority).',
      });
    } else {
      add(
        pause.paused
          ? {
              power: 'pause',
              status: 'fixed',
              holder: null,
              from,
              sentence: 'Transfers, minting and burning are paused, and no one can resume them.',
            }
          : {
              power: 'pause',
              status: 'none',
              holder: null,
              from,
              sentence: 'No one can pause transfers: the pause authority is empty.',
            },
      );
    }
  }

  const hook = extensionOf(all, 'transferHook');
  if (hook) {
    const from = 'transferHook';
    if (hook.programId) {
      const program = shortAddress(hook.programId);
      add(
        hook.authority
          ? {
              power: 'transfer-hook',
              status: 'held',
              holder: hook.authority,
              from,
              sentence: `Every transfer also runs program ${program}, which can refuse it, and someone can change that program (transfer hook).`,
            }
          : {
              power: 'transfer-hook',
              status: 'fixed',
              holder: null,
              from,
              sentence: `Every transfer also runs program ${program}, which can refuse it; no one can change that program (transfer hook).`,
            },
      );
    } else {
      add(
        hook.authority
          ? {
              power: 'transfer-hook',
              status: 'held',
              holder: hook.authority,
              from,
              sentence:
                'No extra program runs on transfers today, but someone can add one that can refuse them (transfer hook authority).',
            }
          : {
              power: 'transfer-hook',
              status: 'none',
              holder: null,
              from,
              sentence: 'The transfer hook is empty and no one can set it.',
            },
      );
    }
  }

  const fee = extensionOf(all, 'transferFeeConfig');
  if (fee) addFeePowers(token, fee, add);

  const defaultState = extensionOf(all, 'defaultAccountState');
  if (defaultState) {
    const from = 'defaultAccountState';
    const frozen = defaultState.accountState === 'frozen';
    if (token.freezeAuthority) {
      add({
        power: 'default-account-state',
        status: 'held',
        holder: token.freezeAuthority,
        from,
        sentence: frozen
          ? 'New token accounts start frozen until the freeze authority unfreezes them.'
          : 'New token accounts start usable, but the freeze authority can make new ones start frozen.',
      });
    } else {
      add(
        frozen
          ? {
              power: 'default-account-state',
              status: 'fixed',
              holder: null,
              from,
              sentence: 'New token accounts start frozen, and no one can unfreeze them.',
            }
          : {
              power: 'default-account-state',
              status: 'none',
              holder: null,
              from,
              sentence: 'New token accounts start usable, and no one can change that.',
            },
      );
    }
  }

  if (extensionOf(all, 'nonTransferable')) {
    add({
      power: 'non-transferable',
      status: 'fixed',
      holder: null,
      from: 'nonTransferable',
      sentence: 'Holders cannot transfer these tokens to anyone (non-transferable).',
    });
  }

  const close = extensionOf(all, 'mintCloseAuthority');
  if (close) {
    add(
      close.closeAuthority
        ? {
            power: 'close-mint',
            status: 'held',
            holder: close.closeAuthority,
            from: 'mintCloseAuthority',
            sentence: 'Someone can close the mint once no tokens are left (close authority).',
          }
        : {
            power: 'close-mint',
            status: 'none',
            holder: null,
            from: 'mintCloseAuthority',
            sentence: 'No one can close the mint: the close authority is empty.',
          },
    );
  }

  const interest = extensionOf(all, 'interestBearingConfig');
  if (interest) {
    const way = interest.currentRate < 0 ? 'shrinking' : 'growing';
    const shown = `Wallets show balances ${way} by ${percent(Math.abs(interest.currentRate))} a year, with no new tokens created`;
    add(
      interest.rateAuthority
        ? {
            power: 'interest-rate',
            status: 'held',
            holder: interest.rateAuthority,
            from: 'interestBearingConfig',
            sentence: `${shown}; someone can change that rate (rate authority).`,
          }
        : {
            power: 'interest-rate',
            status: 'fixed',
            holder: null,
            from: 'interestBearingConfig',
            sentence: `${shown}; no one can change that rate.`,
          },
    );
  }

  const scaled = extensionOf(all, 'scaledUiAmountConfig');
  if (scaled) addScaledPower(token, scaled, add);

  const confidential = extensionOf(all, 'confidentialTransferMint');
  if (confidential) {
    const base = confidential.autoApproveNewAccounts
      ? 'Holders can make private transfers'
      : 'Holders can make private transfers only once someone approves their account';
    const auditor = confidential.auditorElgamalPubkey
      ? ', and an auditor key can read the hidden amounts'
      : '';
    add({
      power: 'confidential-transfers',
      status: confidential.authority ? 'held' : 'fixed',
      holder: confidential.authority,
      from: 'confidentialTransferMint',
      sentence: `${base}${auditor} (confidential transfers).`,
    });
  }

  // Confidential mints need the mint authority, confidential burns the account
  // owner: process_confidential_mint / process_confidential_burn in
  // https://github.com/solana-program/token-2022/blob/main/program/src/extension/confidential_mint_burn/processor.rs
  if (extensionOf(all, 'confidentialMintBurn')) {
    add(
      token.mintAuthority
        ? {
            power: 'confidential-mint-burn',
            status: 'held',
            holder: token.mintAuthority,
            from: 'confidentialMintBurn',
            sentence:
              'Someone can create tokens with hidden amounts, and holders can burn theirs with hidden amounts (confidential mint and burn).',
          }
        : {
            power: 'confidential-mint-burn',
            status: 'none',
            holder: null,
            from: 'confidentialMintBurn',
            sentence:
              'No one can create tokens with hidden amounts: there is no mint authority (confidential mint and burn).',
          },
    );
  }

  const burn = extensionOf(all, 'permissionedBurnConfig');
  if (burn) {
    add(
      burn.authority
        ? {
            power: 'permissioned-burn',
            status: 'held',
            holder: burn.authority,
            from: 'permissionedBurnConfig',
            sentence: "Holders need someone's approval to burn their tokens (permissioned burn).",
          }
        : {
            power: 'permissioned-burn',
            status: 'none',
            holder: null,
            from: 'permissionedBurnConfig',
            sentence: 'Burning needs no approval: the permissioned burn authority is empty.',
          },
    );
  }

  const metadata = token.metadata;
  if (metadata) {
    const from = metadata.source === 'metaplex' ? 'metaplex' : 'tokenMetadata';
    // Metaplex keeps a key even when `isMutable` is false; a zero key signs nothing.
    add(
      metadata.isMutable && metadata.updateAuthority
        ? {
            power: 'metadata-update',
            status: 'held',
            holder: metadata.updateAuthority,
            from,
            sentence:
              "Someone can change the token's name, symbol and image link (metadata update authority).",
          }
        : {
            power: 'metadata-update',
            status: 'none',
            holder: null,
            from,
            sentence: "No one can change the token's name, symbol or image link.",
          },
    );
  }
  const pointer = extensionOf(all, 'metadataPointer');
  if (pointer) {
    add(
      pointer.authority
        ? {
            power: 'metadata-pointer',
            status: 'held',
            holder: pointer.authority,
            from: 'metadataPointer',
            sentence:
              'Someone can point the token to other metadata, with another name, symbol and image (metadata pointer authority).',
          }
        : {
            power: 'metadata-pointer',
            status: 'none',
            holder: null,
            from: 'metadataPointer',
            sentence: 'No one can point the token to other metadata.',
          },
    );
  }

  for (const extension of token.extensions) {
    if (extension.extension !== 'unknown') continue;
    add({
      power: 'unknown',
      status: 'unknown',
      holder: null,
      from: 'unknown',
      sentence: `The mint carries an extension SEAL cannot read (type ${extension.state.type}): what it allows is unknown.`,
    });
  }
  return powers;
}

function addFeePowers(
  token: SolanaToken,
  fee: ExtensionStates['transferFeeConfig'],
  add: (power: TokenPower) => void,
): void {
  const from = 'transferFeeConfig';
  const same = sameFee(fee.olderTransferFee, fee.newerTransferFee);
  // `TransferFeeConfig::get_epoch_fee`: the newer fee from its epoch on, the older before.
  const active = same
    ? fee.newerTransferFee
    : token.epoch === null
      ? null
      : token.epoch >= fee.newerTransferFee.epoch
        ? fee.newerTransferFee
        : fee.olderTransferFee;
  const capped = (f: TransferFee) =>
    BigInt(f.maximumFee) < BigInt(token.supply)
      ? `, at most ${formatTokens(f.maximumFee, token.decimals)} tokens a transfer`
      : '';

  if (!active) {
    add({
      power: 'transfer-fee',
      status: 'unknown',
      holder: fee.withdrawWithheldAuthority,
      from,
      sentence: `Every transfer pays a fee of ${percent(fee.olderTransferFee.transferFeeBasisPoints)} before epoch ${fee.newerTransferFee.epoch} and ${percent(fee.newerTransferFee.transferFeeBasisPoints)} from it; the current epoch was not read.`,
    });
  } else if (active.transferFeeBasisPoints > 0) {
    // Said last, so that "collect" plainly refers to the fee in force.
    const scheduled =
      active === fee.olderTransferFee
        ? `; from epoch ${fee.newerTransferFee.epoch} it becomes ${percent(fee.newerTransferFee.transferFeeBasisPoints)}${capped(fee.newerTransferFee)}`
        : '';
    const base = `Every transfer pays a ${percent(active.transferFeeBasisPoints)} fee${capped(active)}`;
    add(
      fee.withdrawWithheldAuthority
        ? {
            power: 'transfer-fee',
            status: 'held',
            holder: fee.withdrawWithheldAuthority,
            from,
            sentence: `${base}, which someone can collect (withdraw authority)${scheduled}.`,
          }
        : {
            power: 'transfer-fee',
            status: 'fixed',
            holder: null,
            from,
            sentence: `${base}; no one can collect it (no withdraw authority)${scheduled}.`,
          },
    );
  } else if (active === fee.olderTransferFee && fee.newerTransferFee.transferFeeBasisPoints > 0) {
    add({
      power: 'transfer-fee',
      status: fee.withdrawWithheldAuthority ? 'held' : 'fixed',
      holder: fee.withdrawWithheldAuthority,
      from,
      sentence: `Transfers pay no fee today; from epoch ${fee.newerTransferFee.epoch} they pay ${percent(fee.newerTransferFee.transferFeeBasisPoints)}${capped(fee.newerTransferFee)}.`,
    });
  }

  const zero = active !== null && active.transferFeeBasisPoints === 0;
  if (fee.transferFeeConfigAuthority) {
    add({
      power: 'transfer-fee-change',
      status: 'held',
      holder: fee.transferFeeConfigAuthority,
      from,
      sentence: zero
        ? `Transfers pay no fee today, but someone can set one of up to ${percent(MAX_FEE_BASIS_POINTS)}, starting two epochs later (transfer fee authority).`
        : `Someone can change the transfer fee, up to ${percent(MAX_FEE_BASIS_POINTS)}, starting two epochs later (transfer fee authority).`,
    });
  } else {
    add({
      power: 'transfer-fee-change',
      status: 'none',
      holder: null,
      from,
      sentence: zero
        ? 'The transfer fee is 0% and no one can change it.'
        : 'No one can change the transfer fee.',
    });
  }
}

function addScaledPower(
  token: SolanaToken,
  scaled: ExtensionStates['scaledUiAmountConfig'],
  add: (power: TokenPower) => void,
): void {
  // `ScaledUiAmountConfig::current_multiplier`: the new one from its timestamp on.
  const nowSeconds = Math.floor(Date.parse(token.readAt) / 1000);
  const switched = nowSeconds >= scaled.newMultiplierEffectiveTimestamp;
  const current = switched ? scaled.newMultiplier : scaled.multiplier;
  const next =
    !switched && scaled.newMultiplier !== scaled.multiplier
      ? `, and by ${multiplierText(scaled.newMultiplier)} from ${new Date(scaled.newMultiplierEffectiveTimestamp * 1000).toISOString().slice(0, 10)}`
      : '';
  const shown =
    current === 1 && !next
      ? 'Wallets show balances as they are'
      : `Wallets show every balance multiplied by ${multiplierText(current)}${next}`;
  add(
    scaled.authority
      ? {
          power: 'ui-multiplier',
          status: 'held',
          holder: scaled.authority,
          from: 'scaledUiAmountConfig',
          sentence: `${shown}; someone can change that multiplier (scaled amount authority).`,
        }
      : {
          power: 'ui-multiplier',
          status: current === 1 && !next ? 'none' : 'fixed',
          holder: null,
          from: 'scaledUiAmountConfig',
          sentence: `${shown}; no one can change that multiplier.`,
        },
  );
}
