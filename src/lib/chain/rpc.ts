import { RateLimitError, TimeoutError, UpstreamError } from '../errors';
import { request, type RequestBudget } from '../http';

/**
 * Client JSON-RPC minimal pour Robinhood Chain.
 *
 * Il passe par le wrapper HTTP commun (timeout, retry, budget) et traduit les
 * erreurs JSON-RPC en erreurs typées — le RPC public répond volontiers 200 avec
 * une erreur dans le corps, ce que `fetch` seul ne signalerait pas.
 */

export const ROBINHOOD_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

export type RpcRequest = { method: string; params: unknown[] };

/** Résultat d'un appel groupé : succès ou erreur, par requête. */
export type BatchOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export type RpcClient = {
  call<T>(method: string, params: unknown[]): Promise<T>;
  /**
   * Envoie plusieurs appels en une seule requête HTTP.
   *
   * Vérifié sur Robinhood Chain : le batch JSON-RPC est supporté. C'est ce qui
   * rend un historique profond envisageable — sans lui, lire l'état de
   * graduation de 40 tokens coûte 40 allers-retours sur un RPC public qui
   * répond 403 après une rafale.
   *
   * Chaque entrée réussit ou échoue indépendamment : un token dont l'appel
   * revert ne doit pas faire échouer les 39 autres.
   */
  callBatch<T>(requests: RpcRequest[]): Promise<BatchOutcome<T>[]>;
};

type JsonRpcResponse<T> = {
  id?: number;
  result?: T;
  error?: { code: number; message: string };
};

/** Au-delà, certains nœuds refusent la requête entière. Valeur prudente. */
export const MAX_BATCH_SIZE = 20;

/** Les trois façons dont `eth_getLogs` refuse de répondre. Mesurées, pas supposées. */
export class LogQueryTooBroadError extends Error {
  constructor(
    readonly reason: 'too-many-results' | 'timeout' | 'range-too-wide',
    /** Maximum span the node accepts, when it states one in its message. */
    readonly maxSpan?: number,
  ) {
    super(
      reason === 'too-many-results'
        ? 'eth_getLogs : results exceed the node limit'
        : reason === 'range-too-wide'
          ? `eth_getLogs : block range too wide${maxSpan ? ` (max ${maxSpan} blocks)` : ''}`
          : 'eth_getLogs : request timed out at the node',
    );
    this.name = 'LogQueryTooBroadError';
  }
}

/**
 * Reconnaît une erreur qui veut dire « ta fenêtre est trop large ».
 * Le message diffère selon le cas, la réponse est la même : resserrer.
 */
export function classifyLogError(message: string): LogQueryTooBroadError | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('exceeds limit')) return new LogQueryTooBroadError('too-many-results');

  // The node states its own maximum in the message:
  //   "query spans 859987 blocks (…), but only 30000 are allowed for this request"
  // Reading it beats halving blindly — starting at 500k for a 30k ceiling burns
  // five refused requests before the first accepted one, on an RPC that cuts the
  // caller off after about nine.
  const allowed = /only (\d+) (?:are|is) allowed/.exec(lower);
  if (allowed?.[1]) {
    return new LogQueryTooBroadError('range-too-wide', Number(allowed[1]));
  }
  if (lower.includes('block range') || lower.includes('narrow the block range')) {
    return new LogQueryTooBroadError('range-too-wide');
  }

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return new LogQueryTooBroadError('timeout');
  }
  return undefined;
}

/**
 * Pacing for the public node, measured on 14/10/2026:
 *  - a batch of 20 `eth_getLogs` goes through, the next one sent right after
 *    gets 429 and keeps getting it for about five seconds;
 *  - 60 single `eth_getLogs` at 4 per second all go through.
 * So: a burst of about 20 log queries, refilled at about 4 per second, every
 * entry of a batch counting as one.
 *
 * The bucket is shared by every client of the same URL in this process, so
 * concurrent analyses on one server instance pace each other too.
 */
export const RPC_BURST = 20;
export const RPC_CALLS_PER_SECOND = 4;

