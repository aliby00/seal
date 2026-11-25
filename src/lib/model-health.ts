import { log } from './logger';
import { sharedRedis } from './store';

/**
 * Whether the model is actually answering, as seen by the last calls.
 *
 * A provider that fails is caught and the facts are worded offline: the
 * visitor gets a page, never an error. That is right for one call, and it hid
 * a revoked key for days (prod 16/11/2026: every reading offline on
 * "401 invalid x-api-key", /api/health still saying "reasoning: anthropic").
 * The last failure is kept here, cleared by the next answer, and
 * /api/health reports it so the uptime check opens an issue.
 */

/** Why the model did not answer, in a word: never the provider's message. */
export type ModelFailureKind = 'auth' | 'model' | 'quota' | 'billing' | 'timeout' | 'other';

export type ModelFailure = { kind: ModelFailureKind; at: string };

const KEY = 'seal:model:failure';
/** A failure older than this, with no answer since, is still reported: one hour. */
const TTL_SECONDS = 3_600;

let memory: ModelFailure | null = null;

/** The kind of failure from the provider's error, by its status and words. */
export function classifyFailure(error: unknown): ModelFailureKind {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/\b(401|403)\b|authentication_error|permission_error|invalid x-api-key|api key/i.test(text))
    return 'auth';
  if (/\b404\b|not_found_error|model.*(not found|does not exist)/i.test(text)) return 'model';
  if (/credit balance|billing|payment/i.test(text)) return 'billing';
  if (/\b429\b|rate_limit|\b529\b|overloaded/i.test(text)) return 'quota';
  if (/abort|timeout|timed out/i.test(text)) return 'timeout';
  return 'other';
}

/** Failures that do not pass by themselves: someone has to act. */
export function lasting(kind: ModelFailureKind): boolean {
  return kind === 'auth' || kind === 'model' || kind === 'billing';
}

/** Records a failed call. Never throws: the visitor's page does not wait on it. */
export async function recordModelFailure(error: unknown, now = new Date()): Promise<void> {
  const failure: ModelFailure = { kind: classifyFailure(error), at: now.toISOString() };
  // A timeout says the call ran long, not that the model is down.
  if (!lasting(failure.kind)) return;
  memory = failure;
  const redis = sharedRedis();
  if (!redis) return;
  try {
    await redis.pipeline([['SET', KEY, JSON.stringify(failure), 'EX', TTL_SECONDS]]);
  } catch (e) {
    log.warn('échec du modèle non partagé', { error: String(e) });
  }
}

/** An answer came back: whatever failed before is over. */
export async function recordModelAnswer(): Promise<void> {
  if (memory === null && !sharedRedis()) return;
  memory = null;
  const redis = sharedRedis();
  if (!redis) return;
  try {
    await redis.pipeline([['DEL', KEY]]);
  } catch (e) {
    log.warn('reprise du modèle non partagée', { error: String(e) });
  }
}

/** The last lasting failure with no answer since, or null. */
export async function modelFailure(): Promise<ModelFailure | null> {
  const redis = sharedRedis();
  if (redis) {
    try {
      const [value] = await redis.pipeline([['GET', KEY]]);
      if (typeof value === 'string') return JSON.parse(value) as ModelFailure;
      return null;
    } catch {
      // Unreadable shared store: this instance's own view.
    }
  }
  return memory;
}

/** Tests start from a clean slate. */
export function resetModelHealth(): void {
  memory = null;
}
