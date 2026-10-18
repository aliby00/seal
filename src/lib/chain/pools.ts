import { decodeEventLog, parseAbiItem, type Address } from 'viem';
import { addressTopic } from './index';
import { getLogsChunked, type GetLogsOptions, type RawLog } from './logs';
import type { RpcClient } from './rpc';
import { V4_SWAP_TOPIC } from './trades';

/**
 * Les marchés Uniswap v4 de Robinhood Chain, lus à la source.
 *
 * Un marché v4 naît d'un `Initialize` émis par le PoolManager — il n'y a pas
 * de contrat de pool, juste un identifiant. Le hook, c'est-à-dire le rulebook
 * du marché, est dans ce même événement. D'où cet index : c'est lui qui permet
 * de dire « ce rulebook porte déjà 28 marchés », ce qu'aucune lecture d'un
 * marché isolé ne peut dire.
 *
 * Vérifié le 11/10/2026 : 174 `Initialize` sur les 30 000 derniers blocs
 * (~50 minutes), code présent à l'adresse, signature recalculée par keccak.
 */
export const POOL_MANAGER: Address = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

export const INITIALIZE = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

export const INITIALIZE_TOPIC =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

/** La monnaie native s'écrit 0x0 en v4. */
export const NATIVE = '0x0000000000000000000000000000000000000000';

/**
 * WETH de Robinhood Chain. Relevé le 11/10/2026 : 10 marchés sur 167 cotés
 * contre cette adresse, dont le `symbol()` répond WETH. Sans elle, ces
 * marchés étaient indexés comme si leur token était… WETH.
 */
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

export const QUOTE_CURRENCIES: readonly string[] = [NATIVE, WETH];

export type V4Market = {
  id: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hook: string;
  blockNumber: number;
  transactionHash: string;
};

export function decodeInitialize(log: RawLog): V4Market {
  const decoded = decodeEventLog({
    abi: [INITIALIZE],
    data: log.data as `0x${string}`,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });
  const a = decoded.args as unknown as {
    id: string;
    currency0: string;
    currency1: string;
    fee: number;
    tickSpacing: number;
    hooks: string;
  };
  return {
    id: a.id.toLowerCase(),
    currency0: a.currency0.toLowerCase(),
    currency1: a.currency1.toLowerCase(),
    fee: Number(a.fee),
    tickSpacing: Number(a.tickSpacing),
    hook: a.hooks.toLowerCase(),
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
  };
}

/** Tous les marchés créés sur une fenêtre. Sans filtre d'adresse de token : plafond à 30 000 blocs par requête. */
export async function scanMarkets(
  rpc: RpcClient,
  range: Pick<GetLogsOptions, 'fromBlock' | 'toBlock'> & Partial<GetLogsOptions>,
): Promise<{
  markets: V4Market[];
  truncated: boolean;
  scanned: { fromBlock: number; toBlock: number };
}> {
  const { logs, truncated, scanned } = await getLogsChunked(
    rpc,
    { address: POOL_MANAGER, topics: [INITIALIZE_TOPIC] },
    range,
  );
  return { markets: logs.map(decodeInitialize), truncated, scanned };
}

/**
 * Les marchés d'un token donné. Le token peut être `currency0` ou `currency1` :
 * deux requêtes, parce qu'un filtre de topics ne sait pas exprimer « l'un ou
 * l'autre » entre deux positions.
 */
export async function findMarketsOf(
  rpc: RpcClient,
  token: string,
  range: Pick<GetLogsOptions, 'fromBlock' | 'toBlock'>,
): Promise<V4Market[]> {
  const topic = addressTopic(token);
  // Filtré par adresse, le nœud accepte des fenêtres bien plus larges.
  const options = { ...range, initialSpan: 10_000_000, maxLogs: 50 };
  const [as0, as1] = await Promise.all([
    getLogsChunked(
      rpc,
      { address: POOL_MANAGER, topics: [INITIALIZE_TOPIC, null, topic] },
      options,
    ),
    getLogsChunked(
      rpc,
      { address: POOL_MANAGER, topics: [INITIALIZE_TOPIC, null, null, topic] },
      options,
    ),
  ]);
  return [...as0.logs, ...as1.logs]
    .map(decodeInitialize)
    .sort((a, b) => a.blockNumber - b.blockNumber);
}

/** Blocks per `Initialize` query for one pool id: the node allows 10 M with one value per topic. */
export const MARKET_ID_SPAN = 10_000_000;
/**
 * Robinhood Chain's pace, measured on 18/10/2026: 9.78 to 9.98 blocks a
 * second between blocks 5 M and 91.5 M. A pool's creation time then says
 * roughly where its `Initialize` is.
 */
export const BLOCKS_PER_SECOND = 9.9;
/** Half the window searched around that estimate: 2 % of 100 M blocks, with room. */
const ESTIMATE_MARGIN = 2_500_000;

type Window = { fromBlock: number; toBlock: number };

const hex = (n: number) => `0x${n.toString(16)}`;

