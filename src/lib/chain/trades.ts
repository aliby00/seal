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

/**
 * Reads the receipts of `hashes` (the first MAX_RECEIPTS) in batches. A hash
 * missing from the result could not be read: its nature is unknown.
 */
export async function readTxNatures(
  rpc: RpcClient,
  hashes: readonly string[],
  pools: ReadonlySet<string>,
  swapTopics: ReadonlySet<string> = SWAP_TOPICS,
): Promise<Map<string, TxNature>> {
  const unique = [...new Set(hashes)].slice(0, MAX_RECEIPTS);
  const natures = new Map<string, TxNature>();
  if (unique.length === 0) return natures;
  const outcomes = await rpc.callBatch<{ logs?: RawLog[] } | null>(
    unique.map((hash) => ({ method: 'eth_getTransactionReceipt', params: [hash] })),
  );
  unique.forEach((hash, i) => {
    const outcome = outcomes[i];
    const logs = outcome?.ok ? outcome.value?.logs : undefined;
    if (Array.isArray(logs)) natures.set(hash, natureOf(logs, pools, swapTopics));
  });
  return natures;
}
