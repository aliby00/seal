import {
  RateLimitError,
  TimeoutError,
  UpstreamError,
  isRetryable,
  type SourceName,
} from './errors';

/**
 * Wrapper HTTP commun aux trois modules de données.
 *
 * Il porte trois choses qu'aucun module ne doit réimplémenter : le timeout, le
 * retry exponentiel qui respecte `Retry-After`, et un plafond de requêtes par
 * analyse — pour qu'une seule analyse ne puisse pas épuiser le quota journalier
 * de Blockscout (100 000 crédits) à elle seule.
 */

export type RequestBudget = {
  /** Nombre maximal de requêtes autorisées pour cette analyse. */
  readonly max: number;
  spent: number;
};

export function createBudget(max: number): RequestBudget {
  return { max, spent: 0 };
}

export class BudgetExhaustedError extends Error {
  constructor(
    readonly source: SourceName,
    readonly max: number,
  ) {
    super(`${source} : budget de ${max} requêtes épuisé pour cette analyse`);
    this.name = 'BudgetExhaustedError';
  }
}

export type FetchOptions = {
  source: SourceName;
  timeoutMs?: number;
  retries?: number;
  budget?: RequestBudget;
  /** Injectable pour les tests : aucun test unitaire ne doit dormir pour de vrai. */
  sleep?: (ms: number) => Promise<void>;
  init?: RequestInit;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const BASE_BACKOFF_MS = 400;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` peut être un nombre de secondes ou une date HTTP. */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - now) / 1000));
}

/** Backoff exponentiel avec un peu de jitter, pour ne pas resynchroniser les retries. */
export function backoffDelay(attempt: number, jitter = Math.random()): number {
  return Math.round(BASE_BACKOFF_MS * 2 ** attempt * (0.5 + jitter / 2));
}

async function once(url: string, options: FetchOptions): Promise<Response> {
  const { source, timeoutMs = DEFAULT_TIMEOUT_MS, init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError(source, timeoutMs);
    }
    throw new UpstreamError(source, 'requête réseau échouée', undefined, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Effectue la requête avec timeout, retry et budget.
 * Laisse remonter une `SealError` typée — jamais une erreur brute de `fetch`.
 */
export async function request(url: string, options: FetchOptions): Promise<Response> {
  const { source, retries = DEFAULT_RETRIES, budget, sleep = defaultSleep } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (budget) {
      if (budget.spent >= budget.max) throw new BudgetExhaustedError(source, budget.max);
      budget.spent += 1;
    }

    try {
      const response = await once(url, options);

      if (response.status === 429 || response.status === 403) {
        throw new RateLimitError(source, parseRetryAfter(response.headers.get('retry-after')));
      }
      if (response.status >= 500) {
        throw new UpstreamError(source, `statut ${response.status}`, response.status);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === retries) throw error;

      const retryAfter = error instanceof RateLimitError ? error.retryAfterSeconds : undefined;
      await sleep(retryAfter !== undefined ? retryAfter * 1000 : backoffDelay(attempt));
    }
  }

  throw lastError;
}

/** Variante JSON : même garanties, plus la validation que le corps est lisible. */
export async function requestJson<T>(url: string, options: FetchOptions): Promise<T> {
  const response = await request(url, options);
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new UpstreamError(options.source, 'réponse JSON illisible', response.status, error);
  }
}
