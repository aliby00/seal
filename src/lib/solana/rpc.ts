import { base64 } from '@scure/base';
import { RateLimitError, SealError, TimeoutError, UpstreamError } from '../errors';
import {
  backoffDelay,
  BudgetExhaustedError,
  createBudget,
  request,
  type RequestBudget,
} from '../http';
import { log } from '../logger';
import { throttle } from '../throttle';

/**
 * JSON-RPC client for Solana mainnet.
 *
 * One client per analysis: it carries the analysis's allowance of calls
 * (`createSolanaRpc({ maxCalls })`), shared by every reader. Every reader
 * codes against `SolanaRpc`, never against `fetch`, so the tests hand it a
 * fake one answering from recorded responses (fake-rpc.ts).
 *
 * A reader's time cap cuts its requests for real: `withSignal` (or
 * `abortable`) gives it a view of the client whose calls carry its own
 * `AbortSignal`, passed down to `fetch`. When the signal aborts, the request
 * in flight is aborted, the call rejects with the signal's reason (the
 * reader's own cap error when it gave one) and later calls are refused.
 *
 * The node URL of a keyed provider holds its key: it is never logged, never
 * put in an error message. Logs name the node by its label.
 */

export const PUBLIC_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** Every call reads at this commitment: recent, and voted on by a supermajority. */
export const COMMITMENT = 'confirmed';
/** `getMultipleAccounts` takes at most 100 addresses: 101 → -32602 "Too many inputs provided; max 100" (24/11/2026). */
export const MAX_MULTIPLE_ACCOUNTS = 100;
/** `getSignaturesForAddress` returns at most 1,000 a page: 1001 → -32602 "Invalid limit; max 1000" (24/11/2026). */
export const MAX_SIGNATURES_PAGE = 1_000;
/**
 * Version-1 transactions exist on mainnet: in the recent blocks read on 24/11/2026,
 * 222 of 442 transactions were version 1. Asked with a lower
 * `maxSupportedTransactionVersion` (or none), the public node refuses them:
 * -32015 "Transaction version (1) is not supported by the requesting client".
 */
export const MAX_TRANSACTION_VERSION = 1;
/** A read that has not said otherwise may spend this many calls. */
export const DEFAULT_MAX_CALLS = 200;

/**
 * Methods the public node does not serve. Measured on 24/11/2026:
 * `getTokenLargestAccounts` answers 429 "Too many requests for a specific RPC
 * call" with `Retry-After: 10` on the very first call, every time. Sent there
 * it would only burn the allowance; a keyed node (Alchemy) serves it.
 */
export const PUBLIC_NODE_REFUSES: ReadonlySet<string> = new Set(['getTokenLargestAccounts']);

/**
 * Pacing. The public node: about one call every 300 ms (the recordings of
 * 24/11/2026 went at one every 350 ms). A keyed node: `SEAL_SOLANA_RPC_RATE`
 * calls a second, 10 when unset.
 */
export const PUBLIC_RATE = 3;
export const PUBLIC_BURST = 3;
export const KEYED_RATE = 10;
export const KEYED_BURST = 20;

/** A node that failed is tried after the others for this long. */
export const SET_ASIDE_MS = 60_000;
/**
 * A keyed node that still answers 429 after its retries: a few seconds only.
 * Its limit is per second; ten minutes (before 26/11/2026) put a whole
 * instance on the public node, three calls a second, for one busy second.
 */
export const RATE_LIMITED_ASIDE_MS = 5_000;
/** Tries a keyed node gets after a 429 before the call is handed over. */
export const KEYED_RATE_LIMIT_RETRIES = 2;
/** The longest a keyed node's `Retry-After` is waited before the call is handed over instead. */
export const KEYED_RETRY_AFTER_MAX_MS = 2_000;
/** A node that is not the last one gets this long before the next is tried. */
export const HANDOVER_TIMEOUT_MS = 8_000;
/** After a 429 the public node needs seconds, not the generic 0.4 s backoff. */
const RATE_LIMIT_WAIT_MS = 1_500;
/**
 * More tries the last node gets when its JSON-RPC answer itself says it is
 * busy or unhealthy (429, -32005, -32004 in the body of an HTTP 200): `request`
 * only retries what the HTTP status says.
 */
