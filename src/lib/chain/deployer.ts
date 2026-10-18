import type { Address } from 'viem';
import type {
  CreatorHistory,
  CreatorOrigin,
  LaunchedToken,
  LiquidityRemoval,
  SalesWindow,
} from '../contracts';
import {
  BURN_TOPIC,
  creatorSendsOf,
  distinctRecipients,
  OWN_SALES_MAX_BLOCKS,
  salesWindowDays,
  TRANSFER_TOPIC,
  topicFor,
} from './behavior';
import { isContractCode } from './code';
import { IncompleteDataError } from '../errors';
import { UNREAD } from '../failed-reads';
import { fetchBlockTimestamps } from './graduation';
import {
  creatorFilter,
  findLaunchRecord,
  LAUNCHPADS,
  readLaunchRecord,
  type Launchpad,
  type LaunchRecord,
} from './launchpads';
import { getLogsBatched, SINGLE_ADDRESS_SPAN, type RawLog } from './logs';
import { POOL_MANAGER } from './pools';
import {
  classifyLogError,
  DEFAULT_RPC_URL,
  logsRpcUrl,
  type BatchOutcome,
  type RpcClient,
} from './rpc';
import { findRoutedSales, readTxNatures, SWAP_TOPICS } from './trades';

/**
 * The creator of a token that is not a pons launch.
 *
 * A pons launch names its creator in its launch record. Any other token has
 * no such record, and this node keeps no traces: what remains is the token's
 * first mint. The transaction that carried it says who sent it, and its
 * receipt shows what was created alongside — the market, and very often an
 * event of the launch contract that names the token and its creator together.
 * That event is what lists the creator's other launches: the same contract,
 * the same event, the creator in the same place.
 *
 * Measured on 16/10/2026 on six recent tokens: four launch contracts out of
 * five name the creator in an indexed topic; one launch went through an
 * ERC-4337 bundler, where the sender of the transaction is not the creator.
 */

const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

/** ERC-4337 EntryPoints (v0.6, v0.7, v0.8): the transaction sender is a bundler. */
export const ENTRY_POINTS: readonly string[] = [
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',
  '0x0000000071727de22e5e9d8baf0edac6f37da032',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108',
];

/** `UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)`: topic 2 is the account. */
export const USER_OPERATION_EVENT_TOPIC =
  '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';

/** Uniswap V2 `PairCreated(address,address,address,uint256)`: the pair is the first data word. */
export const PAIR_CREATED_TOPIC =
  '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';

/** Uniswap V3 `PoolCreated(address,address,uint24,int24,address)`: the pool is the second data word. */
export const POOL_CREATED_TOPIC =
  '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';

/** Uniswap V2 `Burn(address,uint256,uint256,address)`. */
export const V2_BURN_TOPIC = '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496';

/** Uniswap v4 `Initialize(...)` on the PoolManager: topic 1 is the market id. */
export const V4_INITIALIZE_TOPIC =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

/** Uniswap v4 `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)`. */
export const MODIFY_LIQUIDITY_TOPIC =
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';

/** A sales window, with how many days it covers. */
export function salesWindowOf(
  window: { fromBlock: number; toBlock: number },
  latest: number,
  launchedAt: string | null,
  now: () => Date,
): SalesWindow {
  return {
    ...window,
    days: salesWindowDays({ ...window, latest, launchedAt, now: now() }),
    wholeLife: window.toBlock >= latest,
  };
}

/** Launches read in detail, and launches whose sales and liquidity are checked. */
export const MAX_DETAILED_DEPLOYER_LAUNCHES = 40;
export const MAX_CHECKED_DEPLOYER_LAUNCHES = 10;
/** Same window as for pons launches: ~11.5 days at 0.101 s per block. */
export const DEPLOYER_BEHAVIOR_WINDOW = 10_000_000;
/** Markets created in one launch: more is a router doing something else. */
const MAX_VENUES = 4;

export type ChainTransaction = { from: string; to: string | null; hash: string };
export type ChainReceipt = { contractAddress: string | null; logs: RawLog[] };

/** The launch contract's event that names a token and its creator. */
export type CreatorRegistry = {
  address: string;
  topic0: string;
  tokenIndex: number;
  creatorIndex: number;
};

/** Where the token trades: a sale is a transfer into one of these. */
export type TradingVenues = {
  /** V2 pairs and V3 pools: contracts holding the reserves, emitting `Burn`. */
  pools: string[];
  /** v4 market ids; their reserves sit in the PoolManager. */
  v4Markets: string[];
  /**
   * Bonding curves of a known launchpad. A transfer into one is a sale only
   * when the curve emitted one of `curveTrades` in the same transaction.
   */
  curves?: string[];
  curveTrades?: string[];
  /**
   * The trading rules (hooks) of the v4 markets created at launch, from their
   * `Initialize`: they hold the token for the market, never for a person.
   */
  hooks?: string[];
  /** Addresses a transfer from the creator into counts as a sale. */
  saleRecipients: string[];
};

/** The launchpad a token came from, as the report names it. */
export type LaunchpadRef = { id: string; name: string; address: string };

export type TokenOrigin = {
  token: string;
  creator: string;
  role: CreatorOrigin['role'];
  launchContract?: string;
  blockNumber: number;
  transactionHash: string;
  registry?: CreatorRegistry;
  venues: TradingVenues;
  /** The known launchpad whose launch event names this token. */
  launchpad?: LaunchpadRef;
  /**
   * Where the creator was read: the launch event itself, or the sender of the
   * transaction (no launch event, an event that does not name the creator, or
   * one that names the contract relaying the call).
   */
  creatorFrom?: 'launch-record' | 'transaction';
};

const lower = (value: string) => value.toLowerCase();
const fromTopic = (topic: string | undefined) => (topic ? lower(`0x${topic.slice(26)}`) : '');
const word = (data: string, index: number) => {
  const raw = data.startsWith('0x') ? data.slice(2) : data;
  return raw.slice(index * 64, index * 64 + 64);
};

/**
 * Who started the transaction. Through an ERC-4337 EntryPoint, the sender is
 * a bundler serving many accounts: the creator is the account of the user
 * operation that ran the mint — the first `UserOperationEvent` after it.
 */
export function creatorOf(
  transaction: ChainTransaction,
  receipt: ChainReceipt,
  mintLogIndex: number,
): string {
  const to = transaction.to ? lower(transaction.to) : null;
  if (to && ENTRY_POINTS.includes(to)) {
    const operation = receipt.logs.find(
      (l) =>
        lower(l.address) === to &&
        l.topics[0] === USER_OPERATION_EVENT_TOPIC &&
        Number(l.logIndex) > mintLogIndex,
    );
    if (operation?.topics[2]) return fromTopic(operation.topics[2]);
  }
  return lower(transaction.from);
}

/**
 * The launch contract's own record of this launch: an event, emitted by
 * something other than the token, whose topics hold both the token and the
 * creator. Its position tells where to put the creator to list the others.
 */
