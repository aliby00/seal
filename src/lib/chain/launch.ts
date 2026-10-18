import type { Address } from 'viem';
import {
  BUNDLE_MIN_WALLETS,
  EARLY_SECONDS,
  ROUND_TRIPS_LISTED,
  type LaunchMove,
  type LaunchMoveKind,
  type LaunchReplay,
  type LaunchSummary,
} from '../contracts/launch';
import { IncompleteDataError } from '../errors';
import { TRANSFER_TOPIC } from './behavior';
import { fetchBlockTimestamps } from './graduation';
import type { RawLog } from './logs';
import { POOL_MANAGER } from './pools';
import { LogQueryTooBroadError, type RpcClient } from './rpc';
import { isContractCode } from './code';
import { LAUNCHPAD_WALLETS, LAUNCHPADS, launchInfrastructure } from './launchpads';
import { readTxDetails, readTxNatures, SWAP_TOPICS, type TxDetail, type TxNature } from './trades';

/**
 * The first minutes of a token, replayed from its own `Transfer` events.
 *
 * One `eth_getLogs` over the window after the launch block, then three batched
 * reads: the block times, which addresses are contracts, and what each address
 * holds today. About five requests, whatever the token.
 */

/** Ten minutes: the launch block, the first buyers, the first sales. */
export const LAUNCH_WINDOW_SECONDS = 600;
/**
 * Blocks read after the launch. Measured: 0.1 s per block on Robinhood Chain,
 * so twice the ten minutes, in case blocks were slower when the token was born.
 */
const WINDOW_BLOCKS = 12_000;
/** A launch too busy to read under this many blocks is not replayed. */
const MIN_WINDOW_BLOCKS = 150;
/** Moves listed. Beyond, they are counted, not drawn. */
export const MAX_MOVES = 40;
/**
 * Addresses whose balance today is read, at most: every actor drawn, then
 * the addresses one transaction served, then the first buyers. Five batches
 * of twenty; beyond, the summary says how many were not read. The public
 * node turns away bursts of reads, so only the moves drawn and the addresses
 * one transaction served have their code read too (wallet or contract).
 */
export const MAX_BALANCES_READ = 100;
export const MAX_CODES_READ = 60;

const ZERO = '0x0000000000000000000000000000000000000000';
const BURN = new Set([ZERO, '0x000000000000000000000000000000000000dead']);
const TOTAL_SUPPLY = '0x18160ddd';
const BALANCE_OF = '0x70a08231';

const topicAddress = (topic: string | undefined) =>
  topic ? `0x${topic.slice(26)}`.toLowerCase() : '';

type Transfer = { from: string; to: string; value: bigint; block: number; tx: string };

function readTransfer(log: RawLog): Transfer | undefined {
  // A Transfer has three topics; anything else under the signature is not fungible.
  if (log.topics.length !== 3) return undefined;
  const raw = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (raw.length < 64) return undefined;
  const value = BigInt(`0x${raw.slice(0, 64)}`);
  if (value === 0n) return undefined;
  return {
    from: topicAddress(log.topics[1]),
    to: topicAddress(log.topics[2]),
    value,
    block: Number(log.blockNumber),
    tx: log.transactionHash,
  };
}

export type DraftMove = {
  kind: LaunchMoveKind;
  actor: string;
  counterparty: string;
  value: bigint;
  block: number;
  transaction: string;
};

/**
 * Turns transfers into moves, one transaction at a time.
 *
 * Each transfer is classified by its ends: out of a pool is a buy, into a pool
 * a sale, out of the zero address a mint, anything else an allocation. An
 * address that only passes tokens through within a transaction (a router, a
 * factory, a launch contract) is folded away, so the move reads from the real
 * source to the real recipient: "the pool sold to this wallet", not "the pool
 * sold to the router, which gave to this wallet".
 *
 * `markets` are the addresses that trade (pools, curves, the PoolManager):
 * they are never folded. A launch contract set aside with them is folded
 * when it only relays: Doppler's Airlock and hook pass the whole supply on
 * to the PoolManager in the launch transaction, and that is the pool being
 * seeded with what was minted, not an "allocation" between two contracts.
 */