const BODY_RETRIES = 2;

export type SolanaNode = {
  url: string;
  /** What logs and errors call it: never the URL, which can hold a key. */
  label: 'solana-rpc-url' | 'alchemy' | 'public';
  public: boolean;
};

const ALCHEMY_HOST = /^[a-z0-9-]+\.g\.alchemy\.com$/;

/**
 * The Solana node of the Alchemy key in `RPC_URL`, when `RPC_URL` (or one of
 * its comma-separated entries) is an Alchemy address: same key, host
 * `solana-mainnet.g.alchemy.com`, path `/v2/<key>`.
 */
export function alchemySolanaUrl(rpcUrl: string | undefined): string | undefined {
  for (const entry of (rpcUrl ?? '').split(',')) {
    let url: URL;
    try {
      url = new URL(entry.trim());
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !ALCHEMY_HOST.test(url.hostname)) continue;
    const key = /^\/v2\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (key) return `https://solana-mainnet.g.alchemy.com/v2/${key}`;
  }
  return undefined;
}

/**
 * The nodes in the order they are tried: `SOLANA_RPC_URL` when set (one URL),
 * else the Alchemy node built from `RPC_URL`'s key; the public node always
 * closes the list, so a keyed node failing degrades a read instead of
 * stopping it.
 */
export function solanaRpcNodes(
  env: Record<string, string | undefined> = process.env,
): SolanaNode[] {
  const nodes: SolanaNode[] = [];
  const own = env.SOLANA_RPC_URL?.trim();
  if (own && own !== PUBLIC_SOLANA_RPC_URL) {
    nodes.push({ url: own, label: 'solana-rpc-url', public: false });
  } else if (!own) {
    const alchemy = alchemySolanaUrl(env.RPC_URL);
    if (alchemy) nodes.push({ url: alchemy, label: 'alchemy', public: false });
  }
  nodes.push({ url: PUBLIC_SOLANA_RPC_URL, label: 'public', public: true });
  return nodes;
}

/** The node a call goes to first, as `solanaRpcNodes` orders them. */
export function solanaRpcUrl(env: Record<string, string | undefined> = process.env): string {
  return (solanaRpcNodes(env)[0] as SolanaNode).url;
}

/** Whether `node` serves `method` at all. */
export function serves(node: SolanaNode, method: string): boolean {
  return !(node.public && PUBLIC_NODE_REFUSES.has(method));
}

/**
 * JSON-RPC errors about the request itself: any node would give the same
 * answer, so the next one is not asked. -32602 invalid params (seen: "Too
 * many inputs provided; max 100"), -32015 transaction version not supported
 * (seen), -32007 slot skipped. Any other code (method not on this plan,
 * history pruned on this node…) goes to the next node.
 * Codes: https://github.com/anza-xyz/agave/blob/master/rpc-client-api/src/custom_error.rs
 */
export const REQUEST_ERROR_CODES: ReadonlySet<number> = new Set([-32602, -32015, -32007]);

/** A JSON-RPC error the node sent back: its code says why (-32602 bad params, -32009 pruned…). */
export class SolanaRpcError extends UpstreamError {
  /** The error is about the request: another node would answer the same. */
  readonly aboutRequest: boolean;

  constructor(
    readonly code: number,
    readonly method: string,
    /** The node's own message, as it sent it. */
    readonly detail: string,
  ) {
    // -32005 NODE_UNHEALTHY and -32004 BLOCK_NOT_AVAILABLE are worth a retry (custom_error.rs).
    super(
      'solana-rpc',
      `${method}: ${detail} (${code})`,
      code === -32005 || code === -32004 ? 503 : undefined,
    );
    this.name = 'SolanaRpcError';
    this.aboutRequest = REQUEST_ERROR_CODES.has(code);
  }
}