export function findRegistry(
  token: string,
  creator: string,
  logs: readonly RawLog[],
): CreatorRegistry | undefined {
  const tokenTopic = topicFor(token);
  const creatorTopic = topicFor(creator);
  for (const log of logs) {
    if (lower(log.address) === lower(token) || !log.topics[0]) continue;
    const tokenIndex = log.topics.indexOf(tokenTopic);
    const creatorIndex = log.topics.indexOf(creatorTopic);
    if (tokenIndex > 0 && creatorIndex > 0) {
      return { address: lower(log.address), topic0: log.topics[0], tokenIndex, creatorIndex };
    }
  }
  return undefined;
}

/** Markets created for the token in its launch transaction. */
export function findVenues(
  token: string,
  logs: readonly RawLog[],
  launchContract?: string,
): TradingVenues {
  const tokenTopic = topicFor(token);
  const pools: string[] = [];
  const v4Markets: string[] = [];
  const hooks: string[] = [];
  for (const log of logs) {
    const named = log.topics.slice(1).includes(tokenTopic);
    if (!named) continue;
    if (log.topics[0] === PAIR_CREATED_TOPIC) pools.push(lower(`0x${word(log.data, 0).slice(24)}`));
    else if (log.topics[0] === POOL_CREATED_TOPIC)
      pools.push(lower(`0x${word(log.data, 1).slice(24)}`));
    else if (
      log.topics[0] === V4_INITIALIZE_TOPIC &&
      lower(log.address) === lower(POOL_MANAGER) &&
      log.topics[1]
    ) {
      v4Markets.push(lower(log.topics[1]));
      // `Initialize(id, currency0, currency1, fee, tickSpacing, hooks, …)`: the third data word.
      const hook = lower(`0x${word(log.data, 2).slice(24)}`);
      if (/^0x[0-9a-f]{40}$/.test(hook) && !/^0x0{40}$/.test(hook)) hooks.push(hook);
    }
  }
  const uniquePools = [...new Set(pools)].slice(0, MAX_VENUES);
  const uniqueMarkets = [...new Set(v4Markets)].slice(0, MAX_VENUES);
  const uniqueHooks = [...new Set(hooks)].slice(0, MAX_VENUES);
  // A launch contract that holds the curve buys and sells itself: a transfer
  // from the creator into it is a sale on that curve.
  const recipients = [
    ...uniquePools,
    ...(uniqueMarkets.length > 0 ? [lower(POOL_MANAGER)] : []),
    ...(launchContract ? [lower(launchContract)] : []),
  ];
  return {
    pools: uniquePools,
    v4Markets: uniqueMarkets,
    ...(uniqueHooks.length > 0 ? { hooks: uniqueHooks } : {}),
    saleRecipients: [...new Set(recipients)],
  };
}

/** Adds what a launch event says about the token's markets to the venues found in its receipt. */
export function withRecordVenues(
  venues: TradingVenues,
  record: LaunchRecord | null,
): TradingVenues {
  if (!record) return venues;
  const pools = [...new Set([...venues.pools, ...(record.pool ? [record.pool] : [])])];
  const v4Markets = [...new Set([...venues.v4Markets, ...(record.market ? [record.market] : [])])];
  const curves = [...new Set([...(venues.curves ?? []), ...(record.curve ? [record.curve] : [])])];
  const curveTrades = [
    ...new Set([...(venues.curveTrades ?? []), ...(record.launchpad.curveTrades ?? [])]),
  ];
  const saleRecipients = [
    ...new Set([
      ...venues.saleRecipients,
      ...pools,
      ...(v4Markets.length > 0 ? [lower(POOL_MANAGER)] : []),
      ...curves,
    ]),
  ];
  return {
    pools,
    v4Markets,
    curves,
    curveTrades,
    ...(venues.hooks ? { hooks: venues.hooks } : {}),
    saleRecipients,
  };
}

export const launchpadRef = (launchpad: Launchpad): LaunchpadRef => ({
  id: launchpad.id,
  name: launchpad.name,
  address: launchpad.address,
});

/** Reads one token's origin from the transaction that carried its first mint. */
export function readOrigin(
  token: string,
  mint: RawLog,
  transaction: ChainTransaction,
  receipt: ChainReceipt,
  /** The launch event names a contract (a router, a batch executor), not a wallet. */
  creatorIsContract = false,
): TokenOrigin {
  const sender = creatorOf(transaction, receipt, Number(mint.logIndex));
  const to = transaction.to ? lower(transaction.to) : null;
  const record = findLaunchRecord(token, receipt.logs, sender);
  // A launch event names who called the launchpad. When that is the very
  // contract the transaction called — a router or a vault factory relaying
  // the launch — or any other contract, the person is whoever sent it.
  const relayed = Boolean(
    record?.creator &&
    ((to && record.creator === to && to !== record.launchpad.address) || creatorIsContract),
  );
  const fromRecord = Boolean(record?.creator) && !relayed;
  const creator = fromRecord && record?.creator ? record.creator : sender;
  const created = receipt.contractAddress && lower(receipt.contractAddress) === lower(token);
  const role: CreatorOrigin['role'] = created
    ? 'deployer'
    : record || to !== lower(token)
      ? 'launcher'
      : 'first-minter';
  const launchContract = record
    ? record.launchpad.address
    : role === 'launcher' && to && !ENTRY_POINTS.includes(to)
      ? to
      : undefined;
  const registry = record ? undefined : findRegistry(token, creator, receipt.logs);
  return {
    token: lower(token),
    creator,
    role,
    ...(launchContract ? { launchContract } : {}),
    blockNumber: Number(mint.blockNumber),
    transactionHash: mint.transactionHash,
    ...(registry ? { registry } : {}),
    // A known launchpad's curve is confirmed by its own trade events; an
    // unknown launch contract keeps the older reading, where a transfer into
    // it is a sale on its curve.
    venues: withRecordVenues(
      findVenues(token, receipt.logs, record ? undefined : launchContract),
      record,
    ),
    ...(record ? { launchpad: launchpadRef(record.launchpad) } : {}),
    creatorFrom: fromRecord ? 'launch-record' : 'transaction',
  };
}

/**
 * The token's first mint: a Transfer from the zero address. This node keeps
 * logs, not historical state, so this is where every balance — and every
 * trace of authorship — starts. One batch of 10 M-block windows.
 */
export async function findFirstMintLog(
  rpc: RpcClient,
  token: Address,
  latestBlock: number,
): Promise<RawLog | undefined> {
  const { logs, truncated } = await getLogsBatched(
    rpc,
    { addresses: [token], topics: [TRANSFER_TOPIC, ZERO_TOPIC] },
    { fromBlock: 0, toBlock: latestBlock },
  );
  // A missed window could hide an earlier mint, and a later one is not the
  // start: the read failed, which is not "no mint" (MEME, rate-limited).
  if (truncated) {
    throw new IncompleteDataError(
      'robinhood-rpc',
      'some windows of the token’s history could not be read, so its first mint could not be read',
    );
  }
  return logs[0];
}

