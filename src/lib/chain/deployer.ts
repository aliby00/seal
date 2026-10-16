import type { Address } from 'viem';
import type { CreatorHistory, CreatorOrigin, LaunchedToken } from '../contracts';
import { TRANSFER_TOPIC, topicFor, BURN_TOPIC } from './behavior';
import { fetchBlockTimestamps } from './graduation';
import { getLogsBatched, type RawLog } from './logs';
import { POOL_MANAGER } from './pools';
import type { RpcClient } from './rpc';
import { readTxNatures } from './trades';

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
  /** Addresses a transfer from the creator into counts as a sale. */
  saleRecipients: string[];
};

export type TokenOrigin = {
  token: string;
  creator: string;
  role: CreatorOrigin['role'];
  launchContract?: string;
  blockNumber: number;
  transactionHash: string;
  registry?: CreatorRegistry;
  venues: TradingVenues;
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
    )
      v4Markets.push(lower(log.topics[1]));
  }
  const uniquePools = [...new Set(pools)].slice(0, MAX_VENUES);
  const uniqueMarkets = [...new Set(v4Markets)].slice(0, MAX_VENUES);
  // A launch contract that holds the curve buys and sells itself: a transfer
  // from the creator into it is a sale on that curve.
  const recipients = [
    ...uniquePools,
    ...(uniqueMarkets.length > 0 ? [lower(POOL_MANAGER)] : []),
    ...(launchContract ? [lower(launchContract)] : []),
  ];
  return { pools: uniquePools, v4Markets: uniqueMarkets, saleRecipients: [...new Set(recipients)] };
}

