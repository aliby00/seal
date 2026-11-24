import type { SourceRef } from '../contracts/completeness';
import { CREATOR_SENDS_LISTED, type CreatorSends } from '../contracts/creator';
import { SealError, UpstreamError } from '../errors';
import { BudgetExhaustedError, requestJson } from '../http';
import type { DexScreenerPair } from '../market/dexscreener';
import { decodeBase58, encodeBase58 } from './address';
import { recordingKey } from './fake-rpc';
import {
  associatedTokenAddress,
  INCINERATOR,
  KNOWN_PROGRAMS,
  metadataAddress,
  PUMP_FUN_PROGRAM,
  pumpBondingCurveAddress,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  TOKEN_PROGRAM,
  isTokenProgram,
} from './programs';
import {
  accountBytes,
  collectSignatures,
  COMMITMENT,
  parsedAccount,
  solanaRpcFrom,
  transactionKeys,
  type AccountInfo,
  type ParsedAccountData,
  type SignatureInfo,
  type SolanaCall,
  type SolanaRpc,
  type SolanaTransaction,
  type TokenBalance,
} from './rpc';
import type {
  SolanaCreation,
  SolanaCreationInstruction,
  SolanaCreator,
  SolanaCreatorHistory,
  SolanaCreatorOnToken,
  SolanaLaunchedToken,
  SolanaTokenMove,
  SolanaTokenOutcome,
  SolanaWalletOnToken,
} from './creator-types';

/**
 * The creator of a Solana token: who it is, what else it launched and what
 * became of it, and what it did with this token.
 *
 * Same ideas as the EVM reads (chain/deployer.ts, holders/links.ts): the
 * creator is read from the launchpad's own record when there is one (the
 * pump.fun curve), else traced back to the transaction that made the mint;
 * every figure comes with the transaction or the account it was read from;
 * whatever was not read is said, through the completeness and its note.
 *
 * Every read goes through a `SolanaRpc` (never `fetch`), capped in calls and
 * in time by `limitRpc`: a capped read returns what it has, marked partial.
 */

// ── Limits ──────────────────────────────────────────────────────────────────

/** A read stopped by its own cap, in calls or in time. */
export class ReadCapError extends Error {
  constructor(
    readonly cap: 'calls' | 'time',
    readonly limit: number,
  ) {
    super(cap === 'calls' ? `call cap of ${limit} reached` : `time cap of ${limit} ms reached`);
    this.name = 'ReadCapError';
  }
}

export type ReadLimits = {
  /** Calls this read may send (answers already given are not sent again). */
  maxCalls?: number;
  /** Time this read may take, from its start. */
  timeoutMs?: number;
  /** The clock; injectable so the tests read the fixtures' day. */
  now?: () => number;
};

/** Calls and time a creator read takes when the caller does not say. */
export const DEFAULT_CREATOR_CALLS = 60;
export const DEFAULT_CREATOR_TIMEOUT_MS = 12_000;

const LIMITED = Symbol('limited');

/**
 * A `SolanaRpc` that stops at its caps and answers a call it has already
 * sent from memory: the four reads below share one, so a page of
 * signatures or a transaction is fetched once for all of them.
 */
export type LimitedRpc = SolanaRpc & {
  readonly [LIMITED]: true;
  /** Calls sent so far. */
  spent(): number;
  /** The clock it was given. */
  now(): number;
};

export function limitRpc(rpc: SolanaRpc, limits: ReadLimits = {}): LimitedRpc {
  if ((rpc as Partial<LimitedRpc>)[LIMITED]) return rpc as LimitedRpc;
  const {
    maxCalls = DEFAULT_CREATOR_CALLS,
    timeoutMs = DEFAULT_CREATOR_TIMEOUT_MS,
    now = Date.now,
  } = limits;
  const deadline = now() + timeoutMs;
  const memo = new Map<string, Promise<unknown>>();
  let spent = 0;
  const call: SolanaCall = <T>(method: string, params: readonly unknown[]) => {
    const key = recordingKey(method, params);
    const known = memo.get(key);
    if (known) return known as Promise<T>;
    if (spent >= maxCalls) return Promise.reject(new ReadCapError('calls', maxCalls));
    if (now() >= deadline) return Promise.reject(new ReadCapError('time', timeoutMs));
    spent += 1;
    const answer = rpc.call<T>(method, params);
    memo.set(key, answer);
    answer.catch(() => memo.delete(key));
    return answer;
  };
  return { ...solanaRpcFrom(call), [LIMITED]: true, spent: () => spent, now };
}

/**
 * Failures a read survives: its caps, the client's allowance, a source that
 * failed. Anything else (a bug, a missing test fixture) is thrown on.
 */
export function isReadFailure(error: unknown): boolean {
  return (
    error instanceof ReadCapError ||
    error instanceof BudgetExhaustedError ||
    error instanceof SealError
  );
}

/** What a failed step says in a note. */
export function failureNote(error: unknown): string {
  if (error instanceof ReadCapError) return error.message;
  if (error instanceof BudgetExhaustedError) return 'call allowance used up';
  if (error instanceof SealError) return error.message;
  return 'read failed';
}

/** Runs a step; a failure it survives (`isReadFailure`) comes back as a value. */
export async function attempt<T>(
  step: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await step() };
  } catch (error) {
    if (!isReadFailure(error)) throw error;
    return { ok: false, error };
  }
}

