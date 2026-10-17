import { decodeSwap, swapSide, TOKEN0_SELECTOR, topicAddress, V3_SWAP_TOPIC } from '../abi.ts';
import type { Clock } from '../clock.ts';
import { BLOCKS_PER_DAY } from '../config.ts';
import type { Db, SwapInsert } from '../db.ts';
import type { Logger, Stream } from '../loop.ts';
import type { Log, Rpc } from '../rpc.ts';
import { TooManySelectorsError } from '../rpc.ts';
import { newWindow, readChunk } from '../scan.ts';
import { launchFrontier } from './launches.ts';

/**
 * Les swaps Uniswap V3 des pools de lancement pons.
 *
 * Deux façons de les lire, mesurées sur le nœud public le 17/10/2026 :
 *  - sans adresse, en filtrant ici : 3 900 swaps V3 sur toute la chaîne pour
 *    10 000 blocs aujourd'hui (3,4 Mo), mais plus de 10 000 il y a deux jours
 *    — la fenêtre tombe alors sous 10 000 blocs. Pour suivre la tête, c'est
 *    une requête par tour : imbattable ;
 *  - par listes de 999 pools (le nœud refuse au-delà de 1 000 sélecteurs) sur
 *    100 000 blocs : 270 requêtes par fenêtre pour 269 000 pools, des réponses
 *    minuscules. Pour remonter 30 jours, c'est ~70 000 requêtes légères contre
 *    ~25 Go de swaps de toute la chaîne à télécharger : c'est le rattrapage.
 *
 * Donc deux curseurs : `swaps:forward` suit la tête sans filtre, et
 * `swaps:back` remonte de l'ancre vers `swaps:target` par listes d'adresses,
 * du plus récent au plus ancien — les fenêtres 1 h, 24 h, 7 j sont justes
 * bien avant la fin du rattrapage, et `coveredFrom` dit jusqu'où on est allé.
 */
export const FORWARD = 'swaps:forward';
export const BACK = 'swaps:back';
export const TARGET = 'swaps:target';

/** Unfiltered queries: 30,000 blocks max at the node. */
const FORWARD_MAX = 30_000;
/** Address lists: 100,000 blocks max, 1,000 selectors (999 pools + the topic). */
const BACK_MAX = 100_000;
const POOLS_PER_QUERY = 999;
/** Tant que la liste des pools n'a pas rattrapé la tête, les swaps attendent. */
const READY_LAG = 2_000;

type PoolInfo = { token: string; tokenIsToken0: boolean } | null;