export function draftMoves(
  logs: readonly RawLog[],
  pools: ReadonlySet<string>,
  markets: ReadonlySet<string> = pools,
  /**
   * Filled with the addresses folded away while taking tokens out of a pool
   * and putting them back into one in the same transaction: a round trip
   * that never held the token (RH: 0xb0550000…, tx 0x6bf057cb…).
   */
  relayed?: RelayedTrip[],
): DraftMove[] {
  const byTx = new Map<string, Transfer[]>();
  for (const log of logs) {
    const transfer = readTransfer(log);
    if (!transfer) continue;
    const list = byTx.get(transfer.tx) ?? [];
    list.push(transfer);
    byTx.set(transfer.tx, list);
  }

  const moves: DraftMove[] = [];
  for (const transfers of byTx.values()) {
    const received = new Map<string, bigint>();
    const sent = new Map<string, bigint>();
    for (const t of transfers) {
      sent.set(t.from, (sent.get(t.from) ?? 0n) + t.value);
      received.set(t.to, (received.get(t.to) ?? 0n) + t.value);
    }
    // A launch contract may keep a fee as tokens pass through it: forwarding at
    // least 99 % of what it received in the same transaction still makes it a
    // relay, not a holder.
    const passThrough = (address: string) => {
      if (markets.has(address) || address === ZERO) return false;
      const inflow = received.get(address) ?? 0n;
      const outflow = sent.get(address) ?? 0n;
      return inflow > 0n && outflow * 100n >= inflow * 99n && outflow <= inflow;
    };

    // Follow each transfer back through pass-through addresses to its origin.
    const origin = (t: Transfer, seen = new Set<Transfer>()): string => {
      if (!passThrough(t.from)) return t.from;
      const feeding = transfers.find((u) => u.to === t.from && !seen.has(u));
      if (!feeding) return t.from;
      seen.add(feeding);
      return origin(feeding, seen);
    };

    if (relayed) {
      const seen = new Set<string>();
      for (const t of transfers) {
        const a = t.to;
        if (seen.has(a) || pools.has(a) || !pools.has(t.from) || !passThrough(a)) continue;
        if (!transfers.some((u) => u.from === a && pools.has(u.to))) continue;
        seen.add(a);
        relayed.push({ address: a, block: t.block, transaction: t.tx });
      }
    }

    const merged = new Map<string, DraftMove>();
    for (const t of transfers) {
      if (passThrough(t.to)) continue;
      const from = origin(t);
      if (from === t.to) continue;
      const kind: LaunchMoveKind =
        from === ZERO
          ? 'mint'
          : pools.has(from) && !pools.has(t.to)
            ? 'buy'
            : pools.has(t.to) && !pools.has(from)
              ? 'sell'
              : 'allocation';
      const actor = kind === 'sell' ? from : t.to;
      const counterparty = kind === 'sell' ? t.to : from;
      const key = `${kind}:${actor}:${counterparty}`;
      const existing = merged.get(key);
      if (existing) existing.value += t.value;
      else
        merged.set(key, {
          kind,
          actor,
          counterparty,
          value: t.value,
          block: t.block,
          transaction: t.tx,
        });
    }
    moves.push(...merged.values());
  }
  return moves.sort((a, b) => a.block - b.block);
}

/** Moves of the creator always shown, at most. */
const MAX_CREATOR_MOVES = 15;
/** The largest moves always shown, at most. */
const MAX_LARGEST_MOVES = 10;

/**
 * Which moves a busy launch shows: every move of the creator, then the largest
 * by share, then the earliest, up to MAX_MOVES, in time order. Showing only the
 * first forty hid, on a live token, the creator selling 72 % of the supply at
 * the ninth minute.
 */
export function selectMoves<T extends DraftMove>(moves: readonly T[], creator: string | null): T[] {
  if (moves.length <= MAX_MOVES) return [...moves];
  const chosen = new Set<T>();
  const add = (list: readonly T[], cap: number) => {
    for (const m of list) {
      if (chosen.size >= MAX_MOVES || cap <= 0) break;
      if (!chosen.has(m)) {
        chosen.add(m);
        cap -= 1;
      }
    }
  };
  if (creator) {
    add(
      moves.filter((m) => m.actor === creator || m.counterparty === creator),
      MAX_CREATOR_MOVES,
    );
  }
  add(
    [...moves].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0)),
    MAX_LARGEST_MOVES,
  );
  add(moves, MAX_MOVES);
  return moves.filter((m) => chosen.has(m));
}

/**
 * What counts as a trade in a launch: the Uniswap swaps, and every known
 * launchpad's own curve events. With the swaps alone, three vaults buying 71 %
 * of MUT8 on its 0x7ed5 curve (`CurveBuy`) then adding v4 liquidity read as
 * liquidity "withdrawn" from the curve.
 */
export const TRADE_TOPICS: ReadonlySet<string> = new Set([
  ...SWAP_TOPICS,
  ...LAUNCHPADS.flatMap((l) => l.curveTrades ?? []),
]);

/**
 * A transfer into or out of a pool reads the same for a trade and for a
 * liquidity change: the transaction's receipt tells them apart. A move whose
 * receipt could not be read keeps its trade reading.
 */