export function source(
  name: SourceRef['name'],
  at: number,
  notes: readonly string[] = [],
): SourceRef {
  return {
    name,
    fetchedAt: new Date(at).toISOString(),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

// ── Bytes ───────────────────────────────────────────────────────────────────

function u32(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function u64(data: Uint8Array, offset: number): bigint | null {
  if (offset + 8 > data.length) return null;
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((b, i) => data[i] === b);
}

/** A Borsh string: u32 length, then UTF-8 bytes. */
function borshString(data: Uint8Array, offset: number): [string, number] | null {
  const length = u32(data, offset);
  if (length === null || offset + 4 + length > data.length) return null;
  return [
    new TextDecoder().decode(data.subarray(offset + 4, offset + 4 + length)),
    offset + 4 + length,
  ];
}

/** A decimal string as a bigint; `null` when it is not one. */
function toBigInt(value: string | undefined): bigint | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

/** The all-zero key, which the chain shows as the System Program's address. */
const DEFAULT_KEY = SYSTEM_PROGRAM;

/** Six decimals, as the EVM reads round their shares. */
export function share6(value: bigint, supply: bigint | null): number | null {
  if (supply === null || supply <= 0n) return null;
  return Number((value * 1_000_000n) / supply) / 1_000_000;
}

// ── pump.fun ────────────────────────────────────────────────────────────────

/**
 * pump.fun's bonding curve, per its IDL
 * (https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json,
 * `BondingCurve`): 8-byte discriminator, five u64 (virtual and real
 * reserves, total supply), `complete` (bool) at 48, `creator` (pubkey) at 49.
 * Checked on mainnet on 24/11/2026: the discriminator is sha256("account:
 * BondingCurve")[..8]; FB5eSv7C…'s curve names D234v6Hg… at 49, the signer
 * of its creation; graduated B34nXKzC…'s curve has 1 at 48.
 */
export const PUMP_CURVE_DISCRIMINATOR = Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]);
export const PUMP_CURVE_COMPLETE_OFFSET = 48;
export const PUMP_CURVE_CREATOR_OFFSET = 49;
const PUMP_CURVE_HEAD = PUMP_CURVE_CREATOR_OFFSET + 32;

export type PumpCurve = { complete: boolean; creator: string | null };

/** The curve's graduation and creator, or `null` when the account is not a pump.fun curve. */
export function decodePumpCurve(
  info: Pick<AccountInfo, 'owner' | 'data'> | null,
): PumpCurve | null {
  if (!info || info.owner !== PUMP_FUN_PROGRAM) return null;
  const data = accountBytes(info);
  if (!data || data.length <= PUMP_CURVE_COMPLETE_OFFSET) return null;
  if (!startsWith(data, PUMP_CURVE_DISCRIMINATOR)) return null;
  const creator =
    data.length >= PUMP_CURVE_HEAD
      ? encodeBase58(data.subarray(PUMP_CURVE_CREATOR_OFFSET, PUMP_CURVE_HEAD))
      : null;
  return {
    complete: data[PUMP_CURVE_COMPLETE_OFFSET] === 1,
    creator: creator === DEFAULT_KEY ? null : creator,
  };
}

/**
 * pump.fun's two create instructions (IDL above): `create` and `create_v2`.
 * Args: name, symbol, uri (Borsh strings), then `creator` (pubkey). Accounts:
 * mint first, curve third; `user` (the signer) 8th for `create`, 6th for
 * `create_v2`. Checked on mainnet transactions on 24/11/2026: 5qd3nMB4…
 * (`create`, user = creator = 5sbpSGjW…) and 2bp2ZKVj… (`create_v2`, fee
 * payer F46pqf6c…, user = creator = B7VKZzqy…, the name on the curve).
 */
export const PUMP_CREATE = Uint8Array.from([24, 30, 200, 40, 5, 28, 7, 119]);
export const PUMP_CREATE_V2 = Uint8Array.from([214, 144, 76, 236, 95, 139, 49, 180]);

// ── Transactions ────────────────────────────────────────────────────────────

export type FlatInstruction = {
  programId: string;
  accounts: string[];
  data: Uint8Array;
  /** Index of the top-level instruction it belongs to. */
  top: number;
  inner: boolean;
};

/** Every instruction of a `json` transaction, each top-level one followed by those it invoked. */
export function flatInstructions(tx: SolanaTransaction): FlatInstruction[] {
  const keys = transactionKeys(tx);
  const inner = new Map((tx.meta?.innerInstructions ?? []).map((i) => [i.index, i.instructions]));
  const out: FlatInstruction[] = [];
  const decode = (data: string) => {
    try {
      return decodeBase58(data);
    } catch {
      return new Uint8Array();
    }
  };
  tx.transaction.message.instructions.forEach((ix, top) => {
    const list = [
      { ix, inner: false },
      ...(inner.get(top) ?? []).map((i) => ({ ix: i, inner: true })),
    ];
    for (const { ix: one, inner: isInner } of list) {
      out.push({
        programId: keys[one.programIdIndex] ?? '',
        accounts: one.accounts.map((a) => keys[a] ?? ''),
        data: decode(one.data),
        top,
        inner: isInner,
      });
    }
  });
  return out;
}

/** The transaction's signers, the fee payer first. */
export function signersOf(tx: SolanaTransaction): string[] {
  return tx.transaction.message.accountKeys.slice(
    0,
    tx.transaction.message.header.numRequiredSignatures,
  );
}

const MARKETS = new Set(
  KNOWN_PROGRAMS.filter((p) => p.kind === 'amm' || p.kind === 'launchpad').map((p) => p.address),
);

/** The known market or launchpad programs a transaction ran, at any depth (an aggregator routes into them). */
export function marketsIn(tx: SolanaTransaction): string[] {
  return [...new Set(flatInstructions(tx).map((i) => i.programId))].filter((p) => MARKETS.has(p));
}

/**
 * Each owner's change of balance of `mint` in the transaction, raw units:
 * post minus pre, summed over its token accounts. A token account closed in
 * the transaction has no post entry: it ends at zero. An entry without an
 * owner is keyed by its token account.
 */
export function ownerDeltas(tx: SolanaTransaction, mint: string): Map<string, bigint> {
  const keys = transactionKeys(tx);
  const out = new Map<string, bigint>();
  const add = (list: readonly TokenBalance[] | undefined, sign: 1n | -1n) => {
    for (const b of list ?? []) {
      if (b.mint !== mint) continue;
      const owner = b.owner ?? keys[b.accountIndex] ?? '';
      const amount = toBigInt(b.uiTokenAmount.amount);
      if (amount === null) continue;
      out.set(owner, (out.get(owner) ?? 0n) + sign * amount);
    }
  };
  add(tx.meta?.preTokenBalances, -1n);
  add(tx.meta?.postTokenBalances, 1n);
  return out;
}

/** An address's SOL change in the transaction, lamports, the fee given back to the payer. */
export function solChange(tx: SolanaTransaction, address: string): bigint {
  const keys = transactionKeys(tx);
  const meta = tx.meta;
  if (!meta) return 0n;
  let change = 0n;
  keys.forEach((key, i) => {
    if (key !== address) return;
    change += BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
  });
  if (keys[0] === address) change += BigInt(meta.fee);
  return change;
}

/**
 * System Program transfers in a transaction: instruction 2 (`Transfer`),
 * a u32 tag then the u64 lamports; accounts [from, to].
 * https://github.com/anza-xyz/solana-sdk/blob/master/system-interface/src/instruction.rs
 * Checked on 5Rftux22… (24/11/2026): `02000000` + lamports, from the creator to the curve.
 */
export type RawSolTransfer = { from: string; to: string; lamports: bigint; inner: boolean };

export function systemTransfers(tx: SolanaTransaction): RawSolTransfer[] {
  const out: RawSolTransfer[] = [];
  for (const ix of flatInstructions(tx)) {
    if (ix.programId !== SYSTEM_PROGRAM || ix.data.length !== 12 || u32(ix.data, 0) !== 2) continue;
    const lamports = u64(ix.data, 4);
    const [from, to] = ix.accounts;
    if (lamports === null || !from || !to) continue;
    out.push({ from, to, lamports, inner: ix.inner });
  }
  return out;
}

/** A mint created in a transaction, and who the instruction names. */
export type FoundCreation = SolanaCreation & {
  mint: string;
  /** pump.fun: the `creator` argument (the curve's creator); `null` for a plain mint. */
  creator: string | null;
  /** The mint's decimals, from `InitializeMint`; `null` when not seen. */
  decimals: number | null;
  /** The pump.fun curve the instruction names. */
  curve: string | null;
};

/**
 * Token program `InitializeMint` (0) and `InitializeMint2` (20): tag,
 * decimals, mint authority, optional freeze authority; the mint is the
 * first account. Same tags in SPL Token and Token-2022.
 * https://github.com/solana-program/token/blob/main/interface/src/instruction.rs
 * Checked on 24/11/2026: tag 20 creates FB5eSv7C… (Token-2022, in pump.fun's
 * create_v2), BhgU8Y97… (SPL Token, in `create`) and 8xKZ1yzP… (Meteora DBC).
 */
const INITIALIZE_MINT = 0;
const INITIALIZE_MINT2 = 20;
const INITIALIZE_MINT_MIN_LENGTH = 35;

/** The mints a transaction created, a pump.fun launch merged with the mint it initialised. */
export function creationsIn(tx: SolanaTransaction, signature: string): FoundCreation[] {
  const feePayer = tx.transaction.message.accountKeys[0] ?? '';
  const base = { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, feePayer };
  const byMint = new Map<string, FoundCreation>();
  const decimals = new Map<string, number>();
  for (const ix of flatInstructions(tx)) {
    if (isTokenProgram(ix.programId)) {
      const tag = ix.data[0];
      const mint = ix.accounts[0];
      if (
        (tag === INITIALIZE_MINT || tag === INITIALIZE_MINT2) &&
        ix.data.length >= INITIALIZE_MINT_MIN_LENGTH &&
        mint
      ) {
        decimals.set(mint, ix.data[1] ?? 0);
        if (!byMint.has(mint)) {
          byMint.set(mint, {
            ...base,
            mint,
            instruction: tag === INITIALIZE_MINT ? 'initialize-mint' : 'initialize-mint2',
            launchpad: null,
            creator: null,
            decimals: null,
            curve: null,
          });
        }
      }
      continue;
    }
    if (ix.programId !== PUMP_FUN_PROGRAM) continue;
    const v1 = startsWith(ix.data, PUMP_CREATE);
    const v2 = startsWith(ix.data, PUMP_CREATE_V2);
    if (!v1 && !v2) continue;
    const name = borshString(ix.data, 8);
    const symbol = name && borshString(ix.data, name[1]);
    const uri = symbol && borshString(ix.data, symbol[1]);
    const mint = ix.accounts[0];
    if (!uri || !mint || uri[1] + 32 > ix.data.length) continue;
    const instruction: SolanaCreationInstruction = v1 ? 'pump-create' : 'pump-create-v2';
    byMint.set(mint, {
      ...base,
      mint,
      instruction,
      launchpad: 'pump.fun',
      name: name[0],
      symbol: symbol[0],
      creator: encodeBase58(ix.data.subarray(uri[1], uri[1] + 32)),
      decimals: null,
      curve: ix.accounts[2] ?? null,
    });
  }
  return [...byMint.values()].map((c) => ({ ...c, decimals: decimals.get(c.mint) ?? null }));
}

function publicCreation(c: FoundCreation): SolanaCreation {
  return {
    signature: c.signature,
    slot: c.slot,
    blockTime: c.blockTime,
    feePayer: c.feePayer,
    instruction: c.instruction,
    launchpad: c.launchpad,
    ...(c.name !== undefined ? { name: c.name } : {}),
    ...(c.symbol !== undefined ? { symbol: c.symbol } : {}),
  };
}

// ── The mint's creation ─────────────────────────────────────────────────────

/** Pages of the mint's signatures read to reach its first: 3,000 signatures. */
export const CREATION_SIGNATURE_PAGES = 3;

export type CreationRead = {
  creation: FoundCreation | null;
  /** The mint's first transaction was reached (its signatures were listed to the end). */
  reached: boolean;
  note?: string;
};

/** Oldest transactions of a known signer read for the creation, before listing the mint's own. */
export const CREATION_SIGNER_TRANSACTIONS = 3;

export type CreationHints = {
  /** Accounts born in the creation: the creator's associated token account, opened by a launch buy. */
  accounts?: readonly string[];
  /** A signer of the creation (pump.fun's `user`, the curve's creator): its oldest transactions are read. */
  signer?: string;
};

/**
 * The transaction that created `mint`. Tried in turn, cheapest first: the
 * oldest successful transaction of each hinted account; the oldest few of
 * the hinted signer; the oldest successful signature of the mint itself,
 * when its history is short enough to be listed to the end (a mint traded
 * for a day already has thousands). Whatever the path, the transaction must
 * initialise the mint: a hint that leads elsewhere is dropped.
 */
export async function findCreation(
  rpc: SolanaRpc,
  mint: string,
  maxPages = CREATION_SIGNATURE_PAGES,
  hints: CreationHints = {},
): Promise<CreationRead> {
  const creates = async (signature: string) => {
    const tx = await rpc.getTransaction(signature);
    return tx ? creationsIn(tx, signature).find((c) => c.mint === mint) : undefined;
  };
  for (const account of hints.accounts ?? []) {
    const listed = await collectSignatures(rpc, account, { maxPages: 1 });
    if (!listed.complete) continue;
    const first = [...listed.signatures].reverse().find((s) => s.err === null);
    const creation = first && (await creates(first.signature));
    if (creation) return { creation, reached: true };
  }
  if (hints.signer) {
    const listed = await collectSignatures(rpc, hints.signer, { maxPages: 1 });
    if (listed.complete) {
      const oldest = [...listed.signatures].reverse().filter((s) => s.err === null);
      for (const s of oldest.slice(0, CREATION_SIGNER_TRANSACTIONS)) {
        const creation = await creates(s.signature);
        if (creation) return { creation, reached: true };
      }
    }
  }
  const listed = await collectSignatures(rpc, mint, { maxPages });
  if (!listed.complete) {
    return {
      creation: null,
      reached: false,
      note: `the mint has more than ${listed.signatures.length} transactions: its creation was not reached`,
    };
  }
  const first = [...listed.signatures].reverse().find((s) => s.err === null);
  if (!first)
    return { creation: null, reached: true, note: 'the mint has no successful transaction' };
  const tx = await rpc.getTransaction(first.signature);
  if (!tx)
    return { creation: null, reached: true, note: 'the node did not return the first transaction' };
  const creation = creationsIn(tx, first.signature).find((c) => c.mint === mint) ?? null;
  return creation
    ? { creation, reached: true }
    : { creation: null, reached: true, note: 'the first transaction does not initialise the mint' };
}

// ── findCreator ─────────────────────────────────────────────────────────────

/**
 * Metaplex metadata account (`MetadataV1`, key 4): key (u8), update
 * authority at 1, mint at 33.
 * https://github.com/metaplex-foundation/mpl-token-metadata (programs/token-metadata/program/src/state/metadata.rs)
 * Checked on USDC's and BONK's metadata accounts (24/11/2026): key 4, mint at 33.
 */
const METAPLEX_METADATA_V1 = 4;

export function decodeMetadataAuthority(
  info: Pick<AccountInfo, 'owner' | 'data'> | null,
  mint: string,
): string | null {
  if (!info || info.owner !== TOKEN_METADATA_PROGRAM) return null;
  const data = accountBytes(info);
  if (!data || data.length < 65 || data[0] !== METAPLEX_METADATA_V1) return null;
  if (encodeBase58(data.subarray(33, 65)) !== mint) return null;
  const authority = encodeBase58(data.subarray(1, 33));
  return authority === DEFAULT_KEY ? null : authority;
}

type ParsedMint = {
  decimals?: number;
  supply?: string;
  extensions?: { extension?: string; state?: Record<string, unknown> }[];
};

function parsedMint(info: AccountInfo | null): { program: string; mint: ParsedMint } | null {
  if (!info || !isTokenProgram(info.owner)) return null;
  const parsed = parsedAccount(info) as ParsedAccountData | null;
  const body = parsed?.parsed as { type?: string; info?: ParsedMint } | undefined;
  if (body?.type !== 'mint' || !body.info) return null;
  return { program: info.owner, mint: body.info };
}

export type FindCreatorOptions = ReadLimits & { signaturePages?: number };

/**
 * Who created `mint`: the `creator` of its pump.fun curve; else the fee
 * payer of the transaction that initialised it; else the update authority
 * of its metadata. `from` says which, `creation` gives the transaction when
 * it was reached.
 */
export async function findCreator(
  mint: string,
  rpc: SolanaRpc,
  options: FindCreatorOptions = {},
): Promise<SolanaCreator> {
  const r = limitRpc(rpc, options);
  const notes: string[] = [];
  const curveAddress = pumpBondingCurveAddress(mint);
  const metaAddress = metadataAddress(mint);

  // One call: the curve and the metadata account, and the mint for its token program.
  const accounts = await attempt(() =>
    r.getMultipleAccounts([curveAddress, metaAddress, mint], {
      dataSlice: { offset: 0, length: PUMP_CURVE_HEAD },
    }),
  );
  if (!accounts.ok) notes.push(`curve and metadata not read: ${failureNote(accounts.error)}`);
  const [curveInfo, metaInfo, mintInfo] = accounts.ok ? accounts.value : [null, null, null];
  const curve = decodePumpCurve(curveInfo ?? null);
  const tokenProgram = mintInfo && isTokenProgram(mintInfo.owner) ? mintInfo.owner : null;
  const hints: CreationHints = curve?.creator
    ? {
        accounts: tokenProgram ? [associatedTokenAddress(curve.creator, mint, tokenProgram)] : [],
        signer: curve.creator,
      }
    : {};

  const created = await attempt(() => findCreation(r, mint, options.signaturePages, hints));
  if (!created.ok) notes.push(`creation not read: ${failureNote(created.error)}`);
  else if (created.value.note) notes.push(created.value.note);
  const creation = created.ok ? created.value.creation : null;

  const pumpCurve = curve ? { address: curveAddress, complete: curve.complete } : null;
  const done = (
    creator: string | null,
    from: SolanaCreator['data']['from'],
    account: string | null,
  ): SolanaCreator => ({
    completeness:
      creator === null ? 'unavailable' : creation && notes.length === 0 ? 'full' : 'partial',
    sources: [source('solana-rpc', r.now(), notes)],
    data: {
      mint,
      creator,
      from,
      account,
      creation: creation ? publicCreation(creation) : null,
      pumpCurve,
    },
  });

  if (curve?.creator) return done(curve.creator, 'pump-curve', curveAddress);
  if (creation) return done(creation.feePayer, 'creation-transaction', null);

  const metaplex = decodeMetadataAuthority(metaInfo ?? null, mint);
  if (metaplex) return done(metaplex, 'metadata-update-authority', metaAddress);
  // Token-2022 keeps its metadata in the mint (`tokenMetadata` extension).
  const fullMint = await attempt(() => r.getAccountInfo(mint, { encoding: 'jsonParsed' }));
  if (fullMint.ok) {
    const parsed = parsedMint(fullMint.value);
    const state = parsed?.mint.extensions?.find((e) => e.extension === 'tokenMetadata')?.state;
    const authority = typeof state?.updateAuthority === 'string' ? state.updateAuthority : null;
    if (authority && authority !== DEFAULT_KEY) {
      return done(authority, 'metadata-update-authority', mint);
    }
  } else {
    notes.push(`mint not read: ${failureNote(fullMint.error)}`);
  }
  notes.push('no curve, creation transaction or metadata authority names a creator');
  return done(null, null, null);
}

// ── DexScreener ─────────────────────────────────────────────────────────────

/** Fetches a DexScreener URL and returns its JSON; injectable so no test reaches the network. */
export type DexFetch = (url: string) => Promise<unknown>;

export const DEXSCREENER_SOLANA_BASE = 'https://api.dexscreener.com';
/** Addresses per call, on both endpoints used (https://docs.dexscreener.com/api/reference). */
export const DEX_ADDRESSES_PER_CALL = 30;

export const defaultDexFetch: DexFetch = (url) =>
  requestJson<unknown>(url, { source: 'dexscreener-solana', timeoutMs: 6_000, retries: 1 });

export function dexTokensUrl(mints: readonly string[], base = DEXSCREENER_SOLANA_BASE): string {
  return `${base}/tokens/v1/solana/${mints.join(',')}`;
}

export function dexPairsUrl(pairs: readonly string[], base = DEXSCREENER_SOLANA_BASE): string {
  return `${base}/latest/dex/pairs/solana/${pairs.join(',')}`;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Every pair DexScreener lists for these mints, by mint (as base or quote token). */
async function dexPairsOfMints(
  dex: DexFetch,
  mints: readonly string[],
): Promise<Map<string, DexScreenerPair[]>> {
  const out = new Map<string, DexScreenerPair[]>();
  const wanted = new Set(mints);
  for (const group of chunks(mints, DEX_ADDRESSES_PER_CALL)) {
    const body = await dex(dexTokensUrl(group));
    if (!Array.isArray(body)) throw new UpstreamError('dexscreener-solana', 'unexpected answer');
    for (const pair of body as DexScreenerPair[]) {
      for (const token of [pair.baseToken?.address, pair.quoteToken?.address]) {
        if (!token || !wanted.has(token)) continue;
        const list = out.get(token) ?? [];
        if (!list.some((p) => p.pairAddress === pair.pairAddress)) list.push(pair);
        out.set(token, list);
      }
    }
  }
  return out;
}

/** The base token DexScreener names for each pair address asked. */
async function dexBaseOfPairs(
  dex: DexFetch,
  pairs: readonly string[],
): Promise<Map<string, DexScreenerPair>> {
  const out = new Map<string, DexScreenerPair>();
  for (const group of chunks(pairs, DEX_ADDRESSES_PER_CALL)) {
    const body = (await dex(dexPairsUrl(group))) as { pairs?: DexScreenerPair[] | null } | null;
    for (const pair of body?.pairs ?? []) {
      if (pair.pairAddress) out.set(pair.pairAddress, pair);
    }
  }
  return out;
}

const trades24h = (pairs: readonly DexScreenerPair[]) =>
  pairs.reduce((n, p) => n + (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0), 0);

const DAY_S = 86_400;

/**
 * What became of a launch (SolanaTokenOutcome): graduated when its curve is
 * complete; else active when traded in the last 24 hours; else dead when
 * launched more than a day ago with no trade in the last 24 hours; else unknown.
 */
export function tokenOutcome(input: {
  complete: boolean | null;
  /** Trades in the last 24 hours; `null` when DexScreener lists no market or was not read. */
  trades24h: number | null;
  /** Unix seconds. */
  launchedAt: number | null;
  nowS: number;
}): SolanaTokenOutcome {
  if (input.complete) return 'graduated';
  if (input.trades24h === null) return 'unknown';
  if (input.trades24h > 0) return 'active';
  if (input.launchedAt !== null && input.nowS - input.launchedAt > DAY_S) return 'dead';
  return 'unknown';
}

// ── creatorHistory ──────────────────────────────────────────────────────────

/** Transactions of the creator read to find launches outside pump.fun's curves. */
export const HISTORY_TRANSACTIONS = 12;
/** Curves whose mint is looked up on the chain when DexScreener does not name it. */
export const CURVE_LOOKUPS = 6;

export type CreatorHistoryOptions = ReadLimits & {
  /** The analysed token: left out of the list. */
  exclude?: string;
  maxTransactions?: number;
  signaturePages?: number;
  curveLookups?: number;
  dex?: DexFetch;
};

type Draft = {
  mint: string;
  launchpad: string | null;
  name?: string;
  symbol?: string;
  signature: string | null;
  slot: number | null;
  blockTime: number | null;
  curve: string | null;
  complete: boolean | null;
  foundBy: Set<'pump-curves' | 'creator-transactions'>;
};

/** The token accounts `owner` holds, by `filter` (a mint or a token program), as jsonParsed. */
export async function tokenAccountsByOwner(
  rpc: SolanaRpc,
  owner: string,
  filter: { mint: string } | { programId: string },
): Promise<{ address: string; mint: string; amount: bigint }[]> {
  const answer = await rpc.call<{
    value: { pubkey: string; account: AccountInfo }[];
  }>('getTokenAccountsByOwner', [
    owner,
    filter,
    { commitment: COMMITMENT, encoding: 'jsonParsed' },
  ]);
  const out: { address: string; mint: string; amount: bigint }[] = [];
  for (const entry of answer.value ?? []) {
    const parsed = parsedAccount(entry.account)?.parsed as
      { info?: { mint?: string; tokenAmount?: { amount?: string } } } | undefined;
    const mint = parsed?.info?.mint;
    if (!mint) continue;
    out.push({
      address: entry.pubkey,
      mint,
      amount: toBigInt(parsed?.info?.tokenAmount?.amount) ?? 0n,
    });
  }
  return out;
}

/**
 * The other tokens `creator` launched, and what became of each.
 *
 * Two reads: every pump.fun curve whose `creator` field is this address (one
 * `getProgramAccounts`, complete), and the creator's own most recent
 * transactions, for mints it signed into existence elsewhere (capped: the
 * result is partial when it has more). NFTs (0 decimals) are left out.
 */
export async function creatorHistory(
  creator: string,
  rpc: SolanaRpc,
  options: CreatorHistoryOptions = {},
): Promise<SolanaCreatorHistory> {
  const r = limitRpc(rpc, options);
  const dex = options.dex ?? defaultDexFetch;
  const maxTransactions = options.maxTransactions ?? HISTORY_TRANSACTIONS;
  const notes: string[] = [];
  const dexNotes: string[] = [];
  const drafts = new Map<string, Draft>();

  // 1. pump.fun curves naming the creator.
  const curves = await attempt(() =>
    r.getProgramAccounts(PUMP_FUN_PROGRAM, {
      dataSlice: { offset: 0, length: PUMP_CURVE_HEAD },
      filters: [{ memcmp: { offset: PUMP_CURVE_CREATOR_OFFSET, bytes: creator } }],
    }),
  );
  const curveList: { address: string; complete: boolean }[] = [];
  if (curves.ok) {
    for (const { pubkey, account } of curves.value) {
      const curve = decodePumpCurve(account);
      if (curve && curve.creator === creator)
        curveList.push({ address: pubkey, complete: curve.complete });
    }
  } else {
    notes.push(`pump.fun curves not listed: ${failureNote(curves.error)}`);
  }
  const curveState = new Map(curveList.map((c) => [c.address, c.complete]));

  // 2. The creator's own transactions.
  const listed = await attempt(() =>
    collectSignatures(r, creator, { maxPages: options.signaturePages ?? 1 }),
  );
  let signatures: SignatureInfo[] = [];
  let signaturesComplete = false;
  if (listed.ok) {
    signatures = listed.value.signatures;
    signaturesComplete = listed.value.complete;
    if (!signaturesComplete)
      notes.push(`only the creator's ${signatures.length} most recent transactions were listed`);
  } else {
    notes.push(`creator's transactions not listed: ${failureNote(listed.error)}`);
  }
  const successful = signatures.filter((s) => s.err === null);
  let read = 0;
  let readSince: number | null = null;
  for (const s of successful.slice(0, maxTransactions)) {
    const got = await attempt(() => r.getTransaction(s.signature));
    if (!got.ok) {
      notes.push(`creator's transactions read up to ${read}: ${failureNote(got.error)}`);
      break;
    }
    read += 1;
    if (s.blockTime !== null)
      readSince = readSince === null ? s.blockTime : Math.min(readSince, s.blockTime);
    const tx = got.value;
    if (!tx || tx.meta?.err) continue;
    const signers = new Set(signersOf(tx));
    for (const c of creationsIn(tx, s.signature)) {
      const ours =
        c.launchpad === 'pump.fun'
          ? c.creator === creator
          : signers.has(creator) && c.decimals !== 0;
      if (!ours) continue;
      drafts.set(c.mint, {
        mint: c.mint,
        launchpad: c.launchpad,
        ...(c.name !== undefined ? { name: c.name } : {}),
        ...(c.symbol !== undefined ? { symbol: c.symbol } : {}),
        signature: c.signature,
        slot: c.slot,
        blockTime: c.blockTime,
        curve: c.launchpad === 'pump.fun' ? pumpBondingCurveAddress(c.mint) : null,
        complete: null,
        foundBy: new Set(['creator-transactions']),
      });
    }
  }
  if (read < successful.length) {
    notes.push(
      `${read} of the creator's ${successful.length} transactions listed were read for launches outside pump.fun`,
    );
  }

  // 3. Curves to mints: each match is checked by deriving the curve back from the mint.
  const byCurve = new Map(
    [...drafts.values()].filter((d) => d.curve).map((d) => [d.curve as string, d]),
  );
  const addCurve = (curve: string, mint: string, pair?: DexScreenerPair) => {
    if (pumpBondingCurveAddress(mint) !== curve) return false;
    const draft: Draft = drafts.get(mint) ?? {
      mint,
      launchpad: 'pump.fun',
      signature: null,
      slot: null,
      blockTime: null,
      curve,
      complete: null,
      foundBy: new Set(),
    };
    draft.foundBy.add('pump-curves');
    draft.curve = curve;
    if (draft.blockTime === null && pair?.pairCreatedAt && pair.pairAddress === curve) {
      // DexScreener opens a pump.fun token's market at its creation
      // (FB5eSv7C…: pairCreatedAt 1795554868000, creation blockTime 1795554868).
      draft.blockTime = Math.floor(pair.pairCreatedAt / 1000);
    }
    drafts.set(mint, draft);
    byCurve.set(curve, draft);
    return true;
  };
  for (const c of curveList) byCurve.get(c.address)?.foundBy.add('pump-curves');
  const excludedCurve = options.exclude ? pumpBondingCurveAddress(options.exclude) : null;
  let unmapped = curveList
    .map((c) => c.address)
    .filter((c) => !byCurve.has(c) && c !== excludedCurve);
  if (unmapped.length > 0) {
    const pairs = await attempt(() => dexBaseOfPairs(dex, unmapped));
    if (pairs.ok) {
      for (const curve of unmapped) {
        const pair = pairs.value.get(curve);
        if (pair?.baseToken?.address) addCurve(curve, pair.baseToken.address, pair);
      }
    } else {
      dexNotes.push('pairs not read');
    }
    unmapped = unmapped.filter((c) => !byCurve.has(c));
  }
  let lookups = 0;
  for (const curve of [...unmapped]) {
    if (lookups >= (options.curveLookups ?? CURVE_LOOKUPS)) break;
    // The curve holds its token in an account of the mint (`associated_bonding_curve`).
    for (const programId of [TOKEN_2022_PROGRAM, TOKEN_PROGRAM]) {
      lookups += 1;
      const held = await attempt(() => tokenAccountsByOwner(r, curve, { programId }));
      if (!held.ok) break;
      if (held.value.some((a) => addCurve(curve, a.mint))) break;
    }
  }
  unmapped = unmapped.filter((c) => !byCurve.has(c));
  if (unmapped.length > 0)
    notes.push(`${unmapped.length} pump.fun curves naming the creator: their mint was not found`);

  if (options.exclude) drafts.delete(options.exclude);

  // 4. Graduation of pump.fun launches whose curve was not in the list.
  for (const d of drafts.values()) {
    if (d.curve && curveState.has(d.curve)) d.complete = curveState.get(d.curve) ?? null;
  }
  const unknownCurves = [...drafts.values()].filter((d) => d.curve && d.complete === null);
  if (unknownCurves.length > 0) {
    const got = await attempt(() =>
      r.getMultipleAccounts(
        unknownCurves.map((d) => d.curve as string),
        { dataSlice: { offset: 0, length: PUMP_CURVE_HEAD } },
      ),
    );
    if (got.ok) {
      unknownCurves.forEach((d, i) => {
        d.complete = decodePumpCurve(got.value[i] ?? null)?.complete ?? null;
      });
    } else {
      notes.push(`curves not read: ${failureNote(got.error)}`);
    }
  }

  // 5. Trading, from DexScreener.
  const mints = [...drafts.keys()];
  let pairsByMint: Map<string, DexScreenerPair[]> | null = null;
  if (mints.length > 0) {
    const got = await attempt(() => dexPairsOfMints(dex, mints));
    if (got.ok) pairsByMint = got.value;
    else dexNotes.push('tokens not read: trading unknown');
  }
  const nowS = Math.floor(r.now() / 1000);
  const tokens: SolanaLaunchedToken[] = [...drafts.values()]
    .map((d) => {
      const pairs = pairsByMint?.get(d.mint);
      const trades = pairsByMint === null || !pairs || pairs.length === 0 ? null : trades24h(pairs);
      if (d.blockTime === null && d.curve && pairs) {
        const own = pairs.find((p) => p.pairAddress === d.curve && p.pairCreatedAt);
        if (own?.pairCreatedAt) d.blockTime = Math.floor(own.pairCreatedAt / 1000);
      }
      const outcome = tokenOutcome({
        complete: d.complete,
        trades24h: trades,
        launchedAt: d.blockTime,
        nowS,
      });
      return {
        mint: d.mint,
        launchpad: d.launchpad,
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.symbol !== undefined ? { symbol: d.symbol } : {}),
        signature: d.signature,
        slot: d.slot,
        launchedAt: d.blockTime === null ? null : new Date(d.blockTime * 1000).toISOString(),
        curve: d.curve,
        outcome,
        trades24h: trades,
        foundBy: [...d.foundBy].sort(),
      };
    })
    .sort((a, b) => (b.launchedAt ?? '').localeCompare(a.launchedAt ?? ''));

  const count = (o: SolanaTokenOutcome) => tokens.filter((t) => t.outcome === o).length;
  const nothing = !curves.ok && !listed.ok;
  const whole =
    curves.ok &&
    unmapped.length === 0 &&
    signaturesComplete &&
    read === successful.length &&
    dexNotes.length === 0;
  const sources: SourceRef[] = [source('solana-rpc', r.now(), notes)];
  if (mints.length > 0 || unmapped.length > 0 || dexNotes.length > 0) {
    sources.push(source('dexscreener-solana', r.now(), dexNotes));
  }
  return {
    completeness: nothing ? 'unavailable' : whole ? 'full' : 'partial',
    sources,
    data: {
      creator,
      tokens,
      counts: {
        launched: tokens.length,
        graduated: count('graduated'),
        dead: count('dead'),
        active: count('active'),
        unknown: count('unknown'),
      },
      scanned: {
        pumpCurvesListed: curves.ok,
        curvesWithoutMint: unmapped.length,
        signatures: signatures.length,
        signaturesComplete,
        transactionsListed: successful.length,
        transactionsRead: read,
        readSince,
      },
    },
  };
}

// ── A wallet's moves on a token ─────────────────────────────────────────────

/** Transactions of the creator's token accounts read, oldest first. */
export const WALLET_TRANSACTIONS = 15;

/** One transaction's move for `wallet`, or `null` when its balance did not change. */
export function moveIn(
  tx: SolanaTransaction,
  signature: string,
  wallet: string,
  mint: string,
  supply: bigint | null,
): SolanaTokenMove | null {
  const deltas = ownerDeltas(tx, mint);
  const delta = deltas.get(wallet) ?? 0n;
  if (delta === 0n) return null;
  const amount = delta < 0n ? -delta : delta;
  const others = [...deltas.entries()].filter(([owner, d]) => owner !== wallet && d !== 0n);
  const opposite = others
    .filter(([, d]) => (delta < 0n ? d > 0n : d < 0n))
    .map(([address, d]) => ({ address, amount: (d < 0n ? -d : d).toString() }))
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  let kind: SolanaTokenMove['kind'];
  if (marketsIn(tx).length > 0) kind = delta > 0n ? 'buy' : 'sell';
  else if (delta > 0n) kind = 'received';
  else {
    // Sent to the incinerator's token account, or to nobody: gone for good.
    const toLiving = opposite.filter((o) => o.address !== INCINERATOR);
    kind = toLiving.length > 0 ? 'sent' : 'burned';
  }
  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    kind,
    amount: amount.toString(),
    share: share6(amount, supply),
    sol: solChange(tx, wallet).toString(),
    counterparties: opposite.slice(0, CREATOR_SENDS_LISTED),
  };
}

