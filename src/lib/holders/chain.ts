import type { Address } from 'viem';
import { TRANSFER_TOPIC } from '../chain/behavior';
import { isContractCode } from '../chain/code';
import { getLogsBatched } from '../chain/logs';
import type { RpcClient } from '../chain/rpc';
import type { HolderDistribution, HolderDistributionData, SetAsideRole } from '../contracts';
import { IncompleteDataError } from '../errors';
import type { BlockscoutHolder } from './blockscout';
import { computeDistribution, type FetchHoldersOptions } from './index';

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

const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

/**
 * First block where the token was minted, for a token that is not a pons
 * launch. The public node keeps no historical state (no eth_getCode at an old
 * block), but it keeps logs: the earliest Transfer from the zero address is
 * the start of every balance. One batch of 10 M-block windows.
 */
export async function findFirstMint(
  rpc: RpcClient,
  token: Address,
  latestBlock: number,
): Promise<number | undefined> {
  const { logs, truncated } = await getLogsBatched(
    rpc,
    { addresses: [token], topics: [TRANSFER_TOPIC, ZERO_TOPIC] },
    { fromBlock: 0, toBlock: latestBlock },
  );
  // A missed window could hide an earlier mint: starting later would give wrong balances.
  if (truncated) return undefined;
  const first = logs[0];
  return first ? Number(first.blockNumber) : undefined;
}

export async function fetchHoldersFromChain(
  rpc: RpcClient,
  token: Address,
  options: {
    /** Block of the token's launch: nothing can be held before it. */
    fromBlock: number;
    toBlock: number;
    poolAddress?: string;
    /** Pools, curves and launch contracts: set aside, not holders. */
    setAside?: readonly { address: string; role: SetAsideRole }[];
    now?: () => Date;
  },
): Promise<HolderDistribution> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const { logs, truncated } = await getLogsBatched(
    rpc,
    { addresses: [token], topics: [TRANSFER_TOPIC] },
    { fromBlock: options.fromBlock, toBlock: options.toBlock },
    // A token with more than 10,000 transfers in a window is too busy to
    // replay inside an analysis: say so at once instead of spending the time
    // budget (it pushed a whole analysis past its timeout).
    { split: false },
  );
  if (truncated) {
    throw new IncompleteDataError(
      'robinhood-rpc',
      'too many transfers to rebuild balances here — none are given rather than wrong ones',
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
      // A wallet delegating under EIP-7702 has code and is still a wallet.
      is_contract: i < top.length ? (codes[i]?.ok ? isContractCode(codes[i].value) : false) : false,
    },
    value: balance.toString(),
  }));

  const distribution: FetchHoldersOptions = {
    ...(options.poolAddress ? { poolAddress: options.poolAddress } : {}),
    ...(options.setAside ? { setAside: options.setAside } : {}),
  };
  // Every balance is here: their sum is the supply, the set-aside part is measured against it.
  const data = computeDistribution(token, raw, distribution, {
    holders: held.length,
    supply: null,
    complete: true,
  });

  return {
    completeness: 'full',
    sources: [
      {
        name: 'robinhood-rpc',
        fetchedAt,
        note: `computed from ${logs.length} on-chain transfers since launch`,
      },
    ],
    data,
  };
}

/** Contracts re-read by their code, at most: Blockscout's flag is kept beyond. */
export const RECHECKED_CONTRACTS = 25;

/**
 * Blockscout flags a wallet delegating under EIP-7702 as a contract: it has
 * code. The largest holders it calls contracts are re-read by their code, in
 * one batch, and a delegation turns back into a wallet. A code that could not
 * be read keeps Blockscout's word.
 */
export async function recheckContracts(
  rpc: RpcClient,
  data: HolderDistributionData,
  cap = RECHECKED_CONTRACTS,
): Promise<HolderDistributionData> {
  const flagged = [...new Set(data.top.filter((h) => h.kind === 'contract').map((h) => h.address))]
    .slice(0, cap)
    .map((a) => a.toLowerCase());
  if (flagged.length === 0) return data;
  const codes = await rpc
    .callBatch<string>(flagged.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })))
    .catch(() => []);
  const wallets = new Set(
    flagged.filter((_, i) => {
      const code = codes[i];
      return code?.ok && !isContractCode(code.value);
    }),
  );
  if (wallets.size === 0) return data;
  return {
    ...data,
    top: data.top.map((h) =>
      h.kind === 'contract' && wallets.has(h.address.toLowerCase()) ? { ...h, kind: 'wallet' } : h,
    ),
  };
}

const TOTAL_SUPPLY = '0x18160ddd';
const BALANCE_OF = '0x70a08231';

/**
 * The part of the supply the token's pools hold today, read on chain in one
 * batch: the total supply and each pool's balance. `null` when any of them
 * could not be read.
 */
export async function readPoolsShare(
  rpc: RpcClient,
  token: string,
  pools: readonly string[],
): Promise<number | null> {
  const unique = [...new Set(pools.map((p) => p.toLowerCase()))].filter((p) => p !== '0x');
  if (unique.length === 0) return null;
  const outcomes = await rpc.callBatch<string>([
    { method: 'eth_call', params: [{ to: token, data: TOTAL_SUPPLY }, 'latest'] },
    ...unique.map((pool) => ({
      method: 'eth_call',
      params: [{ to: token, data: `${BALANCE_OF}${pool.slice(2).padStart(64, '0')}` }, 'latest'],
    })),
  ]);
  const values = outcomes.map((o) =>
    o?.ok && typeof o.value === 'string' && /^0x[0-9a-f]+$/i.test(o.value) ? BigInt(o.value) : null,
  );
  if (values.some((v) => v === null)) return null;
  const [supply, ...balances] = values as bigint[];
  if (!supply || supply <= 0n) return null;
  const held = balances.reduce((sum, b) => sum + b, 0n);
  return Number((held * 1_000_000n) / supply) / 1_000_000;
}