/** Every 10 M-block window from the head down to the first block. */
function fullScan(latestBlock: number): Window[] {
  const windows: Window[] = [];
  for (let to = latestBlock; to >= 0; to -= MARKET_ID_SPAN) {
    windows.push({ fromBlock: Math.max(0, to - MARKET_ID_SPAN + 1), toBlock: to });
  }
  return windows;
}

/**
 * The v4 markets with these ids, from their `Initialize`, over the whole
 * chain. The node takes one id per query over a long range (a list of ids
 * narrows it to 100 000 blocks), so each id is looked for around where its
 * creation time puts it, then, for the first `fullScanFor` ids still
 * missing, over every 10 M-block window. ASTEROID's main pool was opened
 * 82 M blocks back, beyond the 30 M the token search covers. An id not
 * found stays out: its rules are unread, never "none".
 */
export async function findMarketsById(
  rpc: RpcClient,
  pools: readonly { id: string; createdAt?: number | null }[],
  latestBlock: number,
  options: { now?: number; fullScanFor?: number } = {},
): Promise<{ markets: V4Market[]; unread: boolean; failed?: boolean }> {
  const wanted = pools
    .map((p) => ({ id: p.id.toLowerCase(), createdAt: p.createdAt ?? null }))
    .filter(
      (p, i, all) => /^0x[0-9a-f]{64}$/.test(p.id) && all.findIndex((q) => q.id === p.id) === i,
    );
  if (wanted.length === 0 || latestBlock <= 0) return { markets: [], unread: false };
  const now = options.now ?? Date.now();
  const found = new Map<string, V4Market>();
  // A query the node failed is not a market that does not exist.
  let failed = false;

  async function ask(queries: { id: string; window: Window }[]): Promise<void> {
    if (queries.length === 0) return;
    const outcomes = await rpc
      .callBatch<RawLog[]>(
        queries.map(({ id, window }) => ({
          method: 'eth_getLogs',
          params: [
            {
              address: POOL_MANAGER,
              topics: [INITIALIZE_TOPIC, id],
              fromBlock: hex(window.fromBlock),
              toBlock: hex(window.toBlock),
            },
          ],
        })),
      )
      .catch(() => {
        failed = true;
        return [];
      });
    for (const outcome of outcomes) {
      if (!outcome.ok || !Array.isArray(outcome.value)) {
        failed = true;
        continue;
      }
      for (const log of outcome.value) {
        const market = decodeInitialize(log);
        if (!found.has(market.id)) found.set(market.id, market);
      }
    }
  }

  // Around where each pool's creation time puts it.
  await ask(
    wanted.map(({ id, createdAt }) => {
      if (createdAt === null || !Number.isFinite(createdAt)) {
        return {
          id,
          window: {
            fromBlock: Math.max(0, latestBlock - MARKET_ID_SPAN + 1),
            toBlock: latestBlock,
          },
        };
      }
      const ago = Math.max(0, (now - createdAt) / 1000) * BLOCKS_PER_SECOND;
      const estimate = Math.round(latestBlock - ago);
      return {
        id,
        window: {
          fromBlock: Math.max(0, Math.min(latestBlock, estimate - ESTIMATE_MARGIN)),
          toBlock: Math.max(0, Math.min(latestBlock, estimate + ESTIMATE_MARGIN)),
        },
      };
    }),
  );
  // Then the whole chain, for the first ones still missing (the main pool first).
  const missing = wanted.filter((p) => !found.has(p.id)).slice(0, options.fullScanFor ?? 1);
  await ask(missing.flatMap(({ id }) => fullScan(latestBlock).map((window) => ({ id, window }))));
  const unread = wanted.some((p) => !found.has(p.id));
  return {
    markets: [...found.values()],
    unread,
    ...(failed && unread ? { failed: true } : {}),
  };
}

/** Candidates weighed when a token has several v4 markets. */
export const MAX_MARKET_CANDIDATES = 8;
/** Trades counted per candidate, over the last ~11.5 days. */
const MARKET_ACTIVITY_BLOCKS = 10_000_000;

/**
 * Which of a token's v4 markets is its market.
 *
 * Anyone can initialise a v4 market on any token, with any rulebook: taking
 * the first one found let a stranger's empty market, with a hook of their
 * choosing, stand for the token. So the market its creator opened comes
 * first; failing that, the one that trades the most; failing a reading, the
 * earliest quoted against ETH.
 */
