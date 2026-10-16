import { RateLimitError } from '../errors';
import { BudgetExhaustedError } from '../http';
import { classifyLogError, LogQueryTooBroadError, type RpcClient } from './rpc';

/**
 * Récupération de logs par fenêtres adaptatives.
 *
 * Le nœud refuse une requête trop large de trois façons différentes — plus de
 * 10 000 résultats, `log query timed out`, ou un rate limit. Les trois se
 * résolvent pareil : resserrer la fenêtre. D'où un découpage piloté par la
 * réponse du nœud plutôt que par une taille de fenêtre fixe devinée à l'avance.
 */

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

export type LogFilter = {
  address?: string | string[];
  topics: (string | string[] | null)[];
};

export type GetLogsOptions = {
  fromBlock: number;
  toBlock: number;
  /** Taille de fenêtre initiale. Elle se divise en deux à chaque refus. */
  initialSpan?: number;
  /** En dessous, on abandonne : le nœud refuse même une fenêtre minuscule. */
  minSpan?: number;
  /** Plafond de logs collectés, pour ne pas ramener un historique sans fin. */
  maxLogs?: number;
  onProgress?: (info: { fromBlock: number; toBlock: number; collected: number }) => void;
};

export type GetLogsResult = {
  logs: RawLog[];
  /** Vrai si l'on s'est arrêté avant `toBlock` — la vue est alors partielle. */
  truncated: boolean;
  /** Plage réellement couverte. */
  scanned: { fromBlock: number; toBlock: number };
};

/**
 * Initial window size.
 *
 * Measured on Robinhood Chain: a query WITHOUT an address filter is capped at
 * 30,000 blocks; with an address filter, at 10,000,000. Creator-history queries
 * filter by topic, not by address, so the first cap applies. Starting at 500,000
 * cost five refused requests before the first accepted one — on an RPC that cuts
 * the caller off after a handful.
 */
const DEFAULT_INITIAL_SPAN = 30_000;
const DEFAULT_MIN_SPAN = 1_000;
const DEFAULT_MAX_LOGS = 5_000;

const hex = (n: number): string => `0x${n.toString(16)}`;

/**
 * Parcourt [fromBlock, toBlock] à rebours, du plus récent au plus ancien.
 *
 * À rebours parce que l'information récente compte davantage : si l'on doit
 * s'arrêter en chemin, mieux vaut avoir les derniers lancements d'un créateur
 * que les premiers.
 */
export async function getLogsChunked(
  rpc: RpcClient,
  filter: LogFilter,
  options: GetLogsOptions,
): Promise<GetLogsResult> {
  const {
    fromBlock,
    toBlock,
    initialSpan = DEFAULT_INITIAL_SPAN,
    minSpan = DEFAULT_MIN_SPAN,
    maxLogs = DEFAULT_MAX_LOGS,
    onProgress,
  } = options;

  const logs: RawLog[] = [];
  let cursor = toBlock;
  let span = initialSpan;
  // Once the node states a ceiling, remember it: widening back past it would
  // get refused again on the very next window, and the scan would oscillate.
  let ceiling = Number.POSITIVE_INFINITY;
  let truncated = false;
  let lowestScanned = toBlock;

  while (cursor >= fromBlock) {
    const windowStart = Math.max(fromBlock, cursor - span + 1);

    try {
      const batch = await rpc.call<RawLog[]>('eth_getLogs', [
        { ...filter, fromBlock: hex(windowStart), toBlock: hex(cursor) },
      ]);

      logs.push(...batch);
      lowestScanned = windowStart;
      onProgress?.({ fromBlock: windowStart, toBlock: cursor, collected: logs.length });

      if (logs.length >= maxLogs) {
        truncated = windowStart > fromBlock;
        break;
      }

      cursor = windowStart - 1;
      // The window held: widen cautiously, but never past a stated ceiling.
      span = Math.min(initialSpan, ceiling, Math.floor(span * 1.5));
    } catch (error) {
      // Un rate limit ou un budget épuisé en cours de route ne doit pas faire
      // perdre ce qui a déjà été collecté. Une fenêtre courte mais réelle vaut
      // mieux qu'une source déclarée indisponible : l'appelant marquera la vue
      // comme tronquée, et l'agent le dira.
      if (error instanceof RateLimitError || error instanceof BudgetExhaustedError) {
        truncated = true;
        break;
      }
      if (!(error instanceof LogQueryTooBroadError)) throw error;

      // When the node states the span it accepts, jump straight to it instead
      // of halving blindly.
      if (error.maxSpan !== undefined && error.maxSpan > 0) {
        ceiling = Math.min(ceiling, error.maxSpan);
        const announced = Math.max(minSpan, ceiling);
        if (announced < span) {
          span = announced;
          continue;
        }
      }

      if (span <= minSpan) {
        // Même la plus petite fenêtre est refusée : on s'arrête là et on le dit.
        truncated = true;
        break;
      }
      span = Math.max(minSpan, Math.floor(span / 2));
    }
  }

  // Les logs sont collectés du plus récent au plus ancien ; on rétablit l'ordre chronologique.
  logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

  // Read from the newest down, so the newest are the ones kept: cutting the
  // oldest window short keeps the range covered contiguous up to `toBlock`.
  const over = logs.length > maxLogs;
  const kept = over ? logs.slice(-maxLogs) : logs;
  return {
    logs: kept,
    truncated: truncated || over,
    scanned: {
      fromBlock: over ? Number(kept[0]?.blockNumber ?? lowestScanned) : lowestScanned,
      toBlock,
    },
  };
}

