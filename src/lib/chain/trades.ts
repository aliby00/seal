import type { RawLog } from './logs';
import type { RpcClient } from './rpc';

/**
 * What a transaction that moved tokens into or out of a pool actually did.
 *
 * A `Transfer` to a pool reads the same whether the sender sold or added
 * liquidity: providing to a Uniswap V3 position pulls the tokens from the
 * provider straight into the pool. Only the pool's own events tell them apart,
 * so the transaction's receipt is read: a `Swap` makes it a trade, a `Mint`,
 * `Burn` or `ModifyLiquidity` without a swap makes it liquidity.
 */

/** Uniswap v4 `Swap`, emitted by the PoolManager with the market id as topic 1. */
export const V4_SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

/** Uniswap V2, V3 and v4 `Swap`. */
export const SWAP_TOPICS = new Set([
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  V4_SWAP_TOPIC,
]);

/** Uniswap V2 and V3 `Mint` and `Burn`, and v4 `ModifyLiquidity`. */
export const LIQUIDITY_TOPICS = new Set([
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
]);

/** Receipts read for one analysis step, at most: they are cheap, not free. */
export const MAX_RECEIPTS = 60;

/**
 * - `swap`: a pool traded in this transaction;
 * - `liquidity`: a pool's liquidity changed and nothing was traded;
 * - `other`: neither, such as tokens sent to a pool's address by hand.
 */
export type TxNature = 'swap' | 'liquidity' | 'other';

export function natureOf(
  logs: readonly RawLog[],
  pools: ReadonlySet<string>,
  /** What counts as a trade: the Uniswap swaps, plus a launchpad curve's own trade events. */
  swapTopics: ReadonlySet<string> = SWAP_TOPICS,
): TxNature {
  const fromPool = logs.filter((l) => pools.has(l.address.toLowerCase()));
  if (fromPool.some((l) => swapTopics.has((l.topics[0] ?? '').toLowerCase()))) return 'swap';
  if (fromPool.some((l) => LIQUIDITY_TOPICS.has((l.topics[0] ?? '').toLowerCase()))) {
    return 'liquidity';
  }
  return 'other';
}

/** What a receipt says of a transaction: what it did, and who sent it. */
export type TxDetail = { nature: TxNature; from: string | null; logs: RawLog[] };

/**
 * Reads the receipts of `hashes` (the first `cap`, MAX_RECEIPTS by default)
 * in one batch. A hash missing from the result could not be read: its
 * nature is unknown.
 */
export async function readTxDetails(
  rpc: RpcClient,
  hashes: readonly string[],
  pools: ReadonlySet<string>,
  swapTopics: ReadonlySet<string> = SWAP_TOPICS,
  cap = MAX_RECEIPTS,
): Promise<Map<string, TxDetail>> {
  const unique = [...new Set(hashes)].slice(0, cap);
  const details = new Map<string, TxDetail>();
  if (unique.length === 0) return details;
  const outcomes = await rpc.callBatch<{ logs?: RawLog[]; from?: string } | null>(
    unique.map((hash) => ({ method: 'eth_getTransactionReceipt', params: [hash] })),
  );
  unique.forEach((hash, i) => {
    const outcome = outcomes[i];
    const value = outcome?.ok ? outcome.value : undefined;
    const logs = value?.logs;
    if (Array.isArray(logs)) {
      details.set(hash, {
        nature: natureOf(logs, pools, swapTopics),
        from: typeof value?.from === 'string' ? value.from.toLowerCase() : null,
        logs,
      });
    }
  });
  return details;
}

/** The natures of `hashes`, from their receipts. */
export async function readTxNatures(
  rpc: RpcClient,
  hashes: readonly string[],
  pools: ReadonlySet<string>,
  swapTopics: ReadonlySet<string> = SWAP_TOPICS,
): Promise<Map<string, TxNature>> {
  const details = await readTxDetails(rpc, hashes, pools, swapTopics);
  return new Map([...details].map(([hash, d]) => [hash, d.nature]));
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * A sale routed through other contracts: the creator sent the transaction,
 * and in it the token reached one of its markets, which traded. Measured on
 * AML (tx 0x259e0e3e…): the creator's tokens went to a relay router
 * (0xb92f…), then an executor (0xec9a…), then the PoolManager, which swapped;
 * read transfer by transfer, the creator "sent tokens to a router".
 */
export function isRoutedSale(
  detail: TxDetail | undefined,
  token: string,
  creator: string,
  markets: ReadonlySet<string>,
): boolean {
  if (!detail || detail.nature !== 'swap' || detail.from !== creator.toLowerCase()) return false;
  const own = token.toLowerCase();
  return detail.logs.some(
    (l) =>
      l.address.toLowerCase() === own &&
      (l.topics[0] ?? '').toLowerCase() === TRANSFER &&
      l.topics.length === 3 &&
      markets.has(`0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase()),
  );
}

/** Transactions read to find routed sales, per analysis step. */
export const MAX_ROUTED_RECEIPTS = 20;

/**
 * The tokens a creator sold through a router: of the creator's transfers to
 * addresses that are not its markets, the receipts of the transactions read
 * (the recipients the creator sent to most often first — a router comes
 * back — then the most recent), each checked with `isRoutedSale`.
 */
export async function findRoutedSales(
  rpc: RpcClient,
  creator: string,
  transfers: readonly { token: string; to: string; hash: string }[],
  marketsOf: (token: string) => ReadonlySet<string>,
  swapTopics: ReadonlySet<string> = SWAP_TOPICS,
  /** The analysed token: its transactions are read first. */
  focus?: string,
): Promise<Set<string>> {
  const sold = new Set<string>();
  if (transfers.length === 0) return sold;
  const count = new Map<string, number>();
  for (const t of transfers) count.set(t.to, (count.get(t.to) ?? 0) + 1);
  const own = (t: { token: string }) => (focus && t.token === focus.toLowerCase() ? 0 : 1);
  const order = transfers
    .map((t, i) => ({ ...t, i }))
    .sort(
      (a, b) => own(a) - own(b) || (count.get(b.to) ?? 0) - (count.get(a.to) ?? 0) || b.i - a.i,
    );
  const hashes = [...new Set(order.map((t) => t.hash))].slice(0, MAX_ROUTED_RECEIPTS);
  const allMarkets = new Set(transfers.flatMap((t) => [...marketsOf(t.token)]));
  const details = await readTxDetails(rpc, hashes, allMarkets, swapTopics).catch(
    () => new Map<string, TxDetail>(),
  );
  for (const t of transfers) {
    if (isRoutedSale(details.get(t.hash), t.token, creator, marketsOf(t.token))) sold.add(t.token);
  }
  return sold;
}