export async function pickMarket<T extends V4Market>(
  rpc: RpcClient,
  markets: readonly T[],
  options: { creator?: string | null; latestBlock?: number } = {},
): Promise<T | null> {
  if (markets.length <= 1) return markets[0] ?? null;
  const candidates = [...markets]
    .sort((a, b) => a.blockNumber - b.blockNumber)
    .slice(0, MAX_MARKET_CANDIDATES);

  const creator = options.creator?.toLowerCase();
  if (creator) {
    const senders = await rpc
      .callBatch<{ from?: string } | null>(
        candidates.map((m) => ({
          method: 'eth_getTransactionByHash',
          params: [m.transactionHash],
        })),
      )
      .catch(() => []);
    const own = candidates.find((_, i) => {
      const sender = senders[i];
      return sender?.ok && sender.value?.from?.toLowerCase() === creator;
    });
    if (own) return own;
  }

  if (options.latestBlock !== undefined) {
    const latest = options.latestBlock;
    const fromBlock = `0x${Math.max(0, latest - MARKET_ACTIVITY_BLOCKS + 1).toString(16)}`;
    const trades = await rpc
      .callBatch<RawLog[]>(
        candidates.map((m) => ({
          method: 'eth_getLogs',
          params: [
            {
              address: POOL_MANAGER,
              topics: [V4_SWAP_TOPIC, m.id],
              fromBlock,
              toBlock: `0x${latest.toString(16)}`,
            },
          ],
        })),
      )
      .catch(() => []);
    // A market too busy to list is the busiest.
    const counts = candidates.map((_, i) => {
      const outcome = trades[i];
      if (!outcome) return -1;
      if (outcome.ok) return Array.isArray(outcome.value) ? outcome.value.length : -1;
      return /exceeds limit|returned more than|response size exceeded/i.test(outcome.error)
        ? Number.POSITIVE_INFINITY
        : -1;
    });
    const best = Math.max(...counts);
    if (best > 0) return candidates[counts.indexOf(best)] ?? null;
  }

  const quotes = new Set(QUOTE_CURRENCIES);
  return (
    candidates.find((m) => quotes.has(m.currency0) || quotes.has(m.currency1)) ??
    candidates[0] ??
    null
  );
}

/** Le côté « token » d'un marché : celui qui n'est pas la monnaie de cotation. */
export function tokenSide(market: V4Market, quote: readonly string[] = QUOTE_CURRENCIES): string {
  const quotes = new Set(quote.map((q) => q.toLowerCase()));
  if (quotes.has(market.currency0) && !quotes.has(market.currency1)) return market.currency1;
  return market.currency0 === NATIVE ? market.currency1 : market.currency0;
}

/**
 * Ce qui est arrivé à un marché ensuite. `harmed` = la liquidité a été retirée
 * ou le créateur a vendu son allocation — des faits, observés après coup. C'est
 * ce qui permet de rejouer un agent sur le passé et de compter ce qu'il aurait
 * vu venir.
 */
export type MarketOutcome = 'harmed' | 'unharmed' | 'unknown';

export type IndexedMarket = V4Market & {
  token: string;
  name?: string | null;
  symbol?: string | null;
  outcome?: MarketOutcome;
};

/**
 * Index inter-marchés, en mémoire et sérialisable.
 *
 * Pas de base de données : l'index se reconstruit depuis la chaîne, qui reste
 * la seule source de vérité. Le JSON produit par `toJSON` sert de cache entre
 * deux exécutions, pas de référence.
 */
export class MarketIndex {
  private readonly byId = new Map<string, IndexedMarket>();
  private readonly byHook = new Map<string, Set<string>>();
  private readonly byToken = new Map<string, Set<string>>();

  constructor(markets: readonly IndexedMarket[] = []) {
    for (const market of markets) this.add(market);
  }

  add(market: IndexedMarket): void {
    if (this.byId.has(market.id)) return;
    this.byId.set(market.id, market);
    const push = (map: Map<string, Set<string>>, key: string) => {
      const set = map.get(key) ?? new Set<string>();
      set.add(market.id);
      map.set(key, set);
    };
    push(this.byHook, market.hook);
    push(this.byToken, market.token);
  }

  get size(): number {
    return this.byId.size;
  }

  all(): IndexedMarket[] {
    return [...this.byId.values()].sort((a, b) => a.blockNumber - b.blockNumber);
  }

  get(id: string): IndexedMarket | undefined {
    return this.byId.get(id.toLowerCase());
  }

  onHook(hook: string): IndexedMarket[] {
    return [...(this.byHook.get(hook.toLowerCase()) ?? [])]
      .map((id) => this.byId.get(id))
      .filter((m): m is IndexedMarket => m !== undefined);
  }

  ofToken(token: string): IndexedMarket[] {
    return [...(this.byToken.get(token.toLowerCase()) ?? [])]
      .map((id) => this.byId.get(id))
      .filter((m): m is IndexedMarket => m !== undefined);
  }

  /** Les rulebooks les plus réutilisés. L'adresse nulle (pas de hook) est exclue : ce n'est pas un rulebook. */
  topHooks(limit = 10): { hook: string; markets: number }[] {
    return [...this.byHook.entries()]
      .filter(([hook]) => hook !== NATIVE)
      .map(([hook, ids]) => ({ hook, markets: ids.size }))
      .sort((a, b) => b.markets - a.markets)
      .slice(0, limit);
  }

  toJSON(): IndexedMarket[] {
    return this.all();
  }

  static fromJSON(markets: readonly IndexedMarket[]): MarketIndex {
    return new MarketIndex(markets);
  }
}