export async function separateLiquidity<T extends DraftMove>(
  rpc: RpcClient,
  moves: readonly T[],
  pools: ReadonlySet<string>,
  natures?: ReadonlyMap<string, TxNature>,
): Promise<T[]> {
  const pooled = moves.filter((m) => m.kind === 'buy' || m.kind === 'sell');
  if (pooled.length === 0) return [...moves];
  const read =
    natures ??
    (await readTxNatures(
      rpc,
      pooled.map((m) => m.transaction),
      pools,
      TRADE_TOPICS,
    ).catch(() => new Map<string, never>()));
  return moves.map((m) => relabel(m, read));
}

function relabel<T extends DraftMove>(m: T, natures: ReadonlyMap<string, TxNature>): T {
  return (m.kind === 'buy' || m.kind === 'sell') && natures.get(m.transaction) === 'liquidity'
    ? { ...m, kind: m.kind === 'sell' ? 'provide' : 'withdraw' }
    : m;
}

/**
 * The transfers after the launch block. A launch so busy that the node
 * refuses the whole window is read over a shorter one, halved until it fits:
 * the replay then covers fewer minutes, and says so.
 */
async function readTransfers(
  rpc: RpcClient,
  token: Address,
  from: number,
  to: number,
): Promise<{ logs: RawLog[]; to: number; narrowed: boolean }> {
  let end = to;
  for (;;) {
    try {
      const logs = await rpc.call<RawLog[]>('eth_getLogs', [
        {
          address: token,
          topics: [TRANSFER_TOPIC],
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
        },
      ]);
      return { logs, to: end, narrowed: end < to };
    } catch (error) {
      const span = end - from;
      if (!(error instanceof LogQueryTooBroadError) || span <= MIN_WINDOW_BLOCKS) throw error;
      end = from + Math.floor(span / 2);
    }
  }
}

/** Share of `supply`, rounded to 1e-6 so the JSON stays readable. */
function shareOf(value: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  return Number((value * 1_000_000n) / supply) / 1_000_000;
}

/** Block time by linear interpolation between the two nearest known blocks. */
function secondsAt(block: number, known: readonly [number, number][]): number {
  const exact = known.find(([b]) => b === block);
  if (exact) return exact[1];
  const before = [...known].reverse().find(([b]) => b < block);
  const after = known.find(([b]) => b > block);
  if (before && after) {
    return before[1] + ((after[1] - before[1]) * (block - before[0])) / (after[0] - before[0]);
  }
  return (before ?? after)?.[1] ?? 0;
}

type TimedMove = DraftMove & { seconds: number };

/** An address that bought and sold back inside one transaction, never holding the token. */
export type RelayedTrip = { address: string; block: number; transaction: string };

/** What the totals rest on, before any balance is read. */
type LaunchTally = {
  creatorAtLaunch: number;
  creatorBought: number;
  creatorSold: number;
  creatorFirstBuyAt: number | null;
  creatorLastSaleAt: number | null;
  /** First buyers (not the creator), in the order they bought, with what they bought early. */
  early: string[];
  earlyBought: Map<string, bigint>;
  earlyWithin: number;
  /** The transaction serving the most supply to several addresses, and what each got. */
  bundle: { transaction: string; seconds: number; bought: Map<string, bigint> } | null;
  bundled: string[];
  /**
   * What the launch block's transactions sent by the creator delivered to
   * other addresses than the creator's own (MUT8: 71.4 % to three contracts
   * in the creator's launch transaction), by recipient.
   */
  creatorTx: { transaction: string; bought: Map<string, bigint> } | null;
  /** The creator, as the moves name it. */
  creator?: string | null;
  /** A creator sale whose receipt shows a trade in the market. */
  creatorSaleConfirmed: boolean;
  /** Every address that bought, then sold back in the window: its first buy and that sale. */
  roundTrips: { address: string; boughtAt: number; soldAt: number }[];
  /** Addresses left out of the round trips, and why: counted, so the report can say so. */
  roundTripsExcluded?: { sameTransaction: string[]; liquidity: string[] };
  supply: bigint;
};

/**
 * Who bought and then sold back within the window, over every move: each
 * address's first buy, and its first sale back at or after it. The creator
 * first, then by first buy.
 *
 * Two cases are not round trips here, on purpose, and are counted apart by
 * `excludedRoundTrips` so the report states them:
 *  - a contract taking tokens out of a pool and putting them back into one in
 *    the same transaction (an arbitrage, RH: 0xb0550000…, tx 0x6bf057cb…, 0 s):
 *    it never held the token, `draftMoves` folds it away as a relay;
 *  - an address whose tokens went back into a pool as liquidity rather than
 *    as a sale (RH: 0xb351f101…, 3 s later, a v4 pool created and funded): the
 *    receipt shows a liquidity change, not a trade, so it did not sell back.
 */
