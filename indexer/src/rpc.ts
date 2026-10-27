/**
 * Client JSON-RPC de l'indexeur. Même logique que `src/lib/chain/rpc.ts`, mais
 * sans dépendance et taillé pour tourner des jours : il ne lève jamais sur une
 * erreur passagère sans avoir d'abord attendu et réessayé.
 *
 * Ce que le nœud public accepte, mesuré le 17/10/2026 :
 *  - `eth_getLogs` sans adresse : 30 000 blocs max, et 10 000 logs max par réponse ;
 *  - liste d'adresses : 100 000 blocs max, 1 000 sélecteurs (adresses + topics) max ;
 *  - une seule adresse : 10 000 000 blocs max ;
 *  - au-delà de ~4 requêtes/s, ou après quelques réponses de plusieurs Mo,
 *    429 « Too Many Requests » pendant plusieurs secondes, pour toute l'IP.
 */

export type Log = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

export type LogFilter = {
  address?: string | string[];
  topics: (string | null)[];
  fromBlock: number;
  toBlock: number;
};

/** « Ta fenêtre est trop large » : la seule réponse utile est de la resserrer. */
export class TooBroadError extends Error {
  readonly maxSpan: number | undefined;
  constructor(message: string, maxSpan?: number) {
    super(message);
    this.name = 'TooBroadError';
    this.maxSpan = maxSpan;
  }
}

/** Le nœud a refusé une liste d'adresses trop longue : c'est la liste qu'il faut couper. */
export class TooManySelectorsError extends Error {
  readonly max: number | undefined;
  constructor(message: string, max?: number) {
    super(message);
    this.name = 'TooManySelectorsError';
    this.max = max;
  }
}

export class RpcError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'RpcError';
    this.transient = transient;
  }
}

/**
 * Traduit le message d'erreur d'un `eth_getLogs` refusé.
 *
 * Attention au piège : « 1001 address and topic selectors …, but only 1000 are
 * allowed » ressemble au message de plafond de blocs (« only 30000 are
 * allowed ») mais parle de la liste d'adresses, pas de la fenêtre.
 */
export function classifyLogError(message: string): TooBroadError | TooManySelectorsError | null {
  const lower = message.toLowerCase();
  if (lower.includes('selectors')) {
    const max = /only (\d+) (?:are|is) allowed/.exec(lower)?.[1];
    return new TooManySelectorsError(message, max ? Number(max) : undefined);
  }
  if (
    lower.includes('exceeds limit') ||
    lower.includes('returned more than') ||
    lower.includes('response size exceeded')
  ) {
    return new TooBroadError(message);
  }
  const allowed = /only (\d+) (?:are|is) allowed/.exec(lower)?.[1];
  if (allowed) return new TooBroadError(message, Number(allowed));
  if (lower.includes('block range') || lower.includes('narrow the block range')) {
    return new TooBroadError(message);
  }
  if (lower.includes('timed out') || lower.includes('timeout')) return new TooBroadError(message);
  return null;
}

export type RpcRequest = { method: string; params: unknown[] };

export type Rpc = {
  call<T>(method: string, params: unknown[]): Promise<T>;
  /** Une entrée en erreur vaut `null` ; seule une panne de toute la requête lève. */
  batch<T>(requests: RpcRequest[]): Promise<(T | null)[]>;
  getLogs(filter: LogFilter): Promise<Log[]>;
  /** Requêtes HTTP envoyées, et 429 reçus, depuis le démarrage. */
  stats(): { requests: number; rateLimited: number };
};

export type RpcOptions = {
  url: string;
  /** Requêtes `eth_getLogs` par seconde. */
  rate: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Tentatives avant d'abandonner une requête (la boucle appelante réessaiera plus tard). */
  attempts?: number;
  timeoutMs?: number;
  /**
   * Where to go when `url` is out of service: a keyed provider whose monthly
   * quota is spent answers 429 to everything for days (Alchemy, 27/10/2026),
   * and the indexer stopped for lack of a second node.
   */
  fallback?: { url: string; rate: number };
  /** Called when the client moves to the fallback node or back. */
  onSwitch?: (to: 'fallback' | 'primary', reason: string) => void;
};

