import { LogQueryTooBroadError, type RpcClient } from './rpc';

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

const DEFAULT_INITIAL_SPAN = 500_000;
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
      // La fenêtre a tenu : on élargit prudemment plutôt que de rester timide.
      span = Math.min(initialSpan, Math.floor(span * 1.5));
    } catch (error) {
      if (!(error instanceof LogQueryTooBroadError)) throw error;

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

  return {
    logs: logs.slice(0, maxLogs),
    truncated: truncated || logs.length > maxLogs,
    scanned: { fromBlock: lowestScanned, toBlock },
  };
}