/** Reads one token's origin from the transaction that carried its first mint. */
export function readOrigin(
  token: string,
  mint: RawLog,
  transaction: ChainTransaction,
  receipt: ChainReceipt,
): TokenOrigin {
  const creator = creatorOf(transaction, receipt, Number(mint.logIndex));
  const to = transaction.to ? lower(transaction.to) : null;
  const created = receipt.contractAddress && lower(receipt.contractAddress) === lower(token);
  const role: CreatorOrigin['role'] = created
    ? 'deployer'
    : to === lower(token)
      ? 'first-minter'
      : 'launcher';
  const launchContract = role === 'launcher' && to && !ENTRY_POINTS.includes(to) ? to : undefined;
  const registry = findRegistry(token, creator, receipt.logs);
  return {
    token: lower(token),
    creator,
    role,
    ...(launchContract ? { launchContract } : {}),
    blockNumber: Number(mint.blockNumber),
    transactionHash: mint.transactionHash,
    ...(registry ? { registry } : {}),
    venues: findVenues(token, receipt.logs, launchContract),
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
  // A missed window could hide an earlier mint, and a later one is not the start.
  if (truncated) return undefined;
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
  return readOrigin(
    token,
    mint,
    transaction.value as ChainTransaction,
    receipt.value as ChainReceipt,
  );
}

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

/** Removal transactions checked for their sender; beyond, the answer is unknown. */
const MAX_REMOVALS_CHECKED = 60;

/**
 * Which tokens had liquidity removed by the creator: each removal's
 * transaction is read for its sender. A token whose removals could not all be
 * read, and none of the read ones was the creator's, is left out: unknown.
 */
async function creatorRemovals(
  rpc: RpcClient,
  creator: string,
  targets: ReadonlySet<string>,
  removals: readonly { token: string; log: RawLog }[],
): Promise<Map<string, boolean>> {
  const pulled = new Map([...targets].map((t) => [t, false]));
  if (removals.length === 0) return pulled;
  // The most recent first: a pull ends a market's life, it rarely starts it.
  const hashes = [...new Set([...removals].reverse().map((r) => r.log.transactionHash))];
  const read = hashes.slice(0, MAX_REMOVALS_CHECKED);
  const outcomes = await rpc
    .callBatch<{ from?: string } | null>(
      read.map((hash) => ({ method: 'eth_getTransactionByHash', params: [hash] })),
    )
    .catch(() => []);
  const sender = new Map<string, string | null>(
    read.map((hash, i) => {
      const outcome = outcomes[i];
      return [hash, outcome?.ok && outcome.value?.from ? lower(outcome.value.from) : null];
    }),
  );
  const unread = new Set<string>();
  for (const { token, log } of removals) {
    const from = sender.get(log.transactionHash);
    if (from === lower(creator)) pulled.set(token, true);
    else if (from === undefined || from === null) unread.add(token);
  }
  for (const token of unread) if (pulled.get(token) === false) pulled.delete(token);
  return pulled;
}

type WindowQuery = { address: string; fromBlock: number; toBlock: number; topics: string[] };

/** Queries that each fit one window, sent in one batch. Any refusal marks the result truncated. */
async function readWindows(
  rpc: RpcClient,
  queries: readonly WindowQuery[],
): Promise<{ logs: RawLog[]; truncated: boolean }> {
  if (queries.length === 0) return { logs: [], truncated: false };
  const hex = (n: number) => `0x${n.toString(16)}`;
  try {
    const outcomes = await rpc.callBatch<RawLog[]>(
      queries.map((q) => ({
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
    const logs: RawLog[] = [];
    let truncated = false;
    for (const outcome of outcomes) {
      if (outcome.ok && Array.isArray(outcome.value)) logs.push(...outcome.value);
      else truncated = true;
    }
    return { logs, truncated };
  } catch {
    return { logs: [], truncated: true };
  }
}

export type DeployerHistoryOptions = {
  latestBlock: number;
  now?: () => Date;
};

/**
 * The creator's launches through the same launch contract, and for the most
 * recent ones, whether the creator sold into the market and whether liquidity
 * was removed — read over each launch's first ~11 days, like pons launches.
 */
export async function fetchDeployerHistory(
  rpc: RpcClient,
  origin: TokenOrigin,
  options: DeployerHistoryOptions,
): Promise<CreatorHistory> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const latest = options.latestBlock;
  const creator = origin.creator;
  const registry = origin.registry;

  const registryTopics: (string | null)[] = registry
    ? Array.from({ length: registry.creatorIndex + 1 }, (_, i) =>
        i === 0 ? registry.topic0 : i === registry.creatorIndex ? topicFor(creator) : null,
      )
    : [];

  const [listed, account] = await Promise.all([
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

  const isWallet = account[0]?.ok ? account[0].value === '0x' : null;
  const transactionCount = isWallet && account[1]?.ok ? Number(account[1].value) : null;

  const seen = new Set<string>();
  const all: Launch[] = [];
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
    all.sort((a, b) => a.blockNumber - b.blockNumber);
  }
  const launchesListed = Boolean(registry) && !listed?.truncated;

  const detailed = all.slice(-MAX_DETAILED_DEPLOYER_LAUNCHES);
  if (!detailed.some((l) => l.token === origin.token)) {
    const own = all.find((l) => l.token === origin.token);
    if (own) detailed.unshift(own);
  }
  const checked = detailed.filter(
    (l, i) => i >= detailed.length - MAX_CHECKED_DEPLOYER_LAUNCHES || l.token === origin.token,
  );

  // Each checked launch's markets come from its own launch transaction.
  const others = checked.filter((l) => l.token !== origin.token);
  const receipts = await rpc.callBatch<ChainReceipt | null>(
    others.map((l) => ({ method: 'eth_getTransactionReceipt', params: [l.transactionHash] })),
  );
  const venues = new Map<string, TradingVenues>([[origin.token, origin.venues]]);
  others.forEach((l, i) => {
    const receipt = receipts[i];
    if (receipt?.ok && receipt.value) {
      venues.set(l.token, findVenues(l.token, receipt.value.logs, origin.launchContract));
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

  const none = { logs: [] as RawLog[], truncated: false };
  const [sales, liquidityLogs, timestamps] = await Promise.all([
    salesTargets.length
      ? getLogsBatched(
          rpc,
          {
            addresses: salesTargets.map((l) => ({ address: l.token, ...windowOf(l) })),
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

  // A transfer into a curve is a sale on it. A transfer into a pool is one
  // only when the pool swapped in that transaction: without a swap, it is the
  // creator providing liquidity, not selling.
  const sold = new Map(salesTargets.map((l) => [l.token, false]));
  const intoPool: { token: string; hash: string }[] = [];
  for (const log of sales.logs) {
    const token = lower(log.address);
    const to = fromTopic(log.topics[2]);
    if (!venues.get(token)?.saleRecipients.includes(to)) continue;
    if (origin.launchContract && to === lower(origin.launchContract)) sold.set(token, true);
    else intoPool.push({ token, hash: log.transactionHash });
  }
  const marketAddresses = new Set([...tokenOfPool.keys(), lower(POOL_MANAGER)]);
  const natures = await readTxNatures(
    rpc,
    intoPool.map((t) => t.hash),
    marketAddresses,
  ).catch(() => new Map<string, never>());
  const unread = new Set<string>();
  for (const { token, hash } of intoPool) {
    const nature = natures.get(hash);
    if (nature === 'swap') sold.set(token, true);
    else if (nature === undefined) unread.add(token);
  }
  // A transaction whose receipt was not read could have been a sale.
  for (const token of unread) if (!sold.get(token)) sold.delete(token);
  const soldKnown = unseenAsUnknown(sold, sales.truncated);

  const liquidityTargets = new Set([...tokenOfPool.values(), ...tokenOfMarket.values()]);
  // Removals of any liquidity on the token's markets, by anyone.
  const removals: { token: string; log: RawLog }[] = [];
  for (const log of liquidityLogs.logs) {
    if (log.topics[0] === MODIFY_LIQUIDITY_TOPIC) {
      const token = tokenOfMarket.get(lower(log.topics[1] ?? ''));
      if (!token || !modifyRemovedLiquidity(log)) continue;
      // Outside its own window, a removal is not the one being asked about.
      const launch = checked.find((l) => l.token === token);
      if (launch && Number(log.blockNumber) <= windowOf(launch).toBlock) {
        removals.push({ token, log });
      }
    } else {
      const token = tokenOfPool.get(lower(log.address));
      if (token && burnMovedLiquidity(log)) removals.push({ token, log });
    }
  }
  // Anyone can add liquidity to a market and take it back: only a removal the
  // creator signed is theirs. Verified live, where a third party rebalancing
  // its own range made SEAL report the creator's liquidity as pulled.
  const pulled = await creatorRemovals(rpc, creator, liquidityTargets, removals);
  const pulledKnown = unseenAsUnknown(pulled, liquidityLogs.truncated);

  const checkedTokens = new Set(checked.map((l) => l.token));
  const tokens: LaunchedToken[] = detailed.map((l, i) => {
    const venue = venues.get(l.token);
    return {
      address: l.token,
      pool: venue?.pools[0] ?? (venue?.v4Markets.length ? lower(POOL_MANAGER) : '0x'),
      launchedAtBlock: l.blockNumber,
      launchedAt: timestamps[i] ?? null,
      // There is no graduation outside pons: whether a launch "made it" is
      // not something this history can say.
      outcome: 'undetermined',
      graduationProgress: 0,
      liquidityPulled: checkedTokens.has(l.token) ? (pulledKnown.get(l.token) ?? null) : null,
      creatorDumped: checkedTokens.has(l.token) ? (soldKnown.get(l.token) ?? null) : null,
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

  const capped = all.length > detailed.length;
  const note = listed?.truncated
    ? 'some launch windows could not be read — history may be incomplete'
    : !registry
      ? 'traced from the token’s first mint; this address’s other launches cannot be listed from the chain'
      : capped
        ? `traced from the token’s first mint; ${detailed.length} most recent of ${all.length} launches read in detail`
        : `traced from the token’s first mint; ${all.length} launch${all.length === 1 ? '' : 'es'} found through the same launch contract`;

  return {
    completeness: 'partial',
    sources: [{ name: 'robinhood-rpc', fetchedAt, note }],
    data: {
      creator,
      origin: {
        source: 'deployer',
        role: origin.role,
        ...(origin.launchContract ? { launchContract: origin.launchContract } : {}),
        launchesListed,
        transactionCount,
      },
      tokens,
      counts,
      scannedRange: { fromBlock: 0, toBlock: latest },
    },
  };
}
