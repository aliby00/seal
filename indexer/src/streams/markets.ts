import { decodeInitialize, INITIALIZE_TOPIC, POOL_MANAGER } from '../abi.ts';
import type { Clock } from '../clock.ts';
import type { Db } from '../db.ts';
import type { Logger, Stream } from '../loop.ts';
import type { Rpc } from '../rpc.ts';
import { newWindow, readChunk } from '../scan.ts';
import { launchFrontier } from './launches.ts';

/**
 * Les marchés Uniswap v4 : chaque `Initialize` du PoolManager, depuis le
 * premier bloc. Une seule adresse filtrée : 10 M de blocs par requête au plus,
 * la fenêtre se resserre d'elle-même là où la chaîne en crée des milliers.
 */
export const MARKETS = 'markets';

/**
 * Les marchés passent après les lancements : leurs réponses pèsent 5 Mo
 * (7 000 logs par 600 000 blocs au début de la chaîne), et le nœud public
 * répond 429 dès que le volume monte. Les lancements d'abord, parce que les
 * swaps les attendent.
 */
const AFTER_LAUNCHES_LAG = 2_000;

export function marketStream(deps: { rpc: Rpc; db: Db; clock: Clock; log: Logger }): Stream {
  const window = newWindow(10_000_000);
  return {
    name: MARKETS,
    async step() {
      const head = deps.clock.head();
      const done = deps.db.cursor(MARKETS) ?? -1;
      if (head === 0 || done >= head) return false;
      if (head - launchFrontier(deps.db) > AFTER_LAUNCHES_LAG) return false;
      const started = Date.now();
      const chunk = await readChunk(
        deps.rpc,
        { address: POOL_MANAGER, topics: [INITIALIZE_TOPIC] },
        done + 1,
        head,
        window,
      );
      const rows = chunk.logs.map(decodeInitialize);
      const times = await deps.clock.timesOf(rows.map((r) => r.block));
      const inserted = deps.db.transaction(() => {
        const n = deps.db.insertMarkets(
          rows.map((r) => ({ ...r, ts: times.get(r.block) ?? null })),
        );
        deps.db.setCursor(MARKETS, chunk.to);
        return n;
      });
      deps.log('batch', {
        stream: MARKETS,
        from: chunk.from,
        to: chunk.to,
        logs: rows.length,
        inserted,
        ms: Date.now() - started,
      });
      return true;
    },
  };
}