export function roundTripsOf(
  moves: readonly TimedMove[],
  pools: ReadonlySet<string>,
  creator: string | null,
): { address: string; boughtAt: number; soldAt: number }[] {
  const market = (a: string) => pools.has(a) || BURN.has(a);
  const firstBuy = new Map<string, number>();
  for (const m of moves) {
    if (m.kind !== 'buy' || market(m.actor)) continue;
    const at = firstBuy.get(m.actor);
    if (at === undefined || m.seconds < at) firstBuy.set(m.actor, m.seconds);
  }
  const sale = new Map<string, number>();
  for (const m of moves) {
    if (m.kind !== 'sell' || market(m.actor)) continue;
    const bought = firstBuy.get(m.actor);
    if (bought === undefined || m.seconds < bought) continue;
    const at = sale.get(m.actor);
    if (at === undefined || m.seconds < at) sale.set(m.actor, m.seconds);
  }
  const round = (x: number) => Math.round(x * 10) / 10;
  return [...sale.keys()]
    .map((address) => ({
      address,
      boughtAt: round(firstBuy.get(address)!),
      soldAt: round(sale.get(address)!),
    }))
    .sort(
      (a, b) =>
        Number(b.address === creator) - Number(a.address === creator) ||
        a.boughtAt - b.boughtAt ||
        a.soldAt - b.soldAt,
    );
}

/**
 * The round trips left out, and why: addresses relayed within one
 * transaction, and buyers whose tokens went back into a pool as liquidity.
 * Neither is counted among `roundTripsOf`; both are said next to the count.
 */
export function excludedRoundTrips(
  moves: readonly TimedMove[],
  pools: ReadonlySet<string>,
  trips: readonly { address: string }[],
  relayed: readonly { address: string }[] = [],
): { sameTransaction: string[]; liquidity: string[] } {
  const counted = new Set(trips.map((t) => t.address));
  const market = (a: string) => pools.has(a) || BURN.has(a);
  const firstBuy = new Map<string, number>();
  for (const m of moves) {
    if (m.kind !== 'buy' || market(m.actor)) continue;
    const at = firstBuy.get(m.actor);
    if (at === undefined || m.seconds < at) firstBuy.set(m.actor, m.seconds);
  }
  const liquidity = new Set<string>();
  for (const m of moves) {
    if (m.kind !== 'provide' || market(m.actor) || counted.has(m.actor)) continue;
    const bought = firstBuy.get(m.actor);
    if (bought !== undefined && m.seconds >= bought) liquidity.add(m.actor);
  }
  const sameTransaction = new Set<string>();
  for (const r of relayed) {
    if (!counted.has(r.address) && !liquidity.has(r.address)) sameTransaction.add(r.address);
  }
  return { sameTransaction: [...sameTransaction], liquidity: [...liquidity] };
}

/**
 * The launch's totals over every move read in the window. Buys are purchases
 * out of a pool or a curve by anyone but the creator; a move turned into a
 * liquidity change by its receipt is not one.
 */