/** No node on the list serves this method (the public node alone, `getTokenLargestAccounts`). */
export class MethodUnavailableError extends UpstreamError {
  constructor(readonly method: string) {
    super('solana-rpc', `${method}: not served by the configured nodes`);
    this.name = 'MethodUnavailableError';
  }
}

// ── Shapes of the answers, as the nodes send them ───────────────────────────

/** Account data asked as base64: `[data, 'base64']`. */
export type Base64Data = [string, 'base64'];
/** Account data asked as jsonParsed, for an account the node knows how to parse. */
export type ParsedAccountData = { program: string; parsed: unknown; space: number };

export type AccountInfo<D = Base64Data | ParsedAccountData> = {
  lamports: number;
  owner: string;
  executable: boolean;
  /** u64::MAX for rent-exempt accounts, beyond a safe integer once parsed: do not compare it. */
  rentEpoch: number;
  space: number;
  data: D;
};

export type DataSlice = { offset: number; length: number };
export type AccountOptions = {
  /** `base64` (default) or `jsonParsed`; jsonParsed falls back to base64 for accounts it cannot parse. */
  encoding?: 'base64' | 'jsonParsed';
  dataSlice?: DataSlice;
};

export type ProgramAccountFilter =
  | { memcmp: { offset: number; bytes: string; encoding?: 'base58' | 'base64' } }
  | { dataSize: number };
export type ProgramAccountsOptions = AccountOptions & { filters?: ProgramAccountFilter[] };
export type ProgramAccount<D = Base64Data | ParsedAccountData> = {
  pubkey: string;
  account: AccountInfo<D>;
};

export type TokenAmount = {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
};
/** One of the 20 largest token accounts of a mint: the token account, not its owner. */
export type LargestTokenAccount = TokenAmount & { address: string };

export type SignatureInfo = {
  signature: string;
  slot: number;
  err: unknown;
  memo: string | null;
  blockTime: number | null;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
};

export type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: TokenAmount;
};

/** An instruction in `json` encoding: indexes into the account keys, data in base58. */
export type CompiledInstruction = {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
};

export type TransactionMeta = {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
  innerInstructions?: { index: number; instructions: CompiledInstruction[] }[] | null;
  logMessages?: string[] | null;
  /** Addresses a v0 transaction loaded from lookup tables: after the message's keys, writable first. */
  loadedAddresses?: { writable: string[]; readonly: string[] };
  computeUnitsConsumed?: number;
};

/**
 * A transaction as `getTransaction` returns it in `json` encoding. Version 1
 * messages add `transactionConfig` (compute limit, priority fee) and keep the
 * account keys inline; v0 messages may add `addressTableLookups`.
 */
export type SolanaTransaction = {
  slot: number;
  blockTime: number | null;
  version: 'legacy' | number;
  meta: TransactionMeta | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: {
        numRequiredSignatures: number;
        numReadonlySignedAccounts: number;
        numReadonlyUnsignedAccounts: number;
      };
      instructions: CompiledInstruction[];
      recentBlockhash: string;
      addressTableLookups?: {
        accountKey: string;
        writableIndexes: number[];
        readonlyIndexes: number[];
      }[];
      transactionConfig?: Record<string, unknown>;
    };
  };
};

/**
 * The call every helper goes through: what the real client and the fake both
 * provide. `signal`, when given, cuts the request: the real client hands it
 * to `fetch`.
 */
export type SolanaCall = <T>(
  method: string,
  params: readonly unknown[],
  signal?: AbortSignal,
) => Promise<T>;