/** Traces a token back to the transaction of its first mint. */
export async function traceTokenOrigin(
  rpc: RpcClient,
  token: Address,
  mint: RawLog,
): Promise<TokenOrigin | undefined> {
  const [transaction, receipt] = await rpc.callBatch<ChainTransaction | ChainReceipt | null>([
    { method: 'eth_getTransactionByHash', params: [mint.transactionHash] },
    { method: 'eth_getTransactionReceipt', params: [mint.transactionHash] },
  ]);
  if (!transaction?.ok || !receipt?.ok || !transaction.value || !receipt.value) return undefined;
  const tx = transaction.value as ChainTransaction;
  const rc = receipt.value as ChainReceipt;
  // Whether the creator a launch event names is a contract: one more read,
  // only when there is such an event.
  const sender = creatorOf(tx, rc, Number(mint.logIndex));
  const named = findLaunchRecord(token, rc.logs, sender)?.creator;
  let isContract = false;
  if (named && named !== sender) {
    // Not read is not "a wallet": the trace fails, and the creator is said unread.
    const code = await rpc.call<string>('eth_getCode', [named, 'latest']);
    isContract = isContractCode(code);
  }
  return readOrigin(token, mint, tx, rc, isContract);
}

export { isContractCode } from './code';

type Launch = { token: string; blockNumber: number; transactionHash: string };

/** "Nothing seen" over a window that could not be read is not "nothing happened". */
function unseenAsUnknown(result: Map<string, boolean>, truncated: boolean): Map<string, boolean> {
  if (!truncated) return result;
  return new Map([...result].filter(([, seen]) => seen));
}

/** True when a V2 or V3 `Burn` moved something: `burn(0)` only collects fees. */
export function burnMovedLiquidity(log: RawLog): boolean {
  return [0, 1].some((i) => {
    const value = word(log.data, i);
    return value.length === 64 && BigInt(`0x${value}`) > 0n;
  });
}

/** True when a v4 `ModifyLiquidity` removed liquidity: a negative delta. */
export function modifyRemovedLiquidity(log: RawLog): boolean {
  const delta = word(log.data, 2);
  return delta.length === 64 && Number.parseInt(delta[0] ?? '0', 16) >= 8;
}

/**
 * Removal transactions checked for their sender; beyond, the answer is
 * unknown. Fee collections have their own, smaller allowance: a busy v4
 * market logs one zero-delta `ModifyLiquidity` per fee collection (BOOMER,
 * 18/10/2026: 998 collections, 10 additions, 1 removal in its first day),
 * and when they shared one allowance the removals were never reached, so
 * who removed the liquidity was reported unread on every run. WORM, the
 * same day: 1,889 removal logs over its eleven markets, in 266 transactions.
 */
export const MAX_REMOVALS_CHECKED = 400;
export const MAX_COLLECTIONS_CHECKED = 60;
/** Transaction lookups sent at once: a batch that fails loses only its own. */
const SENDER_BATCH = 20;
/** Batches in flight together: more and the public node answers 429. */
const SENDER_BATCHES_AT_ONCE = 3;
/** No new batch of senders is sent after this long: the rest is left unknown, and said. */
export const SENDERS_WITHIN_MS = 10_000;

/** True when a v4 `ModifyLiquidity` changed no liquidity: a position's fees being collected. */
export function modifyCollectedFees(log: RawLog): boolean {
  const delta = word(log.data, 2);
  return delta.length === 64 && /^0+$/.test(delta);
}

/**
 * Which tokens had liquidity removed by the creator: each removal's
 * transaction is read for its sender. A token whose removals could not all be
 * read, and none of the read ones was the creator's, is left out: unknown.
 * The same reading for `collections`, the fee collections on a v4 market.
 */
export async function creatorRemovals(
  rpc: RpcClient,
  creator: string,
  targets: ReadonlySet<string>,
  removals: readonly { token: string; log: RawLog }[],
  collections: readonly { token: string; log: RawLog }[] = [],
  /** The analysed token: its removals are read first. */
  first?: string,
  clock: () => number = Date.now,
  /** No new batch after this time (epoch ms), whatever is left. */
  by: number = Number.POSITIVE_INFINITY,
): Promise<{
  pulled: Map<string, boolean>;
  collected: Map<string, boolean>;
  /** Who sent each removal or collection read; `null` when its transaction was not read. */
  sender: Map<string, string | null>;
}> {
  const pulled = new Map([...targets].map((t) => [t, false]));
  const collected = new Map([...targets].map((t) => [t, false]));
  if (removals.length === 0 && collections.length === 0) {
    return { pulled, collected, sender: new Map() };
  }
  // The analysed token's first, then the most recent first: a pull ends a
  // market's life, it rarely starts it. Removals before fee collections, each
  // with its own allowance, so a market busy with collections still has its
  // removals read.
  const ordered = (events: readonly { token: string; log: RawLog }[], cap: number) =>
    [
      ...new Set(
        [...events]
          .sort(
            (a, b) =>
              Number(b.token === first) - Number(a.token === first) ||
              Number(b.log.blockNumber) - Number(a.log.blockNumber),
          )
          .map((r) => r.log.transactionHash),
      ),
    ].slice(0, cap);
  const read = [
    ...new Set([
      ...ordered(removals, MAX_REMOVALS_CHECKED),
      ...ordered(collections, MAX_COLLECTIONS_CHECKED),
    ]),
  ];
  const chunks: string[][] = [];
  for (let i = 0; i < read.length; i += SENDER_BATCH) chunks.push(read.slice(i, i + SENDER_BATCH));
  const outcomes: (BatchOutcome<{ from?: string } | null> | undefined)[] = [];
  const until = Math.min(clock() + SENDERS_WITHIN_MS, by);
  for (let i = 0; i < chunks.length && clock() < until; i += SENDER_BATCHES_AT_ONCE) {
    const wave = await Promise.all(
      chunks
        .slice(i, i + SENDER_BATCHES_AT_ONCE)
        .map((chunk) =>
          rpc
            .callBatch<{ from?: string } | null>(
              chunk.map((hash) => ({ method: 'eth_getTransactionByHash', params: [hash] })),
            )
            .catch(() => chunk.map(() => undefined)),
        ),
    );
    outcomes.push(...wave.flat());
  }
  const sender = new Map<string, string | null>(
    read.map((hash, i) => {
      const outcome = outcomes[i];
      return [hash, outcome?.ok && outcome.value?.from ? lower(outcome.value.from) : null];
    }),
  );
  const settle = (events: readonly { token: string; log: RawLog }[], out: Map<string, boolean>) => {
    const unread = new Set<string>();
    for (const { token, log } of events) {
      const from = sender.get(log.transactionHash);
      if (from === lower(creator)) out.set(token, true);
      else if (from === undefined || from === null) unread.add(token);
    }
    for (const token of unread) if (out.get(token) === false) out.delete(token);
  };
  settle(removals, pulled);
  settle(collections, collected);
  return { pulled, collected, sender };
}

