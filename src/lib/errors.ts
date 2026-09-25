/**
 * Erreurs typées pour les appels externes.
 *
 * Le brief l'impose : « chaque appel à une API externe doit avoir une gestion
 * d'erreur propre — l'API peut timeout, rate-limiter, ou renvoyer une donnée
 * incomplète ». Ces trois cas ne conduisent pas à la même complétude ni au même
 * message, donc ils ne peuvent pas partager un seul type d'erreur.
 */

export type SourceName = 'robinhood-rpc' | 'blockscout' | 'dexscreener' | 'anthropic';

export abstract class SealError extends Error {
  abstract readonly kind: string;
  /** Une nouvelle tentative a-t-elle une chance d'aboutir. */
  abstract readonly retryable: boolean;

  constructor(
    readonly source: SourceName,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** La requête n'a pas abouti dans le temps imparti. */
export class TimeoutError extends SealError {
  readonly kind = 'timeout';
  readonly retryable = true;
  constructor(
    source: SourceName,
    readonly timeoutMs: number,
  ) {
    super(source, `${source} : délai de ${timeoutMs} ms dépassé`);
  }
}

/** 429, ou 403 après une rafale — le cas du RPC public de Robinhood Chain. */
export class RateLimitError extends SealError {
  readonly kind = 'rate-limit';
  readonly retryable = true;
  constructor(
    source: SourceName,
    /** Secondes indiquées par `Retry-After`, quand la source le précise. */
    readonly retryAfterSeconds?: number,
  ) {
    super(
      source,
      retryAfterSeconds === undefined
        ? `${source} : quota dépassé`
        : `${source} : quota dépassé, réessayer dans ${retryAfterSeconds} s`,
    );
  }
}

/** La source a répondu, mais la réponse ne couvre pas tout ce qui était demandé. */
export class IncompleteDataError extends SealError {
  readonly kind = 'incomplete';
  readonly retryable = false;
  constructor(
    source: SourceName,
    readonly detail: string,
  ) {
    super(source, `${source} : donnée incomplète — ${detail}`);
  }
}

/** La ressource n'existe pas. Réessayer n'y changera rien. */
export class NotFoundError extends SealError {
  readonly kind = 'not-found';
  readonly retryable = false;
  constructor(
    source: SourceName,
    readonly what: string,
  ) {
    super(source, `${source} : ${what} introuvable`);
  }
}

/** Réponse inattendue : statut inconnu, corps illisible, schéma inattendu. */
export class UpstreamError extends SealError {
  readonly kind = 'upstream';
  readonly retryable: boolean;
  constructor(
    source: SourceName,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(source, `${source} : ${message}`, cause);
    // Les 5xx valent une nouvelle tentative, les 4xx non.
    this.retryable = status !== undefined && status >= 500;
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof SealError && error.retryable;
}