export function tallyLaunch(
  moves: readonly TimedMove[],
  context: {
    creator: string | null;
    from: number;
    pools: ReadonlySet<string>;
    supply: bigint;
    /** Who sent each transaction whose receipt was read. */
    senders?: ReadonlyMap<string, string | null>;
    natures?: ReadonlyMap<string, TxNature>;
    /** Addresses that bought and sold back within one transaction, in the window. */
    relayed?: readonly RelayedTrip[];
  },
): LaunchTally {
  const { creator, from, pools, supply } = context;
  const senders = context.senders ?? new Map<string, string | null>();
  const natures = context.natures ?? new Map<string, TxNature>();
  const buys = moves.filter((m) => m.kind === 'buy' && !pools.has(m.actor) && !BURN.has(m.actor));
  const own = (m: DraftMove) => creator !== null && m.actor === creator;
  const sum = (list: readonly DraftMove[]) => list.reduce((n, m) => n + m.value, 0n);

  const creatorAtLaunch = sum(
    moves.filter(
      (m) =>
        own(m) &&
        m.block === from &&
        (m.kind === 'buy' || m.kind === 'mint' || m.kind === 'allocation'),
    ),
  );
  const creatorBuys = buys.filter(own);
  const creatorSales = moves.filter((m) => m.kind === 'sell' && own(m));

  const others = buys.filter((m) => !own(m)).sort((a, b) => a.seconds - b.seconds);
  const firstAt = new Map<string, number>();
  for (const m of others) if (!firstAt.has(m.actor)) firstAt.set(m.actor, m.seconds);
  const earlyBought = new Map<string, bigint>();
  let earlyWithin = 0;
  for (const m of others) {
    if (m.seconds > EARLY_SECONDS) continue;
    earlyBought.set(m.actor, (earlyBought.get(m.actor) ?? 0n) + m.value);
    earlyWithin = Math.max(earlyWithin, m.seconds);
  }

  const byTx = new Map<string, { seconds: number; bought: Map<string, bigint>; total: bigint }>();
  for (const m of others) {
    const key = m.transaction.toLowerCase();
    const group = byTx.get(key) ?? { seconds: m.seconds, bought: new Map(), total: 0n };
    group.bought.set(m.actor, (group.bought.get(m.actor) ?? 0n) + m.value);
    group.total += m.value;
    byTx.set(key, group);
  }
  const bundle =
    [...byTx.entries()]
      .filter(([, g]) => g.bought.size >= BUNDLE_MIN_WALLETS)
      .sort((a, b) => (b[1].total > a[1].total ? 1 : b[1].total < a[1].total ? -1 : 0))
      .map(([transaction, g]) => ({ transaction, seconds: g.seconds, bought: g.bought }))[0] ??
    null;

  // Delivered in the launch block, in a transaction the creator sent, to
  // anyone but the creator, a pool or a burn address.
  const viaCreator = new Map<string, bigint>();
  let creatorTransaction: string | null = null;
  for (const m of moves) {
    if (creator === null || m.block !== from || own(m)) continue;
    if (m.kind !== 'buy' && m.kind !== 'mint' && m.kind !== 'allocation') continue;
    if (pools.has(m.actor) || BURN.has(m.actor)) continue;
    // A launchpad's own wallet, served by the launchpad's rule (Virtuals' reserve wallet).
    if (LAUNCHPAD_WALLETS.has(m.actor)) continue;
    if (senders.get(m.transaction) !== creator) continue;
    viaCreator.set(m.actor, (viaCreator.get(m.actor) ?? 0n) + m.value);
    creatorTransaction ??= m.transaction;
  }

  const trips = roundTripsOf(moves, pools, creator);
  return {
    creator,
    creatorTx:
      viaCreator.size > 0 && creatorTransaction
        ? { transaction: creatorTransaction, bought: viaCreator }
        : null,
    creatorSaleConfirmed: creatorSales.some((m) => natures.get(m.transaction) === 'swap'),
    roundTrips: trips,
    roundTripsExcluded: excludedRoundTrips(moves, pools, trips, context.relayed),
    creatorAtLaunch: shareOf(creatorAtLaunch, supply),
    creatorBought: shareOf(sum(creatorBuys), supply),
    creatorSold: shareOf(sum(creatorSales), supply),
    creatorFirstBuyAt: creatorBuys[0]?.seconds ?? null,
    creatorLastSaleAt: creatorSales.at(-1)?.seconds ?? null,
    early: [...earlyBought.keys()],
    earlyBought,
    earlyWithin,
    bundle,
    bundled: bundle ? [...bundle.bought.keys()] : [],
    supply,
  };
}

/** The code size of each contract among `bought`, when every one was read. */
function codeSizesOf(
  bought: ReadonlyMap<string, bigint>,
  info: ReadonlyMap<string, { kind: LaunchMove['actorKind'] | null; codeSize?: number | null }>,
): { codeSizes?: number[] } {
  const sizes: number[] = [];
  for (const address of bought.keys()) {
    const known = info.get(address);
    if (known?.kind !== 'contract') continue;
    if (typeof known.codeSize !== 'number') return {};
    sizes.push(known.codeSize);
  }
  return sizes.length > 0 ? { codeSizes: sizes } : {};
}

function roundTripSummary(tally: LaunchTally): NonNullable<LaunchSummary['roundTrips']> {
  const trips = tally.roundTrips ?? [];
  const delays = trips.map((t) => Math.round((t.soldAt - t.boughtAt) * 10) / 10);
  const bundled = tally.bundle ? new Set(tally.bundle.bought.keys()) : null;
  return {
    wallets: trips.length,
    creator: trips.some((t) => t.address === tally.creator),
    delays: delays.length > 0 ? { min: Math.min(...delays), max: Math.max(...delays) } : null,
    fromBundle: bundled ? trips.filter((t) => bundled.has(t.address)).length : null,
    listed: trips.slice(0, ROUND_TRIPS_LISTED),
    ...(tally.roundTripsExcluded
      ? {
          excluded: {
            sameTransaction: tally.roundTripsExcluded.sameTransaction.length,
            liquidity: tally.roundTripsExcluded.liquidity.length,
          },
        }
      : {}),
  };
}