export interface SolanaRpc {
  /**
   * Any method; params as the node expects them. Throws a SealError (or
   * BudgetExhaustedError); once `signal` aborts, the signal's reason.
   */
  call<T>(method: string, params?: readonly unknown[], signal?: AbortSignal): Promise<T>;
  /**
   * The same client, every call of it cut when `signal` aborts: the request
   * in flight is aborted and later calls are refused, with the signal's
   * reason. Allowance and pacing stay those of the client it came from.
   * Optional for hand-made test doubles: `abortable` covers them.
   */
  withSignal?(signal: AbortSignal): SolanaRpc;
  /** `null` when no account lives at the address. */
  getAccountInfo(address: string, options?: AccountOptions): Promise<AccountInfo | null>;
  /** In the order asked, `null` where no account lives; sent 100 addresses a call. */
  getMultipleAccounts(
    addresses: readonly string[],
    options?: AccountOptions,
  ): Promise<(AccountInfo | null)[]>;
  /** The 20 largest token accounts of a mint. Not served by the public node. */
  getTokenLargestAccounts(mint: string): Promise<LargestTokenAccount[]>;
  getProgramAccounts(
    programId: string,
    options?: ProgramAccountsOptions,
  ): Promise<ProgramAccount[]>;
  /** The most recent first; `limit` at most 1,000. */
  getSignaturesForAddress(
    address: string,
    options?: { limit?: number; before?: string; until?: string },
  ): Promise<SignatureInfo[]>;
  /** `null` when the node does not have it. Always asks with maxSupportedTransactionVersion 1. */
  getTransaction(
    signature: string,
    options?: { encoding?: 'json' | 'jsonParsed' },
  ): Promise<SolanaTransaction | null>;
  getSlot(): Promise<number>;
}

type WithContext<T> = { context: { slot: number }; value: T };

/** The params each helper sends: the real client and the fake must agree on them. */
function accountConfig(options: AccountOptions = {}): Record<string, unknown> {
  return {
    commitment: COMMITMENT,
    encoding: options.encoding ?? 'base64',
    ...(options.dataSlice ? { dataSlice: options.dataSlice } : {}),
  };
}

/** What a call cut by `signal` rejects with: the reason the signal was aborted with. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new TimeoutError('solana-rpc', 0);
}

/** Both signals; either one aborting aborts it. */
export function eitherSignal(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b || a === b) return a;
  return AbortSignal.any([a, b]);
}

/**
 * `run()`, settled as soon as `signal` aborts even when the call underneath
 * does not listen to it (a fake node, a call waiting for its turn): it then
 * rejects with the signal's reason. A call never starts on an aborted signal.
 */
export function cutBy<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!signal) return run();
  if (signal.aborted) return quietly(Promise.reject(abortReason(signal)));
  const settled: Promise<T> = new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // Readers start calls in parallel and await them one by one: a cut
      // call nobody awaits any more is not an unhandled error.
      quietly(settled);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    run().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        // Once aborted, the abort's reason has already settled it: a later
        // rejection (the fetch's own AbortError) is dropped.
        reject(signal.aborted ? abortReason(signal) : error);
      },
    );
  });
  return settled;
}

/** `promise`, its rejection marked as handled; whoever awaits it still gets it. */
function quietly<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** The methods of a `SolanaRpc`, `call` and its helpers. */
const RPC_METHODS = [
  'call',
  'getAccountInfo',
  'getMultipleAccounts',
  'getTokenLargestAccounts',
  'getProgramAccounts',
  'getSignaturesForAddress',
  'getTransaction',
  'getSlot',
] as const;

/** The methods `solanaRpcFrom` builds: they send through its `call`, which carries the signal. */
const BUILT = new WeakSet<object>();

/**
 * `rpc` with its calls cut by `signal`. The methods `solanaRpcFrom` built
 * are taken from `rpc.withSignal(signal)`, so the signal reaches the request
 * itself; a method set by hand on top of them (a test double overriding one
 * helper, a reader's own meter) is kept, and settled by the abort.
 */
