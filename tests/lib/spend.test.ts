import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_BUDGET_USD,
  dailyBudgetUsd,
  overBudget,
  recordSpend,
  resetSpend,
  spentToday,
} from '../../src/lib/spend';
import { setSharedRedis } from '../../src/lib/store';

describe('plafond de dépense quotidien', () => {
  beforeEach(() => {
    setSharedRedis(null);
    resetSpend();
  });
  afterEach(() => setSharedRedis(undefined));

  it('lit le plafond depuis l’environnement, avec une valeur par défaut', () => {
    expect(dailyBudgetUsd({})).toBe(DEFAULT_DAILY_BUDGET_USD);
    expect(dailyBudgetUsd({ SEAL_DAILY_BUDGET_USD: '5' })).toBe(5);
    expect(dailyBudgetUsd({ SEAL_DAILY_BUDGET_USD: 'abc' })).toBe(DEFAULT_DAILY_BUDGET_USD);
    expect(dailyBudgetUsd({ SEAL_DAILY_BUDGET_USD: '-1' })).toBe(DEFAULT_DAILY_BUDGET_USD);
  });

  it('additionne les appels du jour et coupe au plafond', async () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const env = { SEAL_DAILY_BUDGET_USD: '0.05' };
    await recordSpend(0.03, now);
    expect(await overBudget(now, env)).toBe(false);
    await recordSpend(0.03, now);
    expect(await spentToday(now)).toBeCloseTo(0.06, 6);
    expect(await overBudget(now, env)).toBe(true);
  });

  it('repart de zéro le lendemain', async () => {
    await recordSpend(1, new Date('2026-10-16T23:59:00Z'));
    expect(await spentToday(new Date('2026-10-17T00:01:00Z'))).toBe(0);
  });

  it('ignore les coûts nuls ou invalides', async () => {
    const now = new Date('2026-10-16T12:00:00Z');
    await recordSpend(0, now);
    await recordSpend(Number.NaN, now);
    expect(await spentToday(now)).toBe(0);
  });

  it('partage le total par Redis quand il est là', async () => {
    const calls: unknown[][] = [];
    setSharedRedis({
      async pipeline(commands) {
        calls.push(...commands);
        return commands.map((c) => (c[0] === 'GET' ? '19.5' : 'OK'));
      },
    });
    const now = new Date('2026-10-16T12:00:00Z');
    expect(await spentToday(now)).toBe(19.5);
    await recordSpend(0.02, now);
    expect(calls).toContainEqual(['INCRBYFLOAT', 'seal:spend:2026-10-16', '0.020000']);
  });
});
