import { RateLimitError, SealError, TimeoutError, UpstreamError } from '../errors';
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
  // The public node says "exceeds limit"; geth-style nodes "query returned
  // more than 10000 results"; Alchemy "Log response size exceeded".
  if (
    lower.includes('exceeds limit') ||
    lower.includes('returned more than') ||
    lower.includes('response size exceeded')
  )
    return new LogQueryTooBroadError('too-many-results');

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

/**
 * A paid node allows more: `SEAL_RPC_RATE` raises its refill without a code
 * change. The public node keeps its measured pace whatever the setting, since
 * it closes every list of nodes and would be the one cutting the caller off.
 */
export function configuredRate(url?: string): number {
  // `SEAL_PUBLIC_RPC_RATE` exists for the tests, whose fake node never limits.
  const raw = Number(
    url === DEFAULT_RPC_URL ? process.env.SEAL_PUBLIC_RPC_RATE : process.env.SEAL_RPC_RATE,
  );
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
  const rate = options.rate ?? configuredRate(url);
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

/**
 * A node slower than this on one request is set aside for a while. A keyed
 * provider throttling us answered log queries in 6 to 9 s against 0.15 s on
 * the public node (19/10/2026): tried first on every query, it alone pushed
 * analyses past their time limit.
 */
export const SLOW_NODE_MS = 3_000;
export const SET_ASIDE_MS = 60_000;
/** A node that is not the last one gets this long before it is given up. */
export const HANDOVER_TIMEOUT_MS = 6_000;
/**
 * Past this, the same request also goes to the next node. Both nodes answer
 * log queries in about 0.2 s when well; the keyed one sometimes takes 8 s.
 */
export const HEDGE_MS = 1_500;

/** Nodes set aside, until when. Shared by the clients of this process. */
const setAside = new Map<string, number>();

/** The nodes in their order, those set aside moved behind the others. */
export function byHealth(targets: readonly string[], now = Date.now()): string[] {
  const aside = (t: string) => (setAside.get(t) ?? 0) > now;
  return [...targets.filter((t) => !aside(t)), ...targets.filter(aside)];
}

/** Forget the pacing state and the nodes set aside. For tests. */
export function resetThrottle(): void {
  buckets.clear();
  setAside.clear();
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
  return logsRpcUrls(env)[0] ?? DEFAULT_RPC_URL;
}

/** `a, b ,c` → ['a', 'b', 'c']: one variable can name several nodes. */
export function parseRpcUrls(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Nodes in the order they are tried. A node that is down, slow or rate-limited
 * hands the request to the next one; the public node always closes the list,
 * so a paid provider failing degrades the analysis instead of stopping it.
 */
function withFallbacks(...lists: string[][]): string[] {
  return [...new Set([...lists.flat(), DEFAULT_RPC_URL])];
}

export function rpcUrls(
  primary: string | undefined = process.env.RPC_URL,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return withFallbacks(parseRpcUrls(primary), parseRpcUrls(env.RPC_URL_FALLBACK));
}

export function logsRpcUrls(env: Record<string, string | undefined> = process.env): string[] {
  return withFallbacks(parseRpcUrls(env.LOGS_RPC_URL), parseRpcUrls(env.LOGS_RPC_URL_FALLBACK));
}

/** A JSON-RPC error that means "this node is busy", sent with a 200. */
function busyNodeError(body: unknown): boolean {
  if (Array.isArray(body) || typeof body !== 'object' || body === null) return false;
  const code = (body as JsonRpcResponse<unknown>).error?.code;
  return code === 429 || code === -32005;
}

export function createRpcClient(
  url: string | string[] = DEFAULT_RPC_URL,
  budget?: RequestBudget,
  logsUrl: string | string[] = logsRpcUrls(),
): RpcClient {
  const plainTargets = Array.isArray(url) ? withFallbacks(url) : rpcUrls(url);
  const logTargets = Array.isArray(logsUrl) ? withFallbacks(logsUrl) : withFallbacks([logsUrl]);

  async function attempt(target: string, payload: unknown, cost: number, last: boolean) {
    if (cost > 0) await throttle(target, cost);
    // Timed from here: waiting on our own pacing is not the node being slow.
    const sent = Date.now();
    const response = await request(target, {
      source: 'robinhood-rpc',
      // Retrying a failing node delays the next one: only the last node,
      // with nobody left to hand over to, insists.
      retries: last ? 3 : 0,
      ...(last ? {} : { timeoutMs: HANDOVER_TIMEOUT_MS }),
      minRateLimitWaitMs: RPC_RATE_LIMIT_WAIT_MS,
      budget,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    });
    try {
      const body = (await response.json()) as unknown;
      return { status: response.status, body, ms: Date.now() - sent };
    } catch (error) {
      throw new UpstreamError('robinhood-rpc', 'unreadable JSON response', response.status, error);
    }
  }

  /**
   * Sends to the first healthy node. One that has not answered within
   * HEDGE_MS gets company: the same request goes to the next node too, and
   * the first good answer wins. A node that was slow, down or busy is set
   * aside for a minute so the requests after it do not wait on it either.
   */
  function post(payload: unknown): Promise<unknown> {
    const cost = logQueries(payload);
    const targets = byHealth(cost > 0 ? logTargets : plainTargets);
    if (targets.length === 0) {
      return Promise.reject(new UpstreamError('robinhood-rpc', 'no node configured'));
    }
    const bench = (target: string) => {
      if (targets.length > 1) setAside.set(target, Date.now() + SET_ASIDE_MS);
    };
    return new Promise((resolve, reject) => {
      let next = 0;
      let pending = 0;
      let settled = false;
      let hedge: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(hedge);
        outcome();
      };
      const launch = (): boolean => {
        if (settled || next >= targets.length) return false;
        const target = targets[next] as string;
        const last = next === targets.length - 1;
        next += 1;
        pending += 1;
        clearTimeout(hedge);
        if (!last) {
          hedge = setTimeout(() => {
            if (settled) return;
            bench(target);
            launch();
          }, HEDGE_MS);
        }
        const handOver = (error: unknown) => {
          pending -= 1;
          if (settled) return;
          // Nobody left to try and nothing still on its way: this is the answer.
          if (!launch() && pending === 0) finish(() => reject(error));
        };
        attempt(target, payload, cost, last).then(
          ({ status, body, ms }) => {
            if (ms > SLOW_NODE_MS) bench(target);
            // A keyed node refusing the request (bad key, plan limit) answers
            // 400/401 with a JSON error: the next node may well accept it.
            if (!last && (status >= 400 || busyNodeError(body))) {
              if (status === 429 || status >= 500 || busyNodeError(body)) bench(target);
              handOver(new UpstreamError('robinhood-rpc', `node answered ${status}`, status));
              return;
            }
            pending -= 1;
            finish(() => resolve(body));
          },
          (error: unknown) => {
            // Any node-side failure — down, slow, rate-limited, refusing the
            // key, garbled answer — hands over. A spent analysis budget does
            // not: it would be just as spent on the next node.
            if (!(error instanceof SealError)) {
              pending -= 1;
              finish(() => reject(error));
              return;
            }
            if (!last) bench(target);
            handOver(error);
          },
        );
        return true;
      };
      launch();
    });
  }

  return {
    async callBatch<T>(requests: RpcRequest[]): Promise<BatchOutcome<T>[]> {
      if (requests.length === 0) return [];

      const results: BatchOutcome<T>[] = [];
      for (let offset = 0; offset < requests.length; offset += MAX_BATCH_SIZE) {
        const slice = requests.slice(offset, offset + MAX_BATCH_SIZE);
        const body = (await post(
          slice.map((r, i) => ({ jsonrpc: '2.0', id: offset + i, ...r })),
        )) as JsonRpcResponse<T>[] | JsonRpcResponse<T>;

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
      const body = (await post({ jsonrpc: '2.0', id: 1, method, params })) as JsonRpcResponse<T>;

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