export function abortable(rpc: SolanaRpc, signal: AbortSignal | undefined): SolanaRpc {
  if (!signal) return rpc;
  const base: SolanaRpc = rpc.withSignal
    ? rpc.withSignal(signal)
    : solanaRpcFrom(
        <T>(method: string, params: readonly unknown[], own?: AbortSignal) =>
          rpc.call<T>(method, params, own),
        signal,
      );
  const out: Record<string, unknown> = { ...base };
  for (const key of RPC_METHODS) {
    const own = rpc[key] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof own !== 'function' || BUILT.has(own)) continue;
    out[key] =
      key === 'call'
        ? (method: string, params: readonly unknown[] = [], extra?: AbortSignal) => {
            const cut = eitherSignal(signal, extra);
            return cutBy(cut, () => own.call(rpc, method, params, cut));
          }
        : (...args: unknown[]) => cutBy(signal, () => own.apply(rpc, args));
  }
  out.withSignal = (next: AbortSignal) => abortable(rpc, eitherSignal(signal, next) as AbortSignal);
  return out as unknown as SolanaRpc;
}

/**
 * The helpers, built on any `call`. Each call carries `signal` (and the
 * caller's own, when it gives one), and is cut by it.
 */
export function solanaRpcFrom(call: SolanaCall, signal?: AbortSignal): SolanaRpc {
  const send = <T>(method: string, params: readonly unknown[], own?: AbortSignal): Promise<T> => {
    const cut = eitherSignal(signal, own);
    return cutBy(cut, () => call<T>(method, params, cut));
  };
  return helpers(send, (next) => solanaRpcFrom(call, eitherSignal(signal, next)));
}

function helpers(call: SolanaCall, withSignal: (signal: AbortSignal) => SolanaRpc): SolanaRpc {
  const built = builtHelpers(call, withSignal);
  for (const key of RPC_METHODS) BUILT.add(built[key]);
  return built;
}

function builtHelpers(call: SolanaCall, withSignal: (signal: AbortSignal) => SolanaRpc): SolanaRpc {
  return {
    call: <T>(method: string, params: readonly unknown[] = [], signal?: AbortSignal) =>
      call<T>(method, params, signal),

    withSignal,

    async getAccountInfo(address, options) {
      const answer = await call<WithContext<AccountInfo | null>>('getAccountInfo', [
        address,
        accountConfig(options),
      ]);
      return answer.value;
    },

    async getMultipleAccounts(addresses, options) {
      const out: (AccountInfo | null)[] = [];
      for (let i = 0; i < addresses.length; i += MAX_MULTIPLE_ACCOUNTS) {
        const chunk = addresses.slice(i, i + MAX_MULTIPLE_ACCOUNTS);
        const answer = await call<WithContext<(AccountInfo | null)[]>>('getMultipleAccounts', [
          chunk,
          accountConfig(options),
        ]);
        if (!Array.isArray(answer.value) || answer.value.length !== chunk.length) {
          throw new UpstreamError(
            'solana-rpc',
            'getMultipleAccounts: answer does not match the request',
          );
        }
        out.push(...answer.value);
      }
      return out;
    },

    async getTokenLargestAccounts(mint) {
      const answer = await call<WithContext<LargestTokenAccount[]>>('getTokenLargestAccounts', [
        mint,
        { commitment: COMMITMENT },
      ]);
      return answer.value;
    },

    getProgramAccounts(programId, options = {}) {
      return call<ProgramAccount[]>('getProgramAccounts', [
        programId,
        { ...accountConfig(options), ...(options.filters ? { filters: options.filters } : {}) },
      ]);
    },

    getSignaturesForAddress(address, options = {}) {
      return call<SignatureInfo[]>('getSignaturesForAddress', [
        address,
        {
          commitment: COMMITMENT,
          limit: Math.min(options.limit ?? MAX_SIGNATURES_PAGE, MAX_SIGNATURES_PAGE),
          ...(options.before ? { before: options.before } : {}),
          ...(options.until ? { until: options.until } : {}),
        },
      ]);
    },

    getTransaction(signature, options = {}) {
      return call<SolanaTransaction | null>('getTransaction', [
        signature,
        {
          commitment: COMMITMENT,
          encoding: options.encoding ?? 'json',
          maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION,
        },
      ]);
    },

    getSlot() {
      return call<number>('getSlot', [{ commitment: COMMITMENT }]);
    },
  };
}

