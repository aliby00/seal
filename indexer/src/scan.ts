import { TooBroadError, type Log, type LogFilter, type Rpc } from './rpc.ts';

/**
 * Une fenêtre de blocs qui s'adapte à ce que le nœud accepte : divisée par
 * deux à chaque refus (« exceeds limit », « only N are allowed »…), puis
 * élargie de nouveau quand les réponses redeviennent légères.
 */
export type Window = { span: number; max: number; min: number };

export function newWindow(max: number, span = max, min = 1): Window {
  return { span: Math.min(span, max), max, min };
}

/** Sous ce nombre de logs, la fenêtre suivante peut doubler. */
const GROW_BELOW = 2_000;

export type Chunk = { logs: Log[]; from: number; to: number };

/**
 * Lit la prochaine tranche de `[from, to]` : vers l'avant (à partir de `from`)
 * ou vers l'arrière (en finissant à `to`). Ne renvoie qu'une tranche : c'est à
 * l'appelant d'enregistrer son curseur entre deux, pour reprendre au bon
 * endroit après un arrêt.
 */
export async function readChunk(
  rpc: Rpc,
  filter: Omit<LogFilter, 'fromBlock' | 'toBlock'>,
  from: number,
  to: number,
  window: Window,
  direction: 'forward' | 'backward' = 'forward',
): Promise<Chunk> {
  for (;;) {
    const span = Math.max(1, Math.min(window.span, to - from + 1));
    const lo = direction === 'forward' ? from : to - span + 1;
    const hi = direction === 'forward' ? from + span - 1 : to;
    try {
      const logs = await rpc.getLogs({ ...filter, fromBlock: lo, toBlock: hi });
      if (logs.length < GROW_BELOW) window.span = Math.min(window.max, window.span * 2);
      return { logs, from: lo, to: hi };
    } catch (error) {
      if (!(error instanceof TooBroadError) || span <= window.min) throw error;
      // The node may state its own ceiling: reading it beats halving blindly.
      const stated = error.maxSpan && error.maxSpan < span ? error.maxSpan : undefined;
      window.span = Math.max(window.min, stated ?? Math.floor(span / 2));
      if (stated) window.max = Math.min(window.max, stated);
    }
  }
}