export type WalletOnTokenRead = SolanaWalletOnToken & { complete: boolean; notes: string[] };

/**
 * What `wallet` did with `mint`, from the transactions of its token
 * accounts: those it holds today and its associated one (closed accounts
 * other than the associated one are not seen). Oldest first, up to
 * `maxTransactions`.
 */
export async function readWalletOnToken(
  rpc: SolanaRpc,
  wallet: string,
  mint: string,
  tokenProgram: string,
  supply: bigint | null,
  maxTransactions = WALLET_TRANSACTIONS,
): Promise<WalletOnTokenRead> {
  const notes: string[] = [];
  let complete = true;
  const held = await attempt(() => tokenAccountsByOwner(rpc, wallet, { mint }));
  if (!held.ok) {
    complete = false;
    notes.push(`today's balance not read: ${failureNote(held.error)}`);
  }
  const accounts = [
    ...new Set([
      associatedTokenAddress(wallet, mint, tokenProgram),
      ...(held.ok ? held.value.map((a) => a.address) : []),
    ]),
  ];
  const seen = new Map<string, SignatureInfo>();
  const accountsRead: string[] = [];
  for (const account of accounts) {
    const got = await attempt(() => collectSignatures(rpc, account, { maxPages: 1 }));
    if (!got.ok) {
      complete = false;
      notes.push(`transactions of ${account} not listed: ${failureNote(got.error)}`);
      continue;
    }
    accountsRead.push(account);
    if (!got.value.complete) {
      complete = false;
      notes.push(
        `only the ${got.value.signatures.length} most recent transactions of ${account} were listed`,
      );
    }
    for (const s of got.value.signatures) if (s.err === null) seen.set(s.signature, s);
  }
  const ordered = [...seen.values()].sort((a, b) => a.slot - b.slot);
  const moves: SolanaTokenMove[] = [];
  let read = 0;
  for (const s of ordered.slice(0, maxTransactions)) {
    const got = await attempt(() => rpc.getTransaction(s.signature));
    if (!got.ok) {
      notes.push(`transactions read up to ${read}: ${failureNote(got.error)}`);
      break;
    }
    read += 1;
    const tx = got.value;
    if (!tx || tx.meta?.err) continue;
    const move = moveIn(tx, s.signature, wallet, mint, supply);
    if (move) moves.push(move);
  }
  if (read < ordered.length) {
    complete = false;
    notes.push(`${read} of ${ordered.length} transactions read`);
  }
  const sum = (kind: SolanaTokenMove['kind']) =>
    moves.filter((m) => m.kind === kind).reduce((n, m) => n + BigInt(m.amount), 0n);
  const sol = (kind: 'buy' | 'sell') =>
    moves
      .filter((m) => m.kind === kind)
      .reduce((n, m) => n + (kind === 'buy' ? -BigInt(m.sol) : BigInt(m.sol)), 0n);
  const holds = held.ok ? held.value.reduce((n, a) => n + a.amount, 0n) : null;
  return {
    wallet,
    mint,
    bought: sum('buy').toString(),
    sold: sum('sell').toString(),
    received: sum('received').toString(),
    burned: sum('burned').toString(),
    solSpent: sol('buy').toString(),
    solReceived: sol('sell').toString(),
    holdsNow: holds === null ? null : holds.toString(),
    holdsNowShare: holds === null ? null : share6(holds, supply),
    moves,
    accountsRead,
    transactions: { listed: ordered.length, read },
    complete,
    notes,
  };
}