/** A paid node allows more: `SEAL_RPC_RATE` raises the refill without a code change. */
function configuredRate(): number {
  const raw = Number(process.env.SEAL_RPC_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : RPC_CALLS_PER_SECOND;
}

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();

/** Waits until `cost` calls fit in the allowance, then spends them. */
export async function throttle(
  url: string,
  cost: number,
  options: {
    rate?: number;
    burst?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const rate = options.rate ?? configuredRate();
  const burst = Math.max(options.burst ?? RPC_BURST, rate);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const need = Math.min(cost, burst);
  const bucket = buckets.get(url) ?? { tokens: burst, updatedAt: now() };
  buckets.set(url, bucket);
  for (;;) {
    const t = now();
    bucket.tokens = Math.min(burst, bucket.tokens + ((t - bucket.updatedAt) / 1000) * rate);
    bucket.updatedAt = t;
    if (bucket.tokens >= need) {
      bucket.tokens -= need;
      return;
    }
    await sleep(Math.ceil(((need - bucket.tokens) / rate) * 1000));
  }
}

/**
 * Only `eth_getLogs` is limited: 120 `eth_getBlockByNumber` in six immediate
 * batches all went through (14/10/2026). Pacing cheap calls only slowed down
 * creators with many launches.
 */
export function logQueries(payload: unknown): number {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.filter((e) => (e as { method?: string } | null)?.method === 'eth_getLogs').length;
}

/** Forget the pacing state. For tests. */
export function resetThrottle(): void {
  buckets.clear();
}

/** After a 429 the node needs seconds, not the generic 0.2 s backoff. */
const RPC_RATE_LIMIT_WAIT_MS = 2_500;

/**
 * Where log queries go. Keyed providers rarely allow what this pipeline needs:
 * Alchemy's free tier caps `eth_getLogs` at 10 blocks per request, against the
 * 10,000,000 the public node accepts for a single address. So a keyed
 * `RPC_URL` serves the plain calls, and log queries stay on the public node
 * (paced) unless `LOGS_RPC_URL` names a node that does better.
 */
export function logsRpcUrl(env: Record<string, string | undefined> = process.env): string {
  return env.LOGS_RPC_URL || DEFAULT_RPC_URL;
}

export function createRpcClient(
  url: string = DEFAULT_RPC_URL,
  budget?: RequestBudget,
  logsUrl: string = logsRpcUrl(),
): RpcClient {
  async function post(payload: unknown): Promise<Response> {
    const cost = logQueries(payload);
    const target = cost > 0 ? logsUrl : url;
    if (cost > 0) await throttle(target, cost);
    return request(target, {
      source: 'robinhood-rpc',
      retries: 3,
      minRateLimitWaitMs: RPC_RATE_LIMIT_WAIT_MS,
      budget,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    });
  }

  return {
    async callBatch<T>(requests: RpcRequest[]): Promise<BatchOutcome<T>[]> {
      if (requests.length === 0) return [];

      const results: BatchOutcome<T>[] = [];
      for (let offset = 0; offset < requests.length; offset += MAX_BATCH_SIZE) {
        const slice = requests.slice(offset, offset + MAX_BATCH_SIZE);
        const response = await post(
          slice.map((r, i) => ({ jsonrpc: '2.0', id: offset + i, ...r })),
        );
        const body = (await response.json()) as JsonRpcResponse<T>[] | JsonRpcResponse<T>;

        if (!Array.isArray(body)) {
          // Le nœud a répondu à un batch par un objet : erreur globale.
          throw new UpstreamError(
            'robinhood-rpc',
            `batch : ${body.error?.message ?? 'réponse inattendue'}`,
          );
        }

        // L'ordre des réponses n'est pas garanti par la spec : on réaligne sur les id.
        const byId = new Map(body.map((entry) => [entry.id, entry]));
        for (let i = 0; i < slice.length; i += 1) {
          const entry = byId.get(offset + i);
          if (!entry || entry.error) {
            results.push({ ok: false, error: entry?.error?.message ?? 'réponse absente' });
          } else {
            results.push({ ok: true, value: entry.result as T });
          }
        }
      }
      return results;
    },

    async call<T>(method: string, params: unknown[]): Promise<T> {
      const response = await post({ jsonrpc: '2.0', id: 1, method, params });

      const body = (await response.json()) as JsonRpcResponse<T>;

      if (body.error) {
        const tooBroad = classifyLogError(body.error.message);
        if (tooBroad) throw tooBroad;
        // -32005 est la convention pour « limite dépassée » côté JSON-RPC.
        if (body.error.code === -32005 || body.error.code === 429)
          throw new RateLimitError('robinhood-rpc');
        throw new UpstreamError('robinhood-rpc', `${method} : ${body.error.message}`);
      }

      if (body.result === undefined) {
        throw new UpstreamError('robinhood-rpc', `${method} : response without a result`);
      }
      return body.result;
    },
  };
}

export { RateLimitError, TimeoutError };
