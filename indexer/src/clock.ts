import type { Db } from './db.ts';
import type { Rpc } from './rpc.ts';

/**
 * L'heure d'un bloc, sans lire chaque bloc.
 *
 * 269 443 lancements tombent sur 261 327 blocs distincts : un
 * `eth_getBlockByNumber` par bloc coûterait 13 000 requêtes groupées pour les
 * seuls lancements. Or la chaîne produit ses blocs à un rythme régulier
 * (9,7 à 9,9 blocs/s, mesuré sur 30 jours le 17/10/2026). On lit donc un bloc
 * sur 50 000 (~1 h 25) et on interpole entre les deux ancres qui encadrent :
 * l'écart reste de l'ordre de la seconde. 1 800 ancres couvrent toute la chaîne.
 */
export const ANCHOR_EVERY = 50_000;

/** Pour éviter une ligne par tour de boucle, la tête n'est gardée en base que toutes les ~5 min. */
const HEAD_ANCHOR_EVERY = 3_000;

export type Clock = {
  /** Lit la tête de chaîne et la garde comme ancre. */
  observeHead(): Promise<number>;
  head(): number;
  /** Heure (secondes Unix) de chacun des blocs demandés. */
  timesOf(blocks: Iterable<number>): Promise<Map<number, number>>;
};

type Header = { number: string; timestamp: string } | null;

export function createClock(rpc: Rpc, db: Db): Clock {
  let head: { block: number; ts: number } | undefined;
  let lastStored = 0;

  function interpolate(block: number): number | undefined {
    const lo = db.anchorBelow(block);
    const stored = db.anchorAbove(block);
    const hi = stored ?? (head && head.block >= block ? head : undefined);
    if (lo && lo.block === block) return lo.ts;
    if (lo && hi && hi.block > lo.block) {
      return Math.round(lo.ts + ((block - lo.block) * (hi.ts - lo.ts)) / (hi.block - lo.block));
    }
    // Hors des ancres (bloc plus récent que la dernière tête lue) : 0,1 s par bloc.
    const near = lo ?? hi;
    return near ? Math.round(near.ts + (block - near.block) / 10) : undefined;
  }

  return {
    async observeHead(): Promise<number> {
      const header = await rpc.call<Header>('eth_getBlockByNumber', ['latest', false]);
      if (!header) throw new Error('latest block unreadable');
      head = { block: Number(header.number), ts: Number(header.timestamp) };
      if (head.block - lastStored >= HEAD_ANCHOR_EVERY) {
        db.setBlockTime(head.block, head.ts);
        lastStored = head.block;
      }
      return head.block;
    },
    head: () => head?.block ?? 0,
    async timesOf(blocks: Iterable<number>): Promise<Map<number, number>> {
      const wanted = [...new Set(blocks)];
      const top = head?.block ?? wanted.reduce((a, b) => Math.max(a, b), 0);
      const missing = new Set<number>();
      for (const block of wanted) {
        // The genesis block is stamped 0 (1970): block 1 opens the chain instead.
        const lo = Math.max(1, Math.floor(block / ANCHOR_EVERY) * ANCHOR_EVERY);
        for (const anchor of [lo, Math.floor(block / ANCHOR_EVERY) * ANCHOR_EVERY + ANCHOR_EVERY]) {
          if (anchor <= top && db.blockTime(anchor) === undefined) missing.add(anchor);
        }
      }
      if (missing.size > 0) {
        const list = [...missing];
        const headers = await rpc.batch<Header>(
          list.map((b) => ({
            method: 'eth_getBlockByNumber',
            params: [`0x${b.toString(16)}`, false],
          })),
        );
        list.forEach((b, i) => {
          const h = headers[i];
          if (h && Number(h.timestamp) > 0) db.setBlockTime(b, Number(h.timestamp));
        });
      }
      const out = new Map<number, number>();
      for (const block of wanted) {
        const ts = interpolate(block);
        if (ts !== undefined) out.set(block, ts);
      }
      return out;
    },
  };
}
