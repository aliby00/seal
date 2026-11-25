import { RateLimitError } from '../errors';
import {
  MethodUnavailableError,
  SolanaRpcError,
  solanaRpcFrom,
  type RecordedCall,
  type SolanaCall,
  type SolanaRpc,
} from './rpc';

/**
 * A Solana node that answers from recorded responses, for the tests: no test
 * of this repository reaches the network.
 *
 * A recording is `{ method, params?, result?, error?, unavailable? }`, the shape the real
 * client hands to its `record` option and the shape of the fixtures under
 * `tests/fixtures/solana/<zone>/*.json` (one entry or an array per file).
 * A call matches the entry with the same method and the same params, compared
 * as canonical JSON (object keys sorted); an entry without `params` answers
 * the method whatever the params. The first matching entry wins.
 *
 * Since the helpers build their params the same way for both, a recording
 * made through `createSolanaRpc({ record })` is answered here as is.
 */

/** JSON with object keys sorted, `undefined` fields dropped: the same value, the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The key a call is matched on. */
export function recordingKey(method: string, params: readonly unknown[]): string {
  return `${method} ${canonicalJson(params)}`;
}

/** A call no recording answers: the test is missing a fixture, or the code asks something new. */
export class MissingRecordingError extends Error {
  constructor(
    readonly method: string,
    readonly params: readonly unknown[],
  ) {
    super(`fake Solana RPC: no recording for ${method} ${canonicalJson(params)}`);
    this.name = 'MissingRecordingError';
  }
}

export type FakeSolanaRpc = SolanaRpc & {
  /** Every call made, in order. */
  readonly calls: { method: string; params: unknown[] }[];
};

export type FakeSolanaRpcOptions = {
  /**
   * Replays the answers to one call in the order they were recorded: the
   * n-th identical call gets the n-th answer, the last one repeating. A whole
   * collection asks some calls more than once (a page of a busy mint's
   * history, by two readers seconds apart) and the node answered each time
   * what it held then. Otherwise the first recorded answer serves them all.
   */
  sequential?: boolean;
};

export function createFakeSolanaRpc(
  recordings: readonly RecordedCall[],
  options: FakeSolanaRpcOptions = {},
): FakeSolanaRpc {
  const exact = new Map<string, RecordedCall[]>();
  const anyParams = new Map<string, RecordedCall>();
  for (const entry of recordings) {
    if (entry.params === undefined) {
      if (!anyParams.has(entry.method)) anyParams.set(entry.method, entry);
    } else {
      const key = recordingKey(entry.method, entry.params);
      const list = exact.get(key) ?? [];
      if (options.sequential || list.length === 0) list.push(entry);
      exact.set(key, list);
    }
  }
  const asked = new Map<string, number>();
  const answerTo = (key: string): RecordedCall | undefined => {
    const list = exact.get(key);
    if (!list) return undefined;
    const n = asked.get(key) ?? 0;
    asked.set(key, n + 1);
    return list[Math.min(n, list.length - 1)];
  };
  const calls: { method: string; params: unknown[] }[] = [];

  const call: SolanaCall = async <T>(method: string, params: readonly unknown[]) => {
    calls.push({ method, params: [...params] });
    const entry = answerTo(recordingKey(method, params)) ?? anyParams.get(method);
    if (!entry) throw new MissingRecordingError(method, params);
    // Refused by the client itself, as the real one does for the public node.
    if (entry.unavailable) throw new MethodUnavailableError(method);
    if (entry.error) {
      // The errors the real client would throw for the same answer.
      if (entry.error.code === 429) throw new RateLimitError('solana-rpc');
      throw new SolanaRpcError(entry.error.code, method, entry.error.message);
    }
    // A copy: a reader changing what it got must not change the next answer.
    return structuredClone(entry.result) as T;
  };

  return { ...solanaRpcFrom(call), calls };
}