/** Removals of the analysed token detailed (receipt, recipients, their balances), at most. */
export const MAX_REMOVALS_DETAILED = 3;
/** Recipients of one removal whose balance today is read, at most. */
const MAX_RETURNED_READ = 5;
const TOTAL_SUPPLY_CALL = '0x18160ddd';
const BALANCE_OF_CALL = '0x70a08231';
const TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Who got the token back from its markets in one transaction: each address's
 * net receipt of the token (what it received less what it passed on), for
 * the addresses that are not markets nor burn, as raw amounts.
 */
export function returnedFrom(
  logs: readonly RawLog[],
  token: string,
  markets: ReadonlySet<string>,
): Map<string, bigint> {
  const own = lower(token);
  const net = new Map<string, bigint>();
  let fromMarket = false;
  for (const log of logs) {
    if (lower(log.address) !== own || log.topics.length !== 3) continue;
    if (lower(log.topics[0] ?? '') !== TRANSFER_SIGNATURE) continue;
    const raw = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
    if (raw.length < 64) continue;
    const value = BigInt(`0x${raw.slice(0, 64)}`);
    const from = fromTopic(log.topics[1]);
    const to = fromTopic(log.topics[2]);
    if (markets.has(from)) fromMarket = true;
    net.set(from, (net.get(from) ?? 0n) - value);
    net.set(to, (net.get(to) ?? 0n) + value);
  }
  if (!fromMarket) return new Map();
  // The token's own contract keeping some of a transfer is a fee it takes,
  // not where the liquidity went (moon: "to the token's own address").
  return new Map(
    [...net].filter(([a, v]) => v > 0n && a !== own && !markets.has(a) && !BURN_ADDRESSES.has(a)),
  );
}

/**
 * The analysed token's liquidity removals, the most recent first: who sent
 * each, and to whom the market returned the token. `failed` when a part of
 * it could not be read: who removed it is then unknown, never "nobody".
 */
export async function detailRemovals(
  rpc: RpcClient,
  token: string,
  creator: string,
  events: readonly { log: RawLog }[],
  sender: ReadonlyMap<string, string | null>,
  markets: ReadonlySet<string>,
): Promise<{ removals: LiquidityRemoval[]; failed: boolean }> {
  const latestFirst = [...events].sort(
    (a, b) => Number(b.log.blockNumber) - Number(a.log.blockNumber),
  );
  const hashes = [...new Set(latestFirst.map((e) => e.log.transactionHash))].slice(
    0,
    MAX_REMOVALS_DETAILED,
  );
  if (hashes.length === 0) return { removals: [], failed: false };
  let failed = false;
  const outcomes = await rpc
    .callBatch<{ logs: RawLog[] } | string | null>([
      ...hashes.map((hash) => ({ method: 'eth_getTransactionReceipt', params: [hash] })),
      { method: 'eth_call', params: [{ to: token, data: TOTAL_SUPPLY_CALL }, 'latest'] },
    ])
    .catch(() => {
      failed = true;
      return [];
    });
  const supplyOutcome = outcomes[hashes.length];
  const supply =
    supplyOutcome?.ok && typeof supplyOutcome.value === 'string' && supplyOutcome.value !== '0x'
      ? BigInt(supplyOutcome.value)
      : 0n;
  if (supply <= 0n) return { removals: [], failed: true };
  const share = (v: bigint) => Number((v * 1_000_000n) / supply) / 1_000_000;
  const own = lower(creator);
  const read: { hash: string; block: number; from: string; got: Map<string, bigint> }[] = [];
  hashes.forEach((hash, i) => {
    const receipt = outcomes[i];
    const from = sender.get(hash) ?? null;
    const logs =
      receipt?.ok && receipt.value && typeof receipt.value === 'object' ? receipt.value.logs : null;
    if (!logs || !from) {
      failed = true;
      return;
    }
    const block = Number(
      latestFirst.find((e) => e.log.transactionHash === hash)?.log.blockNumber ?? 0,
    );
    read.push({ hash, block, from, got: returnedFrom(logs, token, markets) });
  });
  // What the recipients hold today, in one batch.
  const holders = [...new Set(read.flatMap((r) => [...r.got.keys()].slice(0, MAX_RETURNED_READ)))];
  const balances =
    holders.length > 0
      ? await rpc
          .callBatch<string>(
            holders.map((a) => ({
              method: 'eth_call',
              params: [
                { to: token, data: `${BALANCE_OF_CALL}${a.slice(2).padStart(64, '0')}` },
                'latest',
              ],
            })),
          )
          .catch(() => {
            failed = true;
            return [];
          })
      : [];
  const heldNow = new Map(
    holders.map((a, i) => {
      const b = balances[i];
      if (!(b?.ok && typeof b.value === 'string' && /^0x[0-9a-f]*$/i.test(b.value))) failed = true;
      return [
        a,
        b?.ok && typeof b.value === 'string' && b.value !== '0x' ? share(BigInt(b.value)) : null,
      ] as const;
    }),
  );
  return {
    removals: read.map((r) => ({
      transaction: r.hash,
      block: r.block,
      sender: r.from,
      by: r.from === own ? 'creator' : 'other',
      returned: [...r.got]
        .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
        .slice(0, MAX_RETURNED_READ)
        .map(([address, value]) => ({
          address,
          share: share(value),
          isCreator: address === own,
          heldNow: heldNow.get(address) ?? null,
        })),
    })),
    failed,
  };
}

type WindowQuery = {
  address: string;
  fromBlock: number;
  toBlock: number;
  topics: (string | null)[];
};

/**
 * Queries that each fit one window, sent in one batch. A query the busy node
 * turned down is asked once more. One with too many results is split in two
 * halves of its block range, and each half asked again, up to a number of
 * rounds and of queries: a busy market's log is read whole rather than given
 * up. Any refusal left marks the result truncated.
 */
export const MAX_WINDOW_ROUNDS = 6;
/** Queries the halving may add to those asked, at most: past it, the rest is truncated. */
export const MAX_WINDOW_SPLITS = 32;
/** Below this many blocks, a window is not split further. */
const MIN_SPLIT_SPAN = 1_000;

export async function readWindows(
  rpc: RpcClient,
  queries: readonly WindowQuery[],
): Promise<{ logs: RawLog[]; truncated: boolean }> {
  if (queries.length === 0) return { logs: [], truncated: false };
  const hex = (n: number) => `0x${n.toString(16)}`;
  const send = (list: readonly WindowQuery[]) =>
    rpc.callBatch<RawLog[]>(
      list.map((q) => ({
        method: 'eth_getLogs',
        params: [
          {
            address: q.address,
            topics: q.topics,
            fromBlock: hex(q.fromBlock),
            toBlock: hex(q.toBlock),
          },
        ],
      })),
    );
  try {
    const logs: RawLog[] = [];
    let pending = queries.map((q) => ({ ...q, retried: false }));
    let sent = 0;
    let given = false;
    const allowance = queries.length * 2 + MAX_WINDOW_SPLITS;
    for (let round = 0; round < MAX_WINDOW_ROUNDS && pending.length > 0; round += 1) {
      if (sent + pending.length > allowance) {
        given = true;
        break;
      }
      sent += pending.length;
      const outcomes = await send(pending);
      const again: typeof pending = [];
      pending.forEach((query, i) => {
        const outcome = outcomes[i];
        if (outcome?.ok && Array.isArray(outcome.value)) {
          logs.push(...outcome.value);
          return;
        }
        if (!outcome?.ok && classifyLogError(outcome?.error ?? '')) {
          // Too many results will not shrink by asking again: halve the range.
          if (query.toBlock - query.fromBlock + 1 <= MIN_SPLIT_SPAN) {
            given = true;
            return;
          }
          const mid = Math.floor((query.fromBlock + query.toBlock) / 2);
          again.push({ ...query, toBlock: mid }, { ...query, fromBlock: mid + 1 });
        } else if (!query.retried) again.push({ ...query, retried: true });
        else given = true;
      });
      pending = again;
    }
    logs.sort(
      (a, b) =>
        Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex),
    );
    return { logs, truncated: given || pending.length > 0 };
  } catch {
    return { logs: [], truncated: true };
  }
}