export function swapStream(deps: {
  rpc: Rpc;
  db: Db;
  clock: Clock;
  log: Logger;
  backfillDays: number;
}): { forward: Stream; back: Stream; ingest: (logs: readonly Log[]) => Promise<SwapInsert[]> } {
  const { rpc, db, clock, log } = deps;
  const forwardWindow = newWindow(FORWARD_MAX, 2_000);
  const backWindow = newWindow(BACK_MAX);
  let poolsPerQuery = POOLS_PER_QUERY;
  // Petit cache : quelques centaines de pools actifs reviennent sans cesse.
  const pools = new Map<string, PoolInfo>();

  async function poolInfo(addresses: readonly string[]): Promise<Map<string, PoolInfo>> {
    const out = new Map<string, PoolInfo>();
    const needToken0: { pool: string; token: string; pair: string }[] = [];
    for (const pool of new Set(addresses)) {
      const cached = pools.get(pool);
      if (cached !== undefined) {
        out.set(pool, cached);
        continue;
      }
      const launch = db.poolInfo(pool);
      if (!launch) {
        out.set(pool, null);
        if (pools.size > 50_000) pools.clear();
        pools.set(pool, null);
        continue;
      }
      const token0 = db.token0(pool);
      if (token0) {
        const info = { token: launch.token, tokenIsToken0: token0 === launch.token };
        out.set(pool, info);
        pools.set(pool, info);
      } else {
        needToken0.push({ pool, token: launch.token, pair: launch.pair_token });
      }
    }
    if (needToken0.length > 0) {
      const answers = await rpc.batch<string>(
        needToken0.map((p) => ({
          method: 'eth_call',
          params: [{ to: p.pool, data: TOKEN0_SELECTOR }, 'latest'],
        })),
      );
      needToken0.forEach((p, i) => {
        const raw = answers[i];
        // Uniswap trie ses deux tokens par adresse : c'est la réponse attendue
        // si `token0()` ne répond pas.
        const token0 =
          raw && /^0x[0-9a-f]{64}$/i.test(raw)
            ? topicAddress(raw)
            : p.token < p.pair
              ? p.token
              : p.pair;
        if (raw) db.setToken0(p.pool, token0);
        const info = { token: p.token, tokenIsToken0: token0 === p.token };
        out.set(p.pool, info);
        pools.set(p.pool, info);
      });
    }
    return out;
  }

  /** Qui a signé la transaction : un routeur sépare `sender` et `recipient` du vrai trader. */
  async function origins(hashes: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(hashes)];
    const txs = await rpc.batch<{ from?: string } | null>(
      unique.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })),
    );
    const out = new Map<string, string>();
    unique.forEach((h, i) => {
      const from = txs[i]?.from;
      if (from) out.set(h, from.toLowerCase());
    });
    return out;
  }

  /** Garde les swaps des pools pons et les met en forme. N'écrit rien. */
  async function ingest(logs: readonly Log[]): Promise<SwapInsert[]> {
    const swaps = logs
      .filter((l) => (l.topics[0] ?? '').toLowerCase() === V3_SWAP_TOPIC)
      .map(decodeSwap);
    if (swaps.length === 0) return [];
    const info = await poolInfo(swaps.map((s) => s.pool));
    const ours = swaps.filter((s) => info.get(s.pool));
    if (ours.length === 0) return [];
    const [from, times] = await Promise.all([
      origins(ours.map((s) => s.txHash)),
      clock.timesOf(ours.map((s) => s.block)),
    ]);
    return ours.map((s) => {
      const pool = info.get(s.pool) as NonNullable<PoolInfo>;
      return {
        txHash: s.txHash,
        logIndex: s.logIndex,
        pool: s.pool,
        token: pool.token,
        block: s.block,
        ts: times.get(s.block) ?? 0,
        sender: s.sender,
        recipient: s.recipient,
        origin: from.get(s.txHash) ?? null,
        amount0: s.amount0.toString(),
        amount1: s.amount1.toString(),
        side: swapSide(s, pool.tokenIsToken0),
      };
    });
  }

  /** Première exécution : l'ancre est la frontière des lancements, une fois la tête rattrapée. */
  function anchor(): number | undefined {
    const forward = db.cursor(FORWARD);
    if (forward !== undefined) return forward;
    const head = clock.head();
    const frontier = launchFrontier(db);
    if (head === 0 || !Number.isFinite(frontier) || head - frontier > READY_LAG) return undefined;
    db.transaction(() => {
      db.setCursor(FORWARD, frontier);
      db.setCursor(BACK, frontier + 1);
      db.setCursor(TARGET, Math.max(0, frontier - Math.round(deps.backfillDays * BLOCKS_PER_DAY)));
    });
    log('swaps-anchored', { anchor: frontier, backfillDays: deps.backfillDays });
    return frontier;
  }

  const forward: Stream = {
    name: 'swaps:forward',
    async step() {
      const done = anchor();
      if (done === undefined) return false;
      const end = Math.min(clock.head(), launchFrontier(db));
      if (done >= end) return false;
      const started = Date.now();
      const chunk = await readChunk(rpc, { topics: [V3_SWAP_TOPIC] }, done + 1, end, forwardWindow);
      const rows = await ingest(chunk.logs);
      const inserted = db.transaction(() => {
        const n = db.insertSwaps(rows);
        db.setCursor(FORWARD, chunk.to);
        return n;
      });
      log('batch', {
        stream: 'swaps:forward',
        from: chunk.from,
        to: chunk.to,
        chainSwaps: chunk.logs.length,
        ponsSwaps: rows.length,
        inserted,
        lag: clock.head() - chunk.to,
        ms: Date.now() - started,
      });
      return true;
    },
  };

  const back: Stream = {
    name: 'swaps:back',
    async step() {
      if (anchor() === undefined) return false;
      const lowest = db.cursor(BACK) as number;
      const target = db.cursor(TARGET) as number;
      if (lowest <= target) return false;
      const hi = lowest - 1;
      const lo = Math.max(target, hi - backWindow.span + 1);
      const started = Date.now();
      let after = '';
      let queries = 0;
      let found = 0;
      let inserted = 0;
      // Every pool launched up to `hi`, by pages: never the 269,000 at once.
      for (;;) {
        const page = db.poolsAfter(after, hi, poolsPerQuery);
        if (page.length === 0) break;
        let from = lo;
        const window = newWindow(hi - lo + 1);
        try {
          while (from <= hi) {
            const chunk = await readChunk(
              rpc,
              { address: page, topics: [V3_SWAP_TOPIC] },
              from,
              hi,
              window,
            );
            queries += 1;
            const rows = await ingest(chunk.logs);
            found += rows.length;
            inserted += db.transaction(() => db.insertSwaps(rows));
            from = chunk.to + 1;
          }
        } catch (error) {
          if (error instanceof TooManySelectorsError) {
            poolsPerQuery = Math.max(1, (error.max ?? poolsPerQuery) - 1);
            if (poolsPerQuery >= page.length) poolsPerQuery = Math.floor(page.length / 2);
            continue;
          }
          throw error;
        }
        // The window as a whole sets the next one's size.
        backWindow.span = Math.min(backWindow.span, window.max, BACK_MAX);
        after = page[page.length - 1] as string;
      }
      db.setCursor(BACK, lo);
      log('batch', {
        stream: 'swaps:back',
        from: lo,
        to: hi,
        queries,
        ponsSwaps: found,
        inserted,
        left: lo - target,
        ms: Date.now() - started,
      });
      return true;
    },
  };

  return { forward, back, ingest };
}