/** The totals, with what the addresses read hold today. */
export function summarize(
  tally: LaunchTally,
  info: ReadonlyMap<
    string,
    { kind: LaunchMove['actorKind'] | null; held: number | null; codeSize?: number | null }
  >,
  counts: Pick<
    LaunchSummary,
    'receiptsRead' | 'receiptsWanted' | 'balancesRead' | 'balancesWanted' | 'moves'
  >,
): LaunchSummary {
  // What an address holds today counts up to what it bought here, never more.
  const held = (bought: ReadonlyMap<string, bigint>) => {
    let sum = 0;
    let read = 0;
    let contracts = 0;
    let typed = 0;
    for (const [address, value] of bought) {
      const known = info.get(address);
      if (known?.kind === 'contract') contracts += 1;
      if (known?.kind) typed += 1;
      if (known?.held === null || known?.held === undefined) continue;
      read += 1;
      sum += Math.min(known.held, shareOf(value, tally.supply));
    }
    return {
      heldNow: read > 0 ? Math.round(sum * 1_000_000) / 1_000_000 : null,
      unread: bought.size - read,
      contracts: typed === bought.size ? contracts : null,
    };
  };
  const total = (bought: ReadonlyMap<string, bigint>) =>
    shareOf(
      [...bought.values()].reduce((n, v) => n + v, 0n),
      tally.supply,
    );
  const early = held(tally.earlyBought);
  const bundle = tally.bundle ? { ...tally.bundle, ...held(tally.bundle.bought) } : null;
  const viaCreator = tally.creatorTx
    ? { ...tally.creatorTx, ...held(tally.creatorTx.bought) }
    : null;
  return {
    moves: counts.moves,
    earlySeconds: EARLY_SECONDS,
    creatorAtLaunch: tally.creatorAtLaunch,
    creatorBought: tally.creatorBought,
    creatorSold: tally.creatorSold,
    creatorFirstBuyAt: tally.creatorFirstBuyAt,
    creatorLastSaleAt: tally.creatorLastSaleAt,
    creatorSaleConfirmed: tally.creatorSaleConfirmed,
    creatorTx: viaCreator
      ? {
          transaction: viaCreator.transaction,
          addresses: viaCreator.bought.size,
          share: total(viaCreator.bought),
          heldNow: viaCreator.heldNow,
          contracts: viaCreator.contracts,
          ...codeSizesOf(viaCreator.bought, info),
        }
      : null,
    early: {
      wallets: tally.early.length,
      share: total(tally.earlyBought),
      within: Math.round(tally.earlyWithin * 10) / 10,
      ...early,
    },
    bundle: bundle
      ? {
          transaction: bundle.transaction,
          wallets: bundle.bought.size,
          share: total(bundle.bought),
          seconds: Math.round(bundle.seconds * 10) / 10,
          heldNow: bundle.heldNow,
          unread: bundle.unread,
          contracts: bundle.contracts,
        }
      : null,
    roundTrips: roundTripSummary(tally),
    receiptsRead: counts.receiptsRead,
    receiptsWanted: counts.receiptsWanted,
    balancesRead: counts.balancesRead,
    balancesWanted: counts.balancesWanted,
  };
}