/** A launch found for a creator, and the launchpad that recorded it. */
export type ListedLaunch = Launch & { launchpad?: Launchpad };

export type CreatorListing = {
  launches: ListedLaunch[];
  truncated: boolean;
  /** Launchpads whose launches by this creator were read (names, once each). */
  read: string[];
  /** Launchpads whose launch event does not index the creator: not readable from the node. */
  unread: string[];
};

const names = (list: readonly Launchpad[]) => [...new Set(list.map((l) => l.name))];

/**
 * Log queries a creator listing may send to the public node, which paces them
 * at about four a second: the whole analysis has 30 s. A launchpad is read
 * whole or not at all — the 0x7ed5 factory and its router need 14, the five
 * pons factories 22, so on the
 * public node pons is left to the indexer, and the report says it was not
 * listed. A node named by `LOGS_RPC_URL` is not held to it.
 */
export const PUBLIC_LISTING_QUERIES = 18;

export function listingQueryBudget(env: Record<string, string | undefined> = process.env): number {
  return logsRpcUrl(env) === DEFAULT_RPC_URL ? PUBLIC_LISTING_QUERIES : Number.POSITIVE_INFINITY;
}

/** One 10 M-block window per query, over the launchpad's own range. */
function windowsOf(launchpad: Launchpad, latest: number): { fromBlock: number; toBlock: number }[] {
  const out: { fromBlock: number; toBlock: number }[] = [];
  const until = Math.min(latest, launchpad.toBlock ?? latest);
  for (let to = until; to >= launchpad.fromBlock; to -= SINGLE_ADDRESS_SPAN) {
    out.push({
      fromBlock: Math.max(launchpad.fromBlock, to - SINGLE_ADDRESS_SPAN + 1),
      toBlock: to,
    });
  }
  return out;
}

/**
 * A creator's launches on every known launchpad whose event indexes the
 * creator: one query per contract and per 10 M-block window, all in one
 * batch. A launchpad that records the creator in its data (flap.sh) cannot be
 * filtered by the node: the indexer lists those. Under a query budget, the
 * token's own launchpad comes first, then the open ones, the newest first.
 */
export async function listCreatorLaunches(
  rpc: RpcClient,
  creator: string,
  latest: number,
  options: {
    skip?: (launchpad: Launchpad) => boolean;
    /** Read first: the token's own launchpad. */
    first?: string;
    maxQueries?: number;
  } = {},
): Promise<CreatorListing> {
  const wanted = LAUNCHPADS.filter((l) => !options.skip?.(l));
  const filterable = wanted.filter((l) => creatorFilter(l, creator) !== null);
  // Grouped by launchpad: pons is five contracts, read together or not at all.
  const groups = [...new Set(filterable.map((l) => l.id))].map((id) => {
    const contracts = filterable.filter((l) => l.id === id);
    return {
      id,
      contracts,
      cost: contracts.reduce((n, l) => n + windowsOf(l, latest).length, 0),
      open: contracts.some((l) => l.toBlock === undefined),
      newest: Math.max(...contracts.map((l) => l.toBlock ?? l.fromBlock)),
    };
  });
  groups.sort(
    (a, b) =>
      Number(b.id === options.first) - Number(a.id === options.first) ||
      Number(b.open) - Number(a.open) ||
      b.newest - a.newest,
  );
  let room = options.maxQueries ?? listingQueryBudget();
  const listable: Launchpad[] = [];
  for (const group of groups) {
    if (group.cost > room) continue;
    room -= group.cost;
    listable.push(...group.contracts);
  }
  const queries: WindowQuery[] = listable.flatMap((launchpad) =>
    windowsOf(launchpad, latest).map((w) => ({
      address: launchpad.address,
      ...w,
      topics: creatorFilter(launchpad, creator) as (string | null)[],
    })),
  );
  const { logs, truncated } = await readWindows(rpc, queries);
  const launches: ListedLaunch[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    for (const launchpad of listable) {
      const record = readLaunchRecord(launchpad, log);
      if (!record || record.creator !== lower(creator) || seen.has(record.token)) continue;
      seen.add(record.token);
      launches.push({
        token: record.token,
        blockNumber: record.blockNumber,
        transactionHash: record.transactionHash,
        launchpad,
      });
    }
  }
  launches.sort((a, b) => a.blockNumber - b.blockNumber);
  const read = names(listable);
  return {
    launches,
    truncated,
    read,
    unread: names(wanted).filter((n) => !read.includes(n)),
  };
}

/** What the node cannot list, whatever the launchpad: contracts an address deployed itself. */
export const DIRECT_DEPLOYS = 'contracts deployed directly';

/**
 * A creator's launches as the indexer lists them, for the launchpads it has
 * read up to the head (`covered`, by id): the node is not asked for those.
 */
export type IndexedListing = { launches: ListedLaunch[]; covered: ReadonlySet<string> };

/** Joins what the node listed and what the indexer listed, the coverage of both said once. */
export function mergeListings(
  listing: CreatorListing,
  indexed: IndexedListing | undefined,
): CreatorListing {
  if (!indexed) return listing;
  const coveredNames = names(LAUNCHPADS.filter((l) => indexed.covered.has(l.id)));
  const seen = new Set(listing.launches.map((l) => l.token));
  const launches = [
    ...listing.launches,
    ...indexed.launches.filter((l) => !seen.has(l.token) && seen.add(l.token)),
  ].sort((a, b) => a.blockNumber - b.blockNumber);
  return {
    launches,
    truncated: listing.truncated,
    read: [...new Set([...listing.read, ...coveredNames])],
    unread: listing.unread.filter((n) => !coveredNames.includes(n)),
  };
}

