import type { Address } from 'viem';
import { TRANSFER_TOPIC } from '../chain/behavior';
import { POOL_MANAGER } from '../chain/pools';
import { getLogsBatched } from '../chain/logs';
import type { RpcClient } from '../chain/rpc';
import type { HolderDistribution } from '../contracts';
import { IncompleteDataError } from '../errors';
import type { BlockscoutHolder } from './blockscout';
import { computeDistribution } from './index';

/**
 * Holder distribution rebuilt from the token's own `Transfer` events, for when
 * there is no Blockscout key. Free, and exact — on one condition: every
 * transfer since the launch must have been read. A balance computed from part
 * of the history is not a smaller truth, it is a wrong number, so a truncated
 * read is refused rather than reported as partial.
 */

const ZERO = '0x0000000000000000000000000000000000000000';

/** Holders whose code is checked (wallet or contract). The rest only add up. */
const CLASSIFIED = 25;

function topicAddress(topic: string | undefined): string {
  return topic ? `0x${topic.slice(26)}`.toLowerCase() : '';
}

export function balancesFromTransfers(
  logs: readonly { topics: string[]; data: string }[],
): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  for (const log of logs) {
    // A Transfer has three topics; anything else under this signature
    // (an ERC-721 transfer, a malformed event) is not a fungible movement.
    if (log.topics.length !== 3) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    const raw = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
    if (raw.length < 64) continue;
    const value = BigInt(`0x${raw.slice(0, 64)}`);
    if (value === 0n) continue;
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    balances.set(to, (balances.get(to) ?? 0n) + value);
  }
  return balances;
}

export async function fetchHoldersFromChain(
  rpc: RpcClient,
  token: Address,
  options: {
    /** Block of the token's launch: nothing can be held before it. */
    fromBlock: number;
    toBlock: number;
    poolAddress?: string;
    now?: () => Date;
  },
): Promise<HolderDistribution> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const { logs, truncated } = await getLogsBatched(
    rpc,
    { addresses: [token], topics: [TRANSFER_TOPIC] },
    { fromBlock: options.fromBlock, toBlock: options.toBlock },
  );
  if (truncated) {
    throw new IncompleteDataError(
      'robinhood-rpc',
      'not every transfer since launch could be read — balances would be wrong, so none are given',
    );
  }

  const balances = balancesFromTransfers(logs);
  const held = [...balances].filter(([, balance]) => balance > 0n);
  held.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

  // The pool may hold most of the supply: classify enough addresses that the
  // top ten wallets are known for what they are, whatever sits above them.
  const top = held.slice(0, CLASSIFIED);
  const codes = await rpc.callBatch<string>(
    top.map(([address]) => ({ method: 'eth_getCode', params: [address, 'latest'] })),
  );
  const raw: BlockscoutHolder[] = held.map(([address, balance], i) => ({
    address: {
      hash: address,
      // Only the classified ones are known; the long tail counts as wallets.
      is_contract: i < top.length ? (codes[i]?.ok ? codes[i].value !== '0x' : false) : false,
    },
    value: balance.toString(),
  }));

  // The v4 PoolManager holds every v4 market's liquidity: it is never a holder.
  const pool = options.poolAddress;
  const data = computeDistribution(
    token,
    raw.filter((h) => h.address?.hash !== POOL_MANAGER),
    { poolAddress: pool },
  );
  const holderCount = held.filter(([address]) => address !== pool?.toLowerCase()).length;

  return {
    completeness: 'full',
    sources: [
      {
        name: 'robinhood-rpc',
        fetchedAt,
        note: `computed from ${logs.length} on-chain transfers since launch`,
      },
    ],
    data: { ...data, holderCount },
  };
}