const BATCH_SIZE = 20;
/** Après un 429 le nœud demande des secondes, pas des millisecondes. */
const RATE_LIMIT_WAIT_MS = 2_500;
const MAX_WAIT_MS = 60_000;
/**
 * Ce qui fait tomber le 429, c'est surtout le volume : quelques réponses de
 * 5 à 10 Mo d'affilée suffisent, même sous 4 requêtes/s. Chaque tranche de
 * 512 Ko reçue coûte donc un jeton de plus, et le débit reste sous ~2 Mo/s.
 */
const BYTES_PER_TOKEN = 512 * 1024;
/** How long the fallback node serves before the primary is tried again. */
export const FALLBACK_MS = 60 * 60 * 1000;
/** 429s in a row from the primary before it is set aside, quota message or not. */
const SWITCH_AFTER_429 = 3;
/** A 429 that will not pass in seconds: the plan's quota is spent. */
const QUOTA_SPENT = /capacity|quota|exceeded your|upgrade/i;

const hex = (n: number): string => `0x${n.toString(16)}`;

export function createRpc(options: RpcOptions): Rpc {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = options.attempts ?? 6;
  const timeoutMs = options.timeoutMs ?? 30_000;
  // Le nœud de repli tant que `fallbackUntil` n'est pas passé.
  let fallbackUntil = 0;
  let primary429 = 0;
  const onFallback = () => options.fallback !== undefined && now() < fallbackUntil;
  const target = () => (onFallback() ? options.fallback!.url : options.url);
  const rateNow = () => (onFallback() ? options.fallback!.rate : options.rate);
  // Une petite rafale seulement : le nœud coupe après ~20 requêtes groupées.
  const burstOf = (rate: number) => Math.max(2, Math.min(8, rate * 2));
  let burst = burstOf(options.rate);
  let tokens = burst;
  let updatedAt = now();
  // Partagé par toutes les boucles : un 429 vaut pour toute l'IP.
  let pausedUntil = 0;
  let penalty = RATE_LIMIT_WAIT_MS;
  let requests = 0;
  let rateLimited = 0;
  // Les boucles passent une à une : sans file, la première à se réveiller
  // prendrait toujours le jeton et une boucle de rattrapage affamerait la tête.
  let queue: Promise<void> = Promise.resolve();

  function throttle(cost: number): Promise<void> {
    const turn = queue.then(async () => {
      for (;;) {
        const t = now();
        if (t < pausedUntil) {
          await sleep(pausedUntil - t);
          continue;
        }
        const rate = rateNow();
        burst = burstOf(rate);
        tokens = Math.min(burst, tokens + ((t - updatedAt) / 1000) * rate);
        updatedAt = t;
        const need = Math.min(cost, burst);
        if (tokens >= need) {
          tokens -= need;
          return;
        }
        await sleep(Math.ceil(((need - tokens) / rate) * 1000));
      }
    });
    queue = turn.catch(() => undefined);
    return turn;
  }

  /** Sets the primary aside for an hour; the fallback starts with a fresh allowance. */
  function toFallback(reason: string): void {
    if (!options.fallback || onFallback()) return;
    fallbackUntil = now() + FALLBACK_MS;
    primary429 = 0;
    pausedUntil = 0;
    penalty = RATE_LIMIT_WAIT_MS;
    tokens = Math.min(tokens, burstOf(options.fallback.rate));
    options.onSwitch?.('fallback', reason);
  }

  /** The primary refused with a 429: set it aside if it will not pass soon. */
  function primaryRefused(text: string): boolean {
    if (!options.fallback || onFallback()) return false;
    primary429 += 1;
    if (QUOTA_SPENT.test(text)) toFallback(text.slice(0, 160));
    else if (primary429 >= SWITCH_AFTER_429) toFallback(`${primary429} rate limits in a row`);
    return onFallback();
  }

  function onRateLimited(): void {
    rateLimited += 1;
    pausedUntil = Math.max(pausedUntil, now() + penalty);
    penalty = Math.min(MAX_WAIT_MS, penalty * 2);
  }

  /** Un aller-retour HTTP, réessayé tant que l'erreur est passagère. */
  async function post(payload: unknown, cost: number): Promise<unknown> {
    let wait = 500;
    for (let attempt = 1; ; attempt += 1) {
      await throttle(cost);
      requests += 1;
      let failure: RpcError;
      try {
        // Read before the request: the answer decides for the next one.
        const usingFallback = onFallback();
        if (!usingFallback && fallbackUntil !== 0 && options.fallback) {
          fallbackUntil = 0;
          options.onSwitch?.('primary', 'the hour on the fallback node is over');
        }
        const response = await doFetch(target(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 429) {
          // A spent quota moves to the fallback at once, without waiting out a penalty.
          if (!usingFallback && primaryRefused(await response.text().catch(() => ''))) {
            attempt -= 1;
            continue;
          }
          onRateLimited();
          failure = new RpcError('429 Too Many Requests', true);
        } else if (response.status >= 500) {
          failure = new RpcError(`HTTP ${response.status}`, true);
        } else {
          const text = await response.text();
          // Paid after the fact: the size is only known once the answer is in.
          tokens -= text.length / BYTES_PER_TOKEN;
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            throw new RpcError(`HTTP ${response.status}: unreadable body`, response.status >= 400);
          }
          const code = (body as { error?: { code?: number } } | null)?.error?.code;
          if (!Array.isArray(body) && (code === 429 || code === -32005)) {
            if (!usingFallback && primaryRefused(text)) {
              attempt -= 1;
              continue;
            }
            onRateLimited();
            failure = new RpcError('node busy', true);
          } else {
            penalty = RATE_LIMIT_WAIT_MS;
            if (!usingFallback) primary429 = 0;
            return body;
          }
        }
      } catch (error) {
        if (error instanceof RpcError && !error.transient) throw error;
        // A log query that times out will time out again: narrow it instead.
        if (cost === 1 && error instanceof Error && error.name === 'TimeoutError') {
          throw new TooBroadError('eth_getLogs timed out');
        }
        failure =
          error instanceof RpcError
            ? error
            : new RpcError(error instanceof Error ? error.message : String(error), true);
      }
      if (attempt >= attempts) throw failure;
      await sleep(wait);
      wait = Math.min(MAX_WAIT_MS, wait * 2);
    }
  }

  type Envelope = { id?: number; result?: unknown; error?: { code?: number; message?: string } };

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const cost = method === 'eth_getLogs' ? 1 : 0.25;
    const body = (await post({ jsonrpc: '2.0', id: 1, method, params }, cost)) as Envelope;
    if (body.error) {
      const message = body.error.message ?? 'unknown error';
      if (method === 'eth_getLogs') {
        const classified = classifyLogError(message);
        if (classified) throw classified;
      }
      throw new RpcError(`${method}: ${message}`, false);
    }
    if (body.result === undefined) throw new RpcError(`${method}: no result`, true);
    return body.result as T;
  }

  return {
    call,
    async batch<T>(list: RpcRequest[]): Promise<(T | null)[]> {
      const out: (T | null)[] = [];
      for (let offset = 0; offset < list.length; offset += BATCH_SIZE) {
        const slice = list.slice(offset, offset + BATCH_SIZE);
        // Les lectures simples ne sont pas limitées comme `eth_getLogs` (120
        // `eth_getBlockByNumber` en six batchs passent) : elles coûtent moins.
        const body = await post(
          slice.map((r, i) => ({ jsonrpc: '2.0', id: i, ...r })),
          Math.max(1, slice.length / 5),
        );
        if (!Array.isArray(body)) throw new RpcError('batch: unexpected answer', true);
        const byId = new Map((body as Envelope[]).map((e) => [e.id, e]));
        for (let i = 0; i < slice.length; i += 1) {
          const entry = byId.get(i);
          out.push(
            entry && !entry.error && entry.result !== undefined ? (entry.result as T) : null,
          );
        }
      }
      return out;
    },
    getLogs(filter: LogFilter): Promise<Log[]> {
      return call<Log[]>('eth_getLogs', [
        {
          ...(filter.address ? { address: filter.address } : {}),
          topics: filter.topics,
          fromBlock: hex(filter.fromBlock),
          toBlock: hex(filter.toBlock),
        },
      ]);
    },
    stats: () => ({ requests, rateLimited }),
  };
}
