import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/lib/cache';

/** Horloge contrôlée : aucun test ne doit attendre pour de vrai. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('TtlCache', () => {
  it('rend la valeur stockée', () => {
    const c = new TtlCache<string>({ ttlMs: 1000 });
    c.set('a', 'valeur');
    expect(c.get('a')).toBe('valeur');
  });

  it('oublie une entrée expirée', () => {
    const t = clock();
    const c = new TtlCache<string>({ ttlMs: 1000, now: t.now });
    c.set('a', 'valeur');
    t.advance(1001);
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("garde une entrée jusqu'à sa limite", () => {
    const t = clock();
    const c = new TtlCache<string>({ ttlMs: 1000, now: t.now });
    c.set('a', 'valeur');
    t.advance(999);
    expect(c.get('a')).toBe('valeur');
  });

  it('évince la moins récemment utilisée, pas la plus ancienne insérée', () => {
    const c = new TtlCache<string>({ ttlMs: 10_000, maxEntries: 2 });
    c.set('a', '1');
    c.set('b', '2');
    c.get('a'); // « a » redevient la plus récente
    c.set('c', '3'); // doit évincer « b »
    expect(c.get('a')).toBe('1');
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe('3');
  });

  it('remplace une clé existante sans gonfler la taille', () => {
    const c = new TtlCache<string>({ ttlMs: 1000 });
    c.set('a', '1');
    c.set('a', '2');
    expect(c.size).toBe(1);
    expect(c.get('a')).toBe('2');
  });
});

describe('resolve', () => {
  it("ne calcule qu'une fois pour une même clé", async () => {
    const c = new TtlCache<number>({ ttlMs: 10_000 });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 42;
    };
    const first = await c.resolve('k', compute);
    const second = await c.resolve('k', compute);
    expect(first).toEqual({ value: 42, cached: false });
    expect(second).toEqual({ value: 42, cached: true });
    expect(calls).toBe(1);
  });

  it('recalcule après expiration', async () => {
    const t = clock();
    const c = new TtlCache<number>({ ttlMs: 1000, now: t.now });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    await c.resolve('k', compute);
    t.advance(1001);
    const again = await c.resolve('k', compute);
    expect(again).toEqual({ value: 2, cached: false });
  });

  // Un échec ne doit pas être mémorisé : la source peut être revenue.
  it('ne met pas un échec en cache', async () => {
    const c = new TtlCache<number>({ ttlMs: 10_000 });
    await expect(
      c.resolve('k', async () => {
        throw new Error('source en panne');
      }),
    ).rejects.toThrow(/en panne/);
    expect(c.size).toBe(0);
  });

  it('compte les succès et les manques', async () => {
    const c = new TtlCache<number>({ ttlMs: 10_000 });
    await c.resolve('k', async () => 1);
    await c.resolve('k', async () => 1);
    expect(c.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });
});
