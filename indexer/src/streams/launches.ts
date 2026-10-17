import { decodeLaunchOf, LAUNCHPADS, type FactoryRange, type LaunchpadSource } from '../abi.ts';
import type { Clock } from '../clock.ts';
import type { Db } from '../db.ts';
import type { Logger, Stream } from '../loop.ts';
import type { Rpc } from '../rpc.ts';
import { newWindow, readChunk, type Window } from '../scan.ts';

/**
 * Les lancements de chaque launchpad, contrat par contrat, avec un curseur
 * chacun. Les curseurs pons gardent leur nom (`launches:<factory>`) : une base
 * créée avant les autres launchpads reprend là où elle en était, et chaque
 * nouveau contrat commence à son propre premier bloc.
 *
 * Filtré par adresse, le nœud accepte 10 M de blocs par requête, mais pas plus
 * de 10 000 logs : sur `0xa5aa…` (268 000 lancements en 30 M de blocs) la
 * fenêtre descend à ~300 000 blocs. Tout l'historique pons tient en ~110
 * requêtes (2 min 30 mesurées le 17/10/2026) ; flap.sh (373 000 lancements)
 * et `0x7ed5…` (699 000) en demandent quelques centaines de plus, une fois.
 */
export const cursorName = (factory: string): string => `launches:${factory}`;

/** Single-address queries: the node allows exactly 10,000,000 blocks. */
const MAX_SPAN = 10_000_000;

/** A pons factory range given alone (tests, older callers) reads as a pons launchpad. */
function asSource(range: FactoryRange | LaunchpadSource): LaunchpadSource {
  if ('id' in range) return range;
  const pons = LAUNCHPADS.find((l) => l.id === 'pons') as LaunchpadSource;
  return { ...pons, ...range };
}

export function launchStream(deps: {
  rpc: Rpc;
  db: Db;
  clock: Clock;
  log: Logger;
  /** Contracts to read: every launchpad by default. */
  factories?: readonly (FactoryRange | LaunchpadSource)[];
}): Stream {
  const sources = (deps.factories ?? LAUNCHPADS).map(asSource);
  const windows = new Map<string, Window>(sources.map((f) => [f.address, newWindow(MAX_SPAN)]));
  return {
    name: 'launches',
    async step(): Promise<boolean> {
      const head = deps.clock.head();
      let worked = false;
      for (const source of sources) {
        const done = deps.db.cursor(cursorName(source.address)) ?? source.fromBlock - 1;
        const end = Math.min(source.toBlock ?? head, head);
        if (done >= end) continue;
        const started = Date.now();
        const chunk = await readChunk(
          deps.rpc,
          { address: source.address, topics: [source.topic0] },
          done + 1,
          end,
          windows.get(source.address) as Window,
        );
        const rows = chunk.logs
          .map((log) => decodeLaunchOf(source, log))
          .filter((r): r is NonNullable<typeof r> => r !== null);
        const times = await deps.clock.timesOf(rows.map((r) => r.block));
        const inserted = deps.db.transaction(() => {
          const n = deps.db.insertLaunches(
            rows.map((r) => ({ ...r, ts: times.get(r.block) ?? null })),
          );
          deps.db.setCursor(cursorName(source.address), chunk.to);
          return n;
        });
        deps.log('batch', {
          stream: 'launches',
          launchpad: source.id,
          factory: source.address.slice(0, 6),
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
 * d'un pool tout juste lancé serait écarté comme « pas pons ». Seuls les
 * contrats pons comptent : les swaps ne lisent que leurs pools, et le
 * rattrapage d'un autre launchpad ne doit pas les retenir.
 */
export function launchFrontier(
  db: Db,
  factories: readonly FactoryRange[] = LAUNCHPADS.filter((l) => l.id === 'pons'),
): number {
  let frontier = Number.POSITIVE_INFINITY;
  for (const f of factories) {
    const done = db.cursor(cursorName(f.address)) ?? f.fromBlock - 1;
    if (f.toBlock !== undefined && done >= f.toBlock) continue;
    frontier = Math.min(frontier, done);
  }
  return frontier;
}

/**
 * The last block read for each launchpad id: a closed contract read to its
 * end counts as read to the head, and an id spread over several contracts
 * (pons) is as far as its slowest one.
 */
export function launchpadCoverage(
  db: Db,
  head: number,
  sources: readonly LaunchpadSource[] = LAUNCHPADS,
): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (const source of sources) {
    const done = db.cursor(cursorName(source.address)) ?? source.fromBlock - 1;
    const reached = source.toBlock !== undefined && done >= source.toBlock ? head : done;
    coverage[source.id] = Math.min(coverage[source.id] ?? Number.POSITIVE_INFINITY, reached);
  }
  return coverage;
}