/**
 * An address's signatures, the most recent first, page after page until the
 * oldest or `maxPages`. `complete` is false when pages remained: the oldest
 * signature returned is then not the address's first.
 */
export async function collectSignatures(
  rpc: SolanaRpc,
  address: string,
  options: { maxPages?: number; until?: string; pageSize?: number } = {},
): Promise<{ signatures: SignatureInfo[]; complete: boolean }> {
  const { maxPages = 5, until, pageSize = MAX_SIGNATURES_PAGE } = options;
  const signatures: SignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await rpc.getSignaturesForAddress(address, {
      limit: pageSize,
      ...(before ? { before } : {}),
      ...(until ? { until } : {}),
    });
    signatures.push(...batch);
    if (batch.length < pageSize) return { signatures, complete: true };
    before = batch[batch.length - 1]?.signature;
  }
  return { signatures, complete: false };
}

/** The bytes of an account asked as base64; `null` when the node sent parsed JSON. */
export function accountBytes(info: Pick<AccountInfo, 'data'>): Uint8Array | null {
  const data = info.data;
  if (!Array.isArray(data) || data[1] !== 'base64') return null;
  return base64.decode(data[0]);
}

/** The parsed JSON of an account asked as jsonParsed; `null` when the node sent bytes. */
export function parsedAccount(info: Pick<AccountInfo, 'data'>): ParsedAccountData | null {
  const data = info.data;
  return Array.isArray(data) ? null : data;
}

/**
 * Every account key of a `json` transaction, in the order instruction indexes
 * use: the message's keys, then the lookup tables' writable, then readonly.
 */
export function transactionKeys(tx: SolanaTransaction): string[] {
  const loaded = tx.meta?.loadedAddresses;
  return [
    ...tx.transaction.message.accountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ];
}

// ── The real client ─────────────────────────────────────────────────────────

export type RecordedCall = {
  method: string;
  /** Omitted in a fixture: the entry answers this method whatever the params. */
  params?: unknown[];
  result?: unknown;
  error?: { code: number; message: string };
  /**
   * No configured node serves the method (the public node and
   * `getTokenLargestAccounts`): the client refused it without a request.
   */
  unavailable?: true;
};

export type SolanaRpcOptions = {
  /** The nodes, in order; `solanaRpcNodes()` when omitted. */
  nodes?: SolanaNode[];
  /**
   * Calls the whole analysis may spend, every reader together, each retry
   * and each node tried counting one: the global ceiling of one analysis.
   */
  maxCalls?: number;
  /** Or a budget shared with other clients of the same read. */
  budget?: RequestBudget;
  /** Calls a second on each node; the measured defaults otherwise. */
  rate?: (node: SolanaNode) => number;
  /** Every answer, as a fixture entry: to record a read for the tests. */
  record?: (entry: RecordedCall) => void;
  /**
   * Cuts every request of this client when the caller runs out of time; a
   * reader adds its own with `withSignal`.
   */
  signal?: AbortSignal;
  /** Waits (pacing, backoff); injectable so that no test sleeps for real. */
  sleep?: (ms: number) => Promise<void>;
};

type JsonRpcAnswer = { result?: unknown; error?: { code: number; message: string } };

