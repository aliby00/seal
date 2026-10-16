import { log } from './logger';
import { sharedRedis } from './store';

/**
 * A daily ceiling on what the model may cost, across every caller.
 *
 * The per-address limit stops one caller; it does not stop many. Past the
 * ceiling the facts are still served, worded offline, until midnight UTC.
 * The total lives in Redis so every instance sees it; without Redis each
 * instance counts its own share, which still bounds the bill per instance.
 */

/** Default ceiling when `SEAL_DAILY_BUDGET_USD` is not set. */
export const DEFAULT_DAILY_BUDGET_USD = 20;

type Env = Record<string, string | undefined>;

export function dailyBudgetUsd(env: Env = process.env): number {
  const value = Number(env.SEAL_DAILY_BUDGET_USD);
  return Number.isFinite(value) && value >= 0 && env.SEAL_DAILY_BUDGET_USD?.trim()
    ? value
    : DEFAULT_DAILY_BUDGET_USD;
}

const day = (now: Date) => now.toISOString().slice(0, 10);
const keyFor = (now: Date) => `seal:spend:${day(now)}`;
/** Two days: the key outlives its own day, never accumulates. */
const KEY_TTL_SECONDS = 172_800;

const memory = new Map<string, number>();

export function resetSpend(): void {
  memory.clear();
}

/** What the model has cost today, in USD. */
export async function spentToday(now = new Date()): Promise<number> {
  const key = keyFor(now);
  const redis = sharedRedis();
  if (redis) {
    try {
      const [value] = await redis.pipeline([['GET', key]]);
      return Number(value ?? 0) || 0;
    } catch (error) {
      log.warn('dépense partagée illisible, repli mémoire', { error: String(error) });
    }
  }
  return memory.get(key) ?? 0;
}

/** True when today's spend has reached the ceiling: the model is not called. */
export async function overBudget(now = new Date(), env: Env = process.env): Promise<boolean> {
  const budget = dailyBudgetUsd(env);
  const spent = await spentToday(now);
  if (spent >= budget) {
    log.warn('plafond de dépense atteint, restitution hors-ligne', { spent, budget });
    return true;
  }
  return false;
}

/** Adds a paid call to today's total. Never throws: the answer is already paid for. */
export async function recordSpend(usd: number, now = new Date()): Promise<void> {
  if (!(usd > 0)) return;
  const key = keyFor(now);
  memory.set(key, (memory.get(key) ?? 0) + usd);
  const redis = sharedRedis();
  if (!redis) return;
  try {
    await redis.pipeline([
      ['INCRBYFLOAT', key, usd.toFixed(6)],
      ['EXPIRE', key, KEY_TTL_SECONDS],
    ]);
  } catch (error) {
    log.warn('dépense non enregistrée', { usd, error: String(error) });
  }
}