export async function readLaunchReplay(
  rpc: RpcClient,
  token: Address,
  options: {
    launchBlock: number;
    latestBlock: number;
    /** Every address that holds a market's tokens: the pons pool, DEX pairs, the v4 PoolManager. */
    pools: readonly string[];
    /** The markets' trading rules (hooks), read from their `Initialize`: set aside, never buyers. */
    hooks?: readonly string[];
    creator?: string | null;
    now?: () => Date;
  },
): Promise<LaunchReplay> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  // A launchpad's own contracts, its lock contract and the markets' hooks
  // hold supply for the launch, like a pool: the 0x7ed5 lock receiving
  // 8.163 % at graduation is not a buyer of the first minute.
  const markets = new Set([...options.pools, POOL_MANAGER].map((a) => a.toLowerCase()));
  const pools = new Set(
    [...markets, ...launchInfrastructure().keys(), ...(options.hooks ?? [])].map((a) =>
      a.toLowerCase(),
    ),
  );
  const creator = options.creator?.toLowerCase() ?? null;
  const from = options.launchBlock;
  const [read, supplyHex] = await Promise.all([
    readTransfers(rpc, token, from, Math.min(options.latestBlock, from + WINDOW_BLOCKS)),
    rpc.call<string>('eth_call', [{ to: token, data: TOTAL_SUPPLY }, 'latest']),
  ]);
  const { logs, to, narrowed } = read;
  const supply = BigInt(supplyHex && supplyHex !== '0x' ? supplyHex : 0);
  if (supply === 0n) {
    throw new IncompleteDataError('robinhood-rpc', 'the token’s supply could not be read');
  }

  // A hook taking its fee from the PoolManager, and paying it back, on
  // every trade (Doppler's 0x6f02…, 0x7ed5's 0xe5e7…) is the market's own
  // plumbing: between two set-aside addresses, not a move of the supply.
  const hooks = new Set([
    ...(options.hooks ?? []).map((h) => h.toLowerCase()),
    ...[...launchInfrastructure()].filter(([, role]) => role === 'hook').map(([a]) => a),
  ]);
  const relayed: RelayedTrip[] = [];
  const drafts = draftMoves(logs, pools, markets, relayed).filter(
    (m) =>
      !(
        pools.has(m.actor) &&
        pools.has(m.counterparty) &&
        (hooks.has(m.actor) || hooks.has(m.counterparty))
      ),
  );

  // The window's edges first: every move is placed between them, and only the
  // moves kept are timed exactly.
  const edges = await fetchBlockTimestamps(rpc, from === to ? [from] : [from, to]);
  const edgeTimes: [number, number][] = (from === to ? [from] : [from, to])
    .map((b, i) => [b, edges[i] ? Date.parse(edges[i]!) / 1000 : NaN] as [number, number])
    .filter(([, t]) => Number.isFinite(t));
  const launchTime = edgeTimes.find(([b]) => b === from)?.[1];
  if (launchTime === undefined) {
    throw new IncompleteDataError('robinhood-rpc', 'the launch block could not be read');
  }
  const windowSeconds = Math.min(
    LAUNCH_WINDOW_SECONDS,
    Math.round(secondsAt(to, edgeTimes) - launchTime),
  );
  const inWindow = drafts.filter(
    (m) => secondsAt(m.block, edgeTimes) - launchTime <= windowSeconds,
  );
  const selected = selectMoves(inWindow, creator);

  // Trades and liquidity changes look alike: the receipts tell them apart.
  // Those of the moves drawn first, then those of the first minute's buys,
  // which the totals rest on.
  const early = (m: DraftMove) =>
    m.kind === 'buy' && secondsAt(m.block, edgeTimes) - launchTime <= EARLY_SECONDS;
  // The launch block's own transactions come first: who sent them says
  // whether what they delivered came with the creator's launch.
  const wantedReceipts = [
    ...new Set(
      [
        ...inWindow.filter((m) => m.block === from && m.kind !== 'sell'),
        ...selected.filter((m) => m.kind === 'buy' || m.kind === 'sell'),
        ...inWindow.filter(early),
        ...inWindow.filter((m) => m.kind === 'buy' || m.kind === 'sell'),
      ].map((m) => m.transaction),
    ),
  ];
  // A part of the replay that failed is named, so the report says it is
  // partial: the receipts tell who sent the launch block's transactions.
  const failedParts: string[] = [];
  const details = await readTxDetails(rpc, wantedReceipts, pools, TRADE_TOPICS).catch(() => {
    failedParts.push('the receipts that tell trades from liquidity changes, and who sent them,');
    return new Map<string, TxDetail>();
  });
  const natures = new Map([...details].map(([hash, d]) => [hash, d.nature]));
  const senders = new Map([...details].map(([hash, d]) => [hash, d.from]));
  const kept = await separateLiquidity(rpc, selected, pools, natures);
  const everyMove = inWindow.map((m) => relabel(m, natures));

  const blocks = [...new Set([from, ...kept.map((m) => m.block), to])];
  const times = await fetchBlockTimestamps(rpc, blocks);
  const known: [number, number][] = blocks
    .map((b, i) => [b, times[i] ? Date.parse(times[i]!) / 1000 : NaN] as [number, number])
    .filter(([, t]) => Number.isFinite(t))
    .sort((a, b) => a[0] - b[0]);
  const at = (block: number) =>
    Math.min(windowSeconds, Math.max(0, secondsAt(block, known) - launchTime));
  const listed = kept.map((m) => ({ ...m, seconds: at(m.block) }));

  const totals = tallyLaunch(
    everyMove.map((m) => ({ ...m, seconds: at(m.block) })),
    {
      creator,
      from,
      pools,
      supply,
      senders,
      natures,
      relayed: relayed.filter((r) => secondsAt(r.block, edgeTimes) - launchTime <= windowSeconds),
    },
  );

  // Who each actor is, and what it holds today: the moves drawn first, then
  // the first buyers and the addresses one transaction served, up to a cap.
  const shown = [...new Set(listed.map((m) => m.actor))];
  const linked = [...(totals.creatorTx?.bought.keys() ?? [])];
  const wanted = [...new Set([...shown, ...linked, ...totals.bundled, ...totals.early])];
  const actors = wanted.slice(0, Math.max(MAX_BALANCES_READ, shown.length + linked.length));
  // Codes say wallet or contract: needed for the moves drawn and for the
  // addresses one transaction served, whose count the report words.
  const typed = new Set(
    [...new Set([...shown, ...linked, ...totals.bundled])].slice(
      0,
      Math.max(MAX_CODES_READ, shown.length + linked.length),
    ),
  );
  const coded = actors.filter((a) => typed.has(a));
  const [codeList, balances] = await Promise.all([
    rpc
      .callBatch<string>(coded.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })))
      .catch(() => {
        failedParts.push('which addresses are wallets or contracts');
        return [];
      }),
    rpc
      .callBatch<string>(
        actors.map((a) => ({
          method: 'eth_call',
          params: [{ to: token, data: `${BALANCE_OF}${a.slice(2).padStart(64, '0')}` }, 'latest'],
        })),
      )
      .catch(() => {
        failedParts.push('what the addresses hold today');
        return [];
      }),
  ]);
  const codeOf = new Map(coded.map((a, i) => [a, codeList[i]]));
  const info = new Map(
    actors.map((address, i) => {
      const code = codeOf.get(address);
      const balance = balances[i];
      const kind: LaunchMove['actorKind'] | null = pools.has(address)
        ? 'pool'
        : BURN.has(address)
          ? 'burn'
          : code?.ok
            ? // A wallet delegating under EIP-7702 has code and is still a wallet.
              isContractCode(code.value)
              ? 'contract'
              : 'wallet'
            : null;
      const held =
        balance?.ok && balance.value && balance.value !== '0x'
          ? shareOf(BigInt(balance.value), supply)
          : null;
      // Bytes of code: 45 is a minimal proxy (MUT8's three launch recipients).
      const codeSize =
        code?.ok && typeof code.value === 'string' && code.value.startsWith('0x')
          ? (code.value.length - 2) / 2
          : null;
      return [address, { kind, held, codeSize }] as const;
    }),
  );

  const drawn: LaunchMove[] = listed.map((m) => ({
    kind: m.kind,
    seconds: Math.round(m.seconds * 10) / 10,
    block: m.block - from,
    actor: m.actor,
    counterparty: m.counterparty,
    actorKind: info.get(m.actor)?.kind ?? 'wallet',
    share: shareOf(m.value, supply),
    actorIsCreator: creator !== null && m.actor === creator,
    counterpartyIsCreator: creator !== null && m.counterparty === creator,
    heldNow: info.get(m.actor)?.held ?? null,
    transaction: m.transaction,
  }));
  // A launch contract sending dust to a burn address in the launch
  // transaction (Doppler's Airlock, to 0x…dead) is not a move worth a line.
  const moves = drawn.filter((m) => !(m.actorKind === 'burn' && m.share === 0));

  const summary = summarize(totals, info, {
    receiptsRead: Math.min(wantedReceipts.length, natures.size),
    receiptsWanted: wantedReceipts.length,
    balancesRead: [...info.values()].filter((v) => v.held !== null).length,
    balancesWanted: wanted.length,
    moves: inWindow.length,
  });

  const cut = inWindow.length > listed.length;
  const minutes =
    windowSeconds < 90 ? `${windowSeconds} seconds` : `${Math.round(windowSeconds / 60)} minutes`;
  const notes = [
    cut
      ? `${inWindow.length} moves in the first ${minutes}, all counted in the totals; ${listed.length} shown: every move of the creator, the largest, then the earliest`
      : `${inWindow.length} moves in the first ${minutes}, read from the token’s transfers`,
    ...(summary.receiptsWanted > summary.receiptsRead
      ? [
          `${summary.receiptsRead} of ${summary.receiptsWanted} trading transactions were read to tell trades from liquidity changes; the others are counted as trades`,
        ]
      : []),
    ...(summary.balancesWanted > summary.balancesRead
      ? [`what ${summary.balancesRead} of ${summary.balancesWanted} addresses hold today was read`]
      : []),
    ...(narrowed
      ? [`the launch was too busy to read over ten minutes: only the first ${minutes} are covered`]
      : []),
  ];
  const sources: LaunchReplay['sources'] = [
    { name: 'robinhood-rpc', fetchedAt, note: notes.join('; ') },
    ...failedParts.map((part) => ({
      name: 'robinhood-rpc' as const,
      fetchedAt,
      note: `${part} could not be read this time`,
    })),
  ];
  return {
    // Every move was read; only the drawing keeps a selection of them.
    completeness: cut || narrowed || failedParts.length > 0 ? 'partial' : 'full',
    sources,
    data: {
      token: token.toLowerCase(),
      launchBlock: from,
      launchedAt: new Date(launchTime * 1000).toISOString(),
      windowSeconds,
      supply: supply.toString(),
      moves,
      movesInWindow: inWindow.length,
      summary,
    },
  };
}