function defaultRate(node: SolanaNode): number {
  if (node.public) return PUBLIC_RATE;
  const raw = Number(process.env.SEAL_SOLANA_RPC_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : KEYED_RATE;
}

/** Rate limits a node said in its JSON-RPC answer, not in its HTTP status. */
const busyAnswers = new WeakSet<object>();
const busyAnswer = <E extends object>(error: E): E => {
  busyAnswers.add(error);
  return error;
};

/** Nodes set aside, until when. Shared by the clients of this process. */
const setAside = new Map<string, number>();

export function resetSolanaNodes(): void {
  setAside.clear();
}

export type SolanaRpcClient = SolanaRpc & {
  /** Calls spent so far by this client (each attempt counts), and its allowance. */
  usage(): { spent: number; max: number };
};

export function createSolanaRpc(options: SolanaRpcOptions = {}): SolanaRpcClient {
  const nodes = options.nodes ?? solanaRpcNodes();
  const budget = options.budget ?? createBudget(options.maxCalls ?? DEFAULT_MAX_CALLS);
  const rateOf = options.rate ?? defaultRate;
  let nextId = 1;

  async function send(
    node: SolanaNode,
    method: string,
    params: readonly unknown[],
    last: boolean,
    signal: AbortSignal | undefined,
  ) {
    const rate = rateOf(node);
    // A call cut while it waits for its turn leaves the queue without
    // taking one: the readers still running are not held behind it.
    await throttle(node.url, 1, {
      rate,
      burst: node.public ? Math.min(PUBLIC_BURST, rate) : Math.max(KEYED_BURST, rate),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      throw signal?.aborted ? abortReason(signal) : error;
    });
    // Cut while it waited for its turn: nothing is sent, nothing is spent.
    if (signal?.aborted) throw abortReason(signal);
    const response = await request(node.url, {
      source: 'solana-rpc',
      ...(options.sleep ? { sleep: options.sleep } : {}),
      // Only the last node, with nobody to hand over to, insists.
      retries: last ? 3 : 0,
      ...(last ? {} : { timeoutMs: HANDOVER_TIMEOUT_MS }),
      minRateLimitWaitMs: RATE_LIMIT_WAIT_MS,
      // A node refusing the key (Alchemy: network not enabled for the app) is
      // not busy: waiting would only hide it until the deadline.
      forbiddenIsAnswer: true,
      budget,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        ...(signal ? { signal } : {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      // Never its body: it may name the app or the key's network page. Only
      // the kind of refusal is kept.
      const reason = refusalReason(await response.text().catch(() => ''));
      throw new UpstreamError(
        'solana-rpc',
        `${method}: node refused the request (HTTP ${response.status}, ${reason})`,
        response.status,
      );
    }
    let body: JsonRpcAnswer;
    try {
      body = (await response.json()) as JsonRpcAnswer;
    } catch (error) {
      throw new UpstreamError(
        'solana-rpc',
        `${method}: unreadable JSON answer`,
        response.status,
        error,
      );
    }
    if (response.status >= 400 && !body.error) {
      throw new UpstreamError(
        'solana-rpc',
        `${method}: node answered ${response.status}`,
        response.status,
      );
    }
    if (body.error) {
      if (body.error.code === 429) throw busyAnswer(new RateLimitError('solana-rpc'));
      throw new SolanaRpcError(body.error.code, method, body.error.message);
    }
    if (!('result' in body)) {
      throw new UpstreamError('solana-rpc', `${method}: answer without a result`);
    }
    return body;
  }

  /**
   * The last node, with nobody to hand over to: an answer saying it is busy
   * or unhealthy gets a few more tries, after a wait (the rate-limit floor
   * for a 429). Every try is a call spent.
   */
  async function sendLast(
    node: SolanaNode,
    method: string,
    params: readonly unknown[],
    signal: AbortSignal | undefined,
  ) {
    const wait = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send(node, method, params, true, signal);
      } catch (error) {
        const busy =
          busyAnswers.has(error as object) ||
          (error instanceof SolanaRpcError && error.retryable && !error.aboutRequest);
        if (!busy || attempt >= BODY_RETRIES || signal?.aborted) throw error;
        const floor = error instanceof RateLimitError ? RATE_LIMIT_WAIT_MS : 0;
        await wait(Math.max(floor, backoffDelay(attempt)));
      }
    }
  }

  /**
   * A node with someone to hand over to. A keyed node's 429 is its per-second
   * limit, over in a moment: it is asked again, after its `Retry-After` (2 s
   * at most) or a short backoff, before the call goes to the next node, the
   * public one, which serves three calls a second. Every try is a call spent.
   */
  async function sendFirst(
    node: SolanaNode,
    method: string,
    params: readonly unknown[],
    signal: AbortSignal | undefined,
  ) {
    const wait = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send(node, method, params, false, signal);
      } catch (error) {
        const again =
          error instanceof RateLimitError &&
          !node.public &&
          attempt < KEYED_RATE_LIMIT_RETRIES &&
          !signal?.aborted;
        if (!again) throw error;
        const asked = error.retryAfterSeconds;
        if (asked !== undefined && asked * 1000 > KEYED_RETRY_AFTER_MAX_MS) throw error;
        await wait(asked !== undefined ? Math.max(100, asked * 1000) : 250 * 2 ** attempt);
      }
    }
  }

  const call: SolanaCall = async <T>(
    method: string,
    params: readonly unknown[],
    own?: AbortSignal,
  ) => {
    const signal = eitherSignal(options.signal, own);
    if (signal?.aborted) throw abortReason(signal);
    const now = Date.now();
    const usable = nodes.filter((node) => serves(node, method));
    if (usable.length === 0) {
      options.record?.({ method, params: [...params], unavailable: true });
      throw new MethodUnavailableError(method);
    }
    const aside = (node: SolanaNode) => (setAside.get(node.url) ?? 0) > now;
    const ordered = [...usable.filter((n) => !aside(n)), ...usable.filter(aside)];

    let lastError: unknown;
    for (const [index, node] of ordered.entries()) {
      const last = index === ordered.length - 1;
      try {
        const body = last
          ? await sendLast(node, method, params, signal)
          : await sendFirst(node, method, params, signal);
        options.record?.({ method, params: [...params], result: body.result });
        return body.result as T;
      } catch (error) {
        lastError = error;
        // The caller's own abort: the node is not at fault, and the next one
        // would be cut the same way.
        if (signal?.aborted) throw abortReason(signal);
        // A spent allowance would be the same on the next node.
        if (error instanceof BudgetExhaustedError || !(error instanceof SealError)) throw error;
        // The node answered, and the answer is about the request: no other node will differ.
        if (error instanceof SolanaRpcError && error.aboutRequest) {
          options.record?.({
            method,
            params: [...params],
            error: { code: error.code, message: error.detail },
          });
          throw error;
        }
        log.warn('nœud Solana en échec', { node: node.label, method, error: error.kind });
        // A node refusing one method (its plan, its history) still serves the others.
        const nodeWide = !(error instanceof SolanaRpcError) || error.retryable;
        if (!last && nodeWide) {
          setAside.set(
            node.url,
            Date.now() + (error instanceof RateLimitError ? RATE_LIMITED_ASIDE_MS : SET_ASIDE_MS),
          );
        }
      }
    }
    // Refused by every node for its rate: a recording replays the same refusal.
    if (lastError instanceof RateLimitError) {
      options.record?.({
        method,
        params: [...params],
        error: { code: 429, message: 'Too many requests' },
      });
    }
    throw lastError;
  };

  return {
    ...solanaRpcFrom(call),
    usage: () => ({ spent: budget.spent, max: budget.max }),
  };
}

/** Why a node refused, in one word, from its answer; the answer itself is never kept. */
export function refusalReason(body: string): 'network' | 'key' | 'allowlist' | 'plan' | 'other' {
  if (/not enabled|enable the network|network.*disabled/i.test(body)) return 'network';
  if (/allowlist|whitelist|origin|not allowed from|ip address/i.test(body)) return 'allowlist';
  if (/authenticat|api key|invalid key|unauthori[sz]ed/i.test(body)) return 'key';
  if (/plan|upgrade|tier|capacity/i.test(body)) return 'plan';
  return 'other';
}
