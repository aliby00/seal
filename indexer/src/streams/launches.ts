import { decodeLaunch, PONS_FACTORIES, TOKEN_LAUNCHED_TOPIC, type FactoryRange } from '../abi.ts';
import type { Clock } from '../clock.ts';
import type { Db } from '../db.ts';
import type { Logger, Stream } from '../loop.ts';
import type { Rpc } from '../rpc.ts';
import { newWindow, readChunk, type Window } from '../scan.ts';

/**
 * Les lancements pons, factory par factory, avec un curseur chacune.
 *
 * Filtré par adresse, le nœud accepte 10 M de blocs par requête, mais pas plus
 * de 10 000 logs : sur `0xa5aa…` (268 000 lancements en 30 M de blocs) la
 * fenêtre descend à ~300 000 blocs. Tout l'historique tient en ~110 requêtes
 * (2 min 30 mesurées le 17/10/2026).
 */
export const cursorName = (factory: string): string => `launches:${factory}`;

/** Single-address queries: the node allows exactly 10,000,000 blocks. */
const MAX_SPAN = 10_000_000;

export function launchStream(deps: {
  rpc: Rpc;
  db: Db;
  clock: Clock;
  log: Logger;
  factories?: readonly FactoryRange[];
}): Stream {
  const factories = deps.factories ?? PONS_FACTORIES;
  const windows = new Map<string, Window>(factories.map((f) => [f.address, newWindow(MAX_SPAN)]));
  return {
    name: 'launches',
    async step(): Promise<boolean> {
      const head = deps.clock.head();
      let worked = false;
      for (const factory of factories) {
        const done = deps.db.cursor(cursorName(factory.address)) ?? factory.fromBlock - 1;
        const end = Math.min(factory.toBlock ?? head, head);
        if (done >= end) continue;
        const started = Date.now();
        const chunk = await readChunk(
          deps.rpc,
          { address: factory.address, topics: [TOKEN_LAUNCHED_TOPIC] },
          done + 1,
          end,
          windows.get(factory.address) as Window,
        );
        const rows = chunk.logs.map(decodeLaunch);
        const times = await deps.clock.timesOf(rows.map((r) => r.block));
        const inserted = deps.db.transaction(() => {
          const n = deps.db.insertLaunches(
            rows.map((r) => ({ ...r, ts: times.get(r.block) ?? null })),
          );
          deps.db.setCursor(cursorName(factory.address), chunk.to);
          return n;
        });
        deps.log('batch', {
          stream: 'launches',
          factory: factory.address.slice(0, 6),
          from: chunk.from,
          to: chunk.to,
          logs: rows.length,
          inserted,
          ms: Date.now() - started,
        });
        worked = true;
      }
      return worked;
    },
  };
}

/**
 * Jusqu'où la liste des pools pons est complète : tout pool lancé à un bloc
 * inférieur ou égal est connu. Les swaps ne sont lus qu'en deçà, sinon le swap
 * d'un pool tout juste lancé serait écarté comme « pas pons ».
 */
export function launchFrontier(
  db: Db,
  factories: readonly FactoryRange[] = PONS_FACTORIES,
): number {
  let frontier = Number.POSITIVE_INFINITY;
  for (const f of factories) {
    const done = db.cursor(cursorName(f.address)) ?? f.fromBlock - 1;
    if (f.toBlock !== undefined && done >= f.toBlock) continue;
    frontier = Math.min(frontier, done);
  }
  return frontier;
}