/**
 * Measured on Robinhood Chain (14/10/2026): filtered on ONE address, a query
 * may span 10,000,000 blocks. With a list of addresses, the cap drops to
 * 100,000 — so a list is split into one query per address, never sent as is.
 */
export const SINGLE_ADDRESS_SPAN = 10_000_000;

/** An address, optionally with the block range where it can have logs. */
export type LogSource = string | { address: string; fromBlock?: number; toBlock?: number };

/**
 * Logs of several contracts over a long range, in as few HTTP requests as
 * possible: one `eth_getLogs` per (address, 10 M-block window), sent as a
 * JSON-RPC batch. The whole history of both live pons factories fits in one
 * batch (~0.4 s), where topic-only windows of 30,000 blocks needed hundreds.
 *
 * A window the node still refuses (more than 10,000 results) falls back to the
 * adaptive scan for that window alone. Any other refusal marks the result
 * truncated rather than failing it: the caller says the view is partial.
 */
export async function getLogsBatched(
  rpc: RpcClient,
  filter: { addresses: readonly LogSource[]; topics: LogFilter['topics'] },
  range: { fromBlock: number; toBlock: number; span?: number },
  /**
   * `false`: a window refused for holding too many logs is not split and
   * re-read, the result is just truncated. For callers that would rather give
   * up than spend seconds on a very busy contract.
   */
  options: { split?: boolean } = {},
): Promise<{ logs: RawLog[]; truncated: boolean }> {
  const span = range.span ?? SINGLE_ADDRESS_SPAN;
  const windows: { address: string; fromBlock: number; toBlock: number }[] = [];
  const seen = new Set<string>();
  for (const source of filter.addresses) {
    const own = typeof source === 'string' ? { address: source } : source;
    const address = own.address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    // A contract has no logs outside its own active range: don't ask for them.
    const from = Math.max(range.fromBlock, own.fromBlock ?? 0);
    const until = Math.min(range.toBlock, own.toBlock ?? Number.POSITIVE_INFINITY);
    for (let to = until; to >= from; to -= span) {
      windows.push({ address, fromBlock: Math.max(from, to - span + 1), toBlock: to });
    }
  }
  if (windows.length === 0) return { logs: [], truncated: false };

  const outcomes = await rpc.callBatch<RawLog[]>(
    windows.map((w) => ({
      method: 'eth_getLogs',
      params: [
        {
          address: w.address,
          topics: filter.topics,
          fromBlock: hex(w.fromBlock),
          toBlock: hex(w.toBlock),
        },
      ],
    })),
  );

  const logs: RawLog[] = [];
  let truncated = false;
  for (const [i, outcome] of outcomes.entries()) {
    if (outcome.ok && Array.isArray(outcome.value)) {
      logs.push(...outcome.value);
      continue;
    }
    if (outcome.ok) {
      truncated = true;
      continue;
    }
    const window = windows[i];
    const tooBroad = classifyLogError(outcome.error);
    if (!window || !tooBroad || options.split === false) {
      truncated = true;
      continue;
    }
    try {
      const retry = await getLogsChunked(
        rpc,
        { address: window.address, topics: filter.topics },
        {
          fromBlock: window.fromBlock,
          toBlock: window.toBlock,
          initialSpan: tooBroad.maxSpan ?? Math.floor(span / 4),
          maxLogs: 50_000,
        },
      );
      logs.push(...retry.logs);
      truncated ||= retry.truncated;
    } catch {
      truncated = true;
    }
  }

  logs.sort(
    (a, b) =>
      Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex),
  );
  return { logs, truncated };
}