export type DeployerHistoryOptions = {
  latestBlock: number;
  indexed?: IndexedListing;
  /** Log queries the listing may send; defaults to what the logs node allows. */
  maxListingQueries?: number;
  /** Markets the token trades on that its launch transaction did not create (DexScreener pairs, v4 markets). */
  venues?: { pools?: readonly string[]; v4Markets?: readonly string[] };
  now?: () => Date;
  /**
   * When the listing is done after this time (epoch ms), only the analysed
   * token's sales and liquidity are checked: the other launches' would not
   * fit in the request (AI: 80 launches, its first request cut at 30 s).
   */
  checkOthersBy?: number;
  /** The clock `checkOthersBy` is read on. For tests. */
  clock?: () => number;
  /**
   * No removal's sender is asked after this time (epoch ms): the history
   * must end before its deadline, and a sender not read leaves "did the
   * creator remove liquidity" unknown, said so.
   */
  sendersBy?: number;
};

/**
 * The creator's launches on every known launchpad (and through the same
 * launch contract, for one that is not known), and for the most recent ones,
 * whether the creator sold into the market and whether liquidity was removed
 * — read over each launch's first ~11 days, like pons launches.
 */
export async function fetchDeployerHistory(
  rpc: RpcClient,
  origin: TokenOrigin,
  options: DeployerHistoryOptions,
): Promise<CreatorHistory> {
  const now = options.now ?? (() => new Date());
  const fetchedAt = now().toISOString();
  const latest = options.latestBlock;
  const creator = origin.creator;
  const registry = origin.registry;

  const registryTopics: (string | null)[] = registry
    ? Array.from({ length: registry.creatorIndex + 1 }, (_, i) =>
        i === 0 ? registry.topic0 : i === registry.creatorIndex ? topicFor(creator) : null,
      )
    : [];

  // Each checked launch's markets come from its own launch transaction. The
  // analysed token also trades where its launch did not put it: the pairs and
  // markets found since.
  const extra = options.venues;
  const own: TradingVenues = extra
    ? (() => {
        const pools = [...new Set([...origin.venues.pools, ...(extra.pools ?? []).map(lower)])];
        const v4Markets = [
          ...new Set([...origin.venues.v4Markets, ...(extra.v4Markets ?? []).map(lower)]),
        ];
        return {
          ...origin.venues,
          pools,
          v4Markets,
          saleRecipients: [
            ...new Set([
              ...origin.venues.saleRecipients,
              ...pools,
              ...(v4Markets.length > 0 ? [lower(POOL_MANAGER)] : []),
            ]),
          ],
        };
      })()
    : origin.venues;
  // The analysed token's own sales are read over its whole life, up to a
  // cap; the other launches' over their first ~11 days. One token is one
  // address: a busy one is split rather than given up. Its markets are known
  // before the listing, so its sales are read alongside it (AI: 80 launches
  // listed, then this token's 96 days read after them, past the route's 30 s).
  const ownWindow = {
    fromBlock: origin.blockNumber,
    toBlock: Math.min(latest, origin.blockNumber + OWN_SALES_MAX_BLOCKS - 1),
  };
  const none = { logs: [] as RawLog[], truncated: false };
  const ownSalesRead: Promise<{ logs: RawLog[]; truncated: boolean }> =
    own.saleRecipients.length > 0
      ? getLogsBatched(
          rpc,
          {
            addresses: [{ address: origin.token, ...ownWindow }],
            topics: [TRANSFER_TOPIC, topicFor(creator)],
          },
          { fromBlock: 0, toBlock: latest },
        ).catch(() => ({ logs: [], truncated: true }))
      : Promise.resolve(none);

  const covered = options.indexed?.covered ?? new Set<string>();
  const [nodeListing, listed, account] = await Promise.all([
    listCreatorLaunches(rpc, creator, latest, {
      skip: (l) => covered.has(l.id),
      ...(origin.launchpad ? { first: origin.launchpad.id } : {}),
      ...(options.maxListingQueries !== undefined ? { maxQueries: options.maxListingQueries } : {}),
    }).catch((): CreatorListing => ({ launches: [], truncated: true, read: [], unread: [] })),
    registry
      ? getLogsBatched(
          rpc,
          { addresses: [registry.address], topics: registryTopics },
          { fromBlock: 0, toBlock: latest },
          // A launch service with tens of thousands of launches is not one
          // person's history: give up on the list rather than spend seconds.
          { split: false },
        )
      : Promise.resolve(undefined),
    rpc.callBatch<string>([
      { method: 'eth_getCode', params: [creator, 'latest'] },
      { method: 'eth_getTransactionCount', params: [creator, 'latest'] },
    ]),
  ]);

  // A wallet delegating under EIP-7702 has code, and still a transaction count.
  const isWallet = account[0]?.ok ? !isContractCode(account[0].value) : null;
  const transactionCount = isWallet && account[1]?.ok ? Number(account[1].value) : null;
  const listing = mergeListings(nodeListing, options.indexed);

  const seen = new Set<string>();
  const all: ListedLaunch[] = [];
  for (const launch of listing.launches) {
    if (seen.has(launch.token)) continue;
    seen.add(launch.token);
    all.push(launch);
  }
  for (const log of listed?.logs ?? []) {
    const token = registry ? fromTopic(log.topics[registry.tokenIndex]) : '';
    if (!token || seen.has(token)) continue;
    seen.add(token);
    all.push({
      token,
      blockNumber: Number(log.blockNumber),
      transactionHash: log.transactionHash,
    });
  }
  // The analysed token is a launch of this address whatever the list says.
  if (!seen.has(origin.token)) {
    all.push({
      token: origin.token,
      blockNumber: origin.blockNumber,
      transactionHash: origin.transactionHash,
    });
  }
  all.sort((a, b) => a.blockNumber - b.blockNumber);

  // The list covers this token's own launchpad only when its event indexes
  // the creator and named this very address; else other launches there are missed.
  const ownLaunchpad = LAUNCHPADS.find((l) => l.address === origin.launchpad?.address);
  const ownListable = ownLaunchpad
    ? origin.creatorFrom === 'launch-record' &&
      (creatorFilter(ownLaunchpad, creator) !== null || covered.has(ownLaunchpad.id))
    : Boolean(registry);
  const truncated = listing.truncated || Boolean(listed?.truncated);
  const launchesListed = ownListable && !truncated;
  // A launch contract with too many launches to list is a limit, not a read
  // that failed: retrying will not list them either.
  const registryTooBroad = !listing.truncated && Boolean(listed?.truncated && listed.tooBroad);

  const detailed = all.slice(-MAX_DETAILED_DEPLOYER_LAUNCHES);
  if (!detailed.some((l) => l.token === origin.token)) {
    const own = all.find((l) => l.token === origin.token);
    if (own) detailed.unshift(own);
  }
  // A listing that took too long leaves no time for the other launches'
  // checks: they are left unchecked, and said so, rather than lose the request.
  const late =
    options.checkOthersBy !== undefined && (options.clock ?? Date.now)() > options.checkOthersBy;
  const checked = detailed.filter(
    (l, i) =>
      l.token === origin.token || (!late && i >= detailed.length - MAX_CHECKED_DEPLOYER_LAUNCHES),
  );
  const othersUnchecked = late && detailed.some((l) => l.token !== origin.token);

  const heuristic = origin.launchpad ? undefined : origin.launchContract;
  const others = checked.filter((l) => l.token !== origin.token);
  const receipts = await rpc.callBatch<ChainReceipt | null>(
    others.map((l) => ({ method: 'eth_getTransactionReceipt', params: [l.transactionHash] })),
  );
  const venues = new Map<string, TradingVenues>([[origin.token, own]]);
  others.forEach((l, i) => {
    const receipt = receipts[i];
    if (receipt?.ok && receipt.value) {
      const logs = receipt.value.logs;
      venues.set(
        l.token,
        withRecordVenues(
          findVenues(l.token, logs, l.launchpad ? undefined : heuristic),
          findLaunchRecord(l.token, logs),
        ),
      );
    }
  });

  const windowOf = (l: Launch) => ({
    fromBlock: l.blockNumber,
    toBlock: Math.min(latest, l.blockNumber + DEPLOYER_BEHAVIOR_WINDOW - 1),
  });

  // Sales: transfers from the creator, then kept when they went into a market.
  const salesTargets = checked.filter((l) => (venues.get(l.token)?.saleRecipients.length ?? 0) > 0);
  const poolSources: { address: string; fromBlock: number; toBlock: number }[] = [];
  const tokenOfPool = new Map<string, string>();
  for (const l of checked) {
    for (const pool of venues.get(l.token)?.pools ?? []) {
      poolSources.push({ address: pool, ...windowOf(l) });
      tokenOfPool.set(pool, l.token);
    }
  }
  const marketTargets = checked.filter((l) => (venues.get(l.token)?.v4Markets.length ?? 0) > 0);
  const tokenOfMarket = new Map<string, string>();
  for (const l of marketTargets) {
    for (const id of venues.get(l.token)?.v4Markets ?? []) tokenOfMarket.set(id, l.token);
  }

  const ownTarget = salesTargets.find((l) => l.token === origin.token);
  const otherTargets = salesTargets.filter((l) => l.token !== origin.token);
  const [ownSales, otherSales, liquidityLogs, timestamps] = await Promise.all([
    ownSalesRead,
    otherTargets.length
      ? getLogsBatched(
          rpc,
          {
            addresses: otherTargets.map((l) => ({ address: l.token, ...windowOf(l) })),
            topics: [TRANSFER_TOPIC, topicFor(creator)],
          },
          { fromBlock: 0, toBlock: latest },
          { split: false },
        ).catch(() => ({ logs: [], truncated: true }))
      : Promise.resolve(none),
    // One query per market and per event: this node caps a filter that lists
    // several values in one position at 100,000 blocks, and each window here
    // is 10 M. Every query fits one window, so they all go in one batch.
    readWindows(rpc, [
      ...poolSources.flatMap((source) =>
        [BURN_TOPIC, V2_BURN_TOPIC].map((topic) => ({ ...source, topics: [topic] })),
      ),
      ...marketTargets.flatMap((l) =>
        (venues.get(l.token)?.v4Markets ?? []).map((id) => ({
          address: POOL_MANAGER as string,
          ...windowOf(l),
          topics: [MODIFY_LIQUIDITY_TOPIC, id],
        })),
      ),
    ]),
    fetchBlockTimestamps(
      rpc,
      detailed.map((l) => l.blockNumber),
    ).catch(() => detailed.map(() => null)),
  ]);

  // A transfer into a pool or a known curve is a sale only when it traded in
  // that transaction: a pool's `Swap`, or the curve's own trade event. Without
  // one, it is the creator providing liquidity, not selling. An unknown launch
  // contract keeps the older reading: a transfer into it is a sale on its curve.
  const sold = new Map(salesTargets.map((l) => [l.token, false]));
  const intoMarket: { token: string; hash: string }[] = [];
  // Transfers to anything else may still be a sale, routed through a router.
  const elsewhere: { token: string; to: string; hash: string }[] = [];
  // The analysed token's transfers first: its receipts are read before the others'.
  for (const log of [...ownSales.logs, ...otherSales.logs]) {
    const token = lower(log.address);
    const to = fromTopic(log.topics[2]);
    const venue = venues.get(token);
    if (!venue) continue;
    if (!venue.saleRecipients.includes(to)) {
      if (!BURN_ADDRESSES.has(to)) elsewhere.push({ token, to, hash: log.transactionHash });
      continue;
    }
    if (heuristic && to === lower(heuristic) && !venue.curves?.includes(to)) sold.set(token, true);
    else intoMarket.push({ token, hash: log.transactionHash });
  }
  const curves = [...venues.values()].flatMap((v) => v.curves ?? []);
  const curveTrades = [...venues.values()].flatMap((v) => v.curveTrades ?? []);
  const marketAddresses = new Set([...tokenOfPool.keys(), lower(POOL_MANAGER), ...curves]);
  const tradeTopics = new Set([...SWAP_TOPICS, ...curveTrades]);
  const marketsOf = (token: string): ReadonlySet<string> => {
    const v = venues.get(token);
    return new Set([...(v?.saleRecipients ?? []), ...(v?.pools ?? []), ...(v?.curves ?? [])]);
  };
  const passing = { through: new Set<string>(), unread: new Set<string>() };
  const [natures, routed] = await Promise.all([
    readTxNatures(
      rpc,
      intoMarket.map((t) => t.hash),
      marketAddresses,
      tradeTopics,
    ).catch(() => new Map<string, never>()),
    // Only where no direct sale settles it: the analysed token first.
    findRoutedSales(rpc, creator, elsewhere, marketsOf, tradeTopics, origin.token, passing),
  ]);
  for (const token of routed) if (sold.has(token)) sold.set(token, true);
  // A transfer whose receipt was asked and not read could have been a sale.
  const unread = new Set<string>(passing.unread);
  for (const { token, hash } of intoMarket) {
    const nature = natures.get(hash);
    if (nature === 'swap') sold.set(token, true);
    else if (nature === undefined) unread.add(token);
  }
  // A transaction whose receipt was not read could have been a sale.
  for (const token of unread) if (!sold.get(token)) sold.delete(token);
  // A window not read leaves "no sale" unknown, for the tokens it covered only.
  const soldKnown = new Map(
    [...sold].filter(
      ([token, seen]) =>
        seen || !(token === origin.token ? ownSales.truncated : otherSales.truncated),
    ),
  );
  // Whom the creator sent the analysed token to, outside its markets: an
  // airdrop to thousands is why a token has thousands of holders.
  const ownMarkets = new Set([
    ...own.saleRecipients,
    ...own.pools,
    ...(own.curves ?? []),
    lower(POOL_MANAGER),
  ]);
  // A router the token went through on its way to a market is not a recipient.
  const ownSent = ownSales.logs.filter((l) => !passing.through.has(l.transactionHash));
  const creatorRecipients =
    ownTarget && !ownSales.truncated
      ? distinctRecipients(ownSent, origin.token, creator, ownMarkets)
      : null;
  const creatorSends =
    ownTarget && !ownSales.truncated
      ? creatorSendsOf(ownSent, origin.token, creator, ownMarkets)
      : null;

  const liquidityTargets = new Set([...tokenOfPool.values(), ...tokenOfMarket.values()]);
  // Removals of any liquidity on the token's markets, by anyone.
  const removals: { token: string; log: RawLog }[] = [];
  // A v4 position's fees, taken out without touching its liquidity: tokens
  // the market paid back to whoever owns the position (AML, +387 s: the
  // creator called Doppler's hook, two ModifyLiquidity of zero, and the token
  // came back to the creator).
  const collections: { token: string; log: RawLog }[] = [];
  for (const log of liquidityLogs.logs) {
    if (log.topics[0] === MODIFY_LIQUIDITY_TOPIC) {
      const token = tokenOfMarket.get(lower(log.topics[1] ?? ''));
      if (!token) continue;
      const removed = modifyRemovedLiquidity(log);
      if (!removed && !modifyCollectedFees(log)) continue;
      // Outside its own window, a removal is not the one being asked about.
      const launch = checked.find((l) => l.token === token);
      if (launch && Number(log.blockNumber) <= windowOf(launch).toBlock) {
        (removed ? removals : collections).push({ token, log });
      }
    } else {
      const token = tokenOfPool.get(lower(log.address));
      if (token && burnMovedLiquidity(log)) removals.push({ token, log });
    }
  }
  // Anyone can add liquidity to a market and take it back: only a removal the
  // creator signed is theirs. Verified live, where a third party rebalancing
  // its own range made SEAL report the creator's liquidity as pulled.
  const { pulled, collected, sender } = await creatorRemovals(
    rpc,
    creator,
    liquidityTargets,
    removals,
    collections,
    origin.token,
    options.clock ?? Date.now,
    options.sendersBy,
  );
  // Who removed the analysed token's liquidity, and to whom it went: said,
  // whoever sent it (MOON: the creator, 48.07 % of the supply back to it).
  const ownRemovals = await detailRemovals(
    rpc,
    origin.token,
    creator,
    removals.filter((r) => r.token === origin.token),
    sender,
    ownMarkets,
  );
  const pulledKnown = unseenAsUnknown(pulled, liquidityLogs.truncated);
  const collectedKnown = unseenAsUnknown(collected, liquidityLogs.truncated);

  const checkedTokens = new Set(checked.map((l) => l.token));
  const tokens: LaunchedToken[] = detailed.map((l, i) => {
    const venue = venues.get(l.token);
    return {
      address: l.token,
      pool:
        venue?.pools[0] ??
        (venue?.v4Markets.length ? lower(POOL_MANAGER) : (venue?.curves?.[0] ?? '0x')),
      launchedAtBlock: l.blockNumber,
      launchedAt: timestamps[i] ?? null,
      // Graduation is read on pons only: whether a launch "made it" is not
      // something this history can say.
      outcome: 'undetermined',
      graduationProgress: 0,
      liquidityPulled: checkedTokens.has(l.token) ? (pulledKnown.get(l.token) ?? null) : null,
      creatorDumped: checkedTokens.has(l.token) ? (soldKnown.get(l.token) ?? null) : null,
      ...(tokenOfMarket.size > 0 && [...tokenOfMarket.values()].includes(l.token)
        ? { feesCollected: collectedKnown.get(l.token) ?? null }
        : {}),
      ...(l.launchpad ? { launchpad: l.launchpad.name } : {}),
      ...(checkedTokens.has(l.token)
        ? {
            salesWindow: salesWindowOf(
              l.token === origin.token ? ownWindow : windowOf(l),
              latest,
              timestamps[i] ?? null,
              now,
            ),
          }
        : {}),
      ...(l.token === origin.token ? { creatorRecipients, creatorSends } : {}),
      ...(l.token === origin.token && ownRemovals.removals.length > 0
        ? { liquidityRemovals: ownRemovals.removals }
        : {}),
    };
  });

  const counts = {
    launched: all.length,
    graduated: 0,
    abandoned: 0,
    undetermined: tokens.length,
    liquidityPulled: tokens.filter((t) => t.liquidityPulled === true).length,
    creatorDumped: tokens.filter((t) => t.creatorDumped === true).length,
  };

  const read = [...listing.read, ...(registry ? ['its launch contract'] : [])];
  const notRead = [...listing.unread, DIRECT_DEPLOYS];
  const capped = all.length > detailed.length;
  const traced = origin.launchpad
    ? `creator read from its ${origin.launchpad.name} launch${origin.creatorFrom === 'launch-record' ? ' record' : ' transaction'}`
    : 'traced from the token’s first mint';
  const note = registryTooBroad
    ? `${traced}; its launch contract records too many launches to list this address’s others`
    : truncated
      ? 'some launch windows could not be read — history may be incomplete'
      : !launchesListed
        ? origin.launchpad
          ? `${traced}; this address’s other launches on ${origin.launchpad.name} cannot be listed from the chain`
          : `${traced}; its other launches outside the known launchpads cannot be listed from the chain`
        : capped
          ? `${traced}; ${detailed.length} most recent of ${all.length} launches read in detail`
          : `${traced}; ${all.length} launch${all.length === 1 ? '' : 'es'} found across the known launchpads`;

  // This token's own sales, when they were looked for and could not be told.
  const ownUnread = Boolean(ownTarget) && !soldKnown.has(origin.token);
  // The other launches' sales or liquidity, asked and not read: unknown, and said.
  const othersUnread =
    !othersUnchecked &&
    ((otherTargets.length > 0 && otherSales.truncated) ||
      (liquidityLogs.truncated && [...liquidityTargets].some((t) => t !== origin.token)));
  // This token's liquidity, asked and not told: its logs not all read, or
  // the senders of its removals not all read, none of them the creator.
  const ownLiquidityUnread = liquidityTargets.has(origin.token) && !pulledKnown.has(origin.token);
  return {
    completeness: 'partial',
    sources: [
      { name: 'robinhood-rpc', fetchedAt, note },
      ...(ownUnread ? [{ name: 'robinhood-rpc' as const, fetchedAt, note: UNREAD.ownSales }] : []),
      ...(othersUnchecked || othersUnread
        ? [{ name: 'robinhood-rpc' as const, fetchedAt, note: UNREAD.otherChecks }]
        : []),
      ...(ownRemovals.failed || (ownLiquidityUnread && liquidityLogs.truncated)
        ? [{ name: 'robinhood-rpc' as const, fetchedAt, note: UNREAD.removals }]
        : ownLiquidityUnread
          ? [{ name: 'robinhood-rpc' as const, fetchedAt, note: UNREAD.removalSenders }]
          : []),
    ],
    data: {
      creator,
      origin: {
        source: 'deployer',
        role: origin.role,
        ...(origin.launchContract ? { launchContract: origin.launchContract } : {}),
        ...(origin.launchpad ? { launchpad: origin.launchpad } : {}),
        ...(origin.creatorFrom ? { creatorFrom: origin.creatorFrom } : {}),
        launchesListed,
        launchpadsRead: read,
        launchpadsNotRead: notRead,
        transactionCount,
      },
      tokens,
      counts,
      scannedRange: { fromBlock: 0, toBlock: latest },
    },
  };
}