/** What the creator sent outside markets, in the EVM shape: largest recipients first. */
export function sendsOf(moves: readonly SolanaTokenMove[]): CreatorSends {
  const byRecipient = new Map<string, bigint>();
  let burned = 0n;
  for (const m of moves) {
    if (m.kind === 'burned') burned += BigInt(m.amount);
    if (m.kind !== 'sent') continue;
    for (const c of m.counterparties) {
      if (c.address === INCINERATOR) {
        burned += BigInt(c.amount);
        continue;
      }
      byRecipient.set(c.address, (byRecipient.get(c.address) ?? 0n) + BigInt(c.amount));
    }
  }
  const recipients = [...byRecipient.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([address, value]) => ({ address, value: value.toString() }));
  return {
    recipients: recipients.slice(0, CREATOR_SENDS_LISTED),
    distinct: recipients.length,
    burned: burned.toString(),
    total: [...byRecipient.values()].reduce((n, v) => n + v, 0n).toString(),
  };
}

export type MintFacts = { program: string; supply: bigint | null; decimals: number | null };

/** The mint's token program, supply and decimals; `null` when no mint lives there. */
export async function readMint(rpc: SolanaRpc, mint: string): Promise<MintFacts | null> {
  const parsed = parsedMint(await rpc.getAccountInfo(mint, { encoding: 'jsonParsed' }));
  if (!parsed) return null;
  return {
    program: parsed.program,
    supply: toBigInt(parsed.mint.supply),
    decimals: parsed.mint.decimals ?? null,
  };
}

