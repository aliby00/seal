import type { Address } from 'viem';
import type { LaunchMove, LaunchMoveKind, LaunchReplay } from '../contracts/launch';
import { IncompleteDataError } from '../errors';
import { TRANSFER_TOPIC } from './behavior';
import { fetchBlockTimestamps } from './graduation';
import type { RawLog } from './logs';
import { POOL_MANAGER } from './pools';
import type { RpcClient } from './rpc';

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
/** Moves listed. Beyond, they are counted, not drawn. */
export const MAX_MOVES = 40;

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
 */
export function draftMoves(logs: readonly RawLog[], pools: ReadonlySet<string>): DraftMove[] {
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
      if (pools.has(address) || address === ZERO) return false;
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

export async function readLaunchReplay(
  rpc: RpcClient,
  token: Address,
  options: {
    launchBlock: number;
    latestBlock: number;
    /** Every address that holds a market's tokens: the pons pool, DEX pairs, the v4 PoolManager. */
    pools: readonly string[];
    creator?: string | null;
    now?: () => Date;
  },
): Promise<LaunchReplay> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const pools = new Set([...options.pools, POOL_MANAGER].map((a) => a.toLowerCase()));
  const creator = options.creator?.toLowerCase() ?? null;
  const from = options.launchBlock;
  const to = Math.min(options.latestBlock, from + WINDOW_BLOCKS);

  const [logs, supplyHex] = await Promise.all([
    rpc.call<RawLog[]>('eth_getLogs', [
      {
        address: token,
        topics: [TRANSFER_TOPIC],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ]),
    rpc.call<string>('eth_call', [{ to: token, data: TOTAL_SUPPLY }, 'latest']),
  ]);
  const supply = BigInt(supplyHex && supplyHex !== '0x' ? supplyHex : 0);
  if (supply === 0n) {
    throw new IncompleteDataError('robinhood-rpc', 'the token’s supply could not be read');
  }

  const drafts = draftMoves(logs, pools);
  const blocks = [...new Set([from, ...drafts.slice(0, MAX_MOVES).map((m) => m.block), to])];
  const times = await fetchBlockTimestamps(rpc, blocks);
  const known: [number, number][] = blocks
    .map((b, i) => [b, times[i] ? Date.parse(times[i]!) / 1000 : NaN] as [number, number])
    .filter(([, t]) => Number.isFinite(t))
    .sort((a, b) => a[0] - b[0]);
  const launchTime = known.find(([b]) => b === from)?.[1];
  if (launchTime === undefined) {
    throw new IncompleteDataError('robinhood-rpc', 'the launch block could not be read');
  }
  const windowSeconds = Math.min(
    LAUNCH_WINDOW_SECONDS,
    Math.round(secondsAt(to, known) - launchTime),
  );

  const inWindow = drafts
    .map((m) => ({ ...m, seconds: Math.max(0, secondsAt(m.block, known) - launchTime) }))
    .filter((m) => m.seconds <= windowSeconds);
  const listed = inWindow.slice(0, MAX_MOVES);

  // Who each actor is, and what it holds today.
  const actors = [...new Set(listed.map((m) => m.actor))];
  const [codes, balances] = await Promise.all([
    rpc.callBatch<string>(actors.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] }))),
    rpc.callBatch<string>(
      actors.map((a) => ({
        method: 'eth_call',
        params: [{ to: token, data: `${BALANCE_OF}${a.slice(2).padStart(64, '0')}` }, 'latest'],
      })),
    ),
  ]);
  const info = new Map(
    actors.map((address, i) => {
      const code = codes[i];
      const balance = balances[i];
      const kind: LaunchMove['actorKind'] = pools.has(address)
        ? 'pool'
        : BURN.has(address)
          ? 'burn'
          : code?.ok && code.value !== '0x'
            ? 'contract'
            : 'wallet';
      const held =
        balance?.ok && balance.value && balance.value !== '0x'
          ? shareOf(BigInt(balance.value), supply)
          : null;
      return [address, { kind, held }] as const;
    }),
  );

  const moves: LaunchMove[] = listed.map((m) => ({
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

  return {
    completeness: 'full',
    sources: [
      {
        name: 'robinhood-rpc',
        fetchedAt,
        note: `${inWindow.length} moves in the first ${Math.round(windowSeconds / 60)} minutes, read from the token’s transfers`,
      },
    ],
    data: {
      token: token.toLowerCase(),
      launchBlock: from,
      launchedAt: new Date(launchTime * 1000).toISOString(),
      windowSeconds,
      supply: supply.toString(),
      moves,
      movesInWindow: inWindow.length,
    },
  };
}
