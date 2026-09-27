/**
 * Cache mémoire à durée de vie, avec éviction du plus ancien.
 *
 * Ce que c'est : un cache **par instance**. Sur Vercel, il survit tant que la
 * fonction reste chaude et disparaît au démarrage à froid. Il n'est pas
 * partagé entre instances, ni entre les environnements.
 *
 * Ce que ce n'est pas : un index. La Wave 1 envisageait une persistance qui
 * éviterait de rescanner l'historique — ça demande un magasin externe, donc
 * une clé et un coût. Ce cache-ci répond au cas fréquent (plusieurs tokens du
 * même créateur analysés d'affilée) sans rien ajouter à la facture, et il est
 * écrit pour être remplacé par un vrai magasin sans toucher aux appelants.
 */

export type CacheEntry<T> = { value: T; expiresAt: number };

export type TtlCacheOptions = {
  /** Durée de vie en millisecondes. */
  ttlMs: number;
  /** Nombre maximal d'entrées. Au-delà, la plus ancienne est évincée. */
  maxEntries?: number;
  now?: () => number;
};

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 100;
    this.now = options.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Map conserve l'ordre d'insertion : on remet l'entrée au bout pour que
    // l'éviction retire réellement la moins récemment utilisée.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Renvoie la valeur en cache, sinon calcule, stocke et renvoie. */
  async resolve(key: string, compute: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };
    const value = await compute();
    this.set(key, value);
    return { value, cached: false };
  }

  get size(): number {
    return this.store.size;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }

  clear(): void {
    this.store.clear();
  }
}