export type CreatorOnTokenOptions = ReadLimits & { maxTransactions?: number };

/**
 * What the creator bought, sold, sent and still holds of `mint`, from the
 * changes of its balance in the transactions of its token accounts.
 */
export async function creatorOnToken(
  creator: string,
  mint: string,
  rpc: SolanaRpc,
  options: CreatorOnTokenOptions = {},
): Promise<SolanaCreatorOnToken> {
  const r = limitRpc(rpc, options);
  const facts = await attempt(() => readMint(r, mint));
  const empty = {
    wallet: creator,
    mint,
    bought: '0',
    sold: '0',
    received: '0',
    burned: '0',
    solSpent: '0',
    solReceived: '0',
    holdsNow: null,
    holdsNowShare: null,
    moves: [],
    accountsRead: [],
    transactions: { listed: 0, read: 0 },
    supply: null,
    decimals: null,
    sends: { recipients: [], distinct: 0, burned: '0', total: '0' },
  };
  if (!facts.ok || !facts.value) {
    return {
      completeness: 'unavailable',
      sources: [
        source('solana-rpc', r.now(), [
          facts.ok ? 'no mint at this address' : `mint not read: ${failureNote(facts.error)}`,
        ]),
      ],
      data: empty,
    };
  }
  const { program, supply, decimals } = facts.value;
  const wallet = await readWalletOnToken(
    r,
    creator,
    mint,
    program,
    supply,
    options.maxTransactions,
  );
  const { complete, notes, ...data } = wallet;
  return {
    completeness: complete ? 'full' : 'partial',
    sources: [source('solana-rpc', r.now(), notes)],
    data: {
      ...data,
      supply: supply === null ? null : supply.toString(),
      decimals,
      sends: sendsOf(data.moves),
    },
  };
}
