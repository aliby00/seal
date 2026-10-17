import type { Clock } from '../src/clock.ts';
import { openDb } from '../src/db.ts';
import type { Log, LogFilter, Rpc, RpcRequest } from '../src/rpc.ts';

export const pad = (hex: string, width = 64): string => hex.replace(/^0x/, '').padStart(width, '0');
export const topic = (address: string): string => `0x${pad(address)}`;

/** int256 en complément à deux, sur 32 octets. */
export function int256(value: bigint): string {
  const v = value < 0n ? (1n << 256n) + value : value;
  return pad(v.toString(16));
}

export function memoryDb(now = () => 1_700_000_000_000) {
  return openDb(':memory:', now);
}

/** Une horloge figée : chaque bloc vaut 0,1 s après le bloc 0 posé à `base`. */
export function fixedClock(head: number, base = 1_700_000_000): Clock {
  return {
    observeHead: async () => head,
    head: () => head,
    timesOf: async (blocks) => {
      const out = new Map<number, number>();
      for (const b of blocks) out.set(b, Math.round(base + b / 10));
      return out;
    },
  };
}

/** Un nœud simulé : `logs` sert les `eth_getLogs`, `handlers` le reste. */
export function fakeRpc(options: {
  logs?: (filter: LogFilter) => Log[];
  call?: (request: RpcRequest) => unknown;
}): Rpc & { queries: LogFilter[] } {
  const queries: LogFilter[] = [];
  return {
    queries,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      return options.call?.({ method, params }) as T;
    },
    async batch<T>(requests: RpcRequest[]): Promise<(T | null)[]> {
      return requests.map((r) => (options.call?.(r) ?? null) as T | null);
    },
    async getLogs(filter: LogFilter): Promise<Log[]> {
      queries.push(filter);
      return options.logs?.(filter) ?? [];
    },
    stats: () => ({ requests: queries.length, rateLimited: 0 }),
  };
}

export function launchLog(input: {
  factory: string;
  token: string;
  creator: string;
  pool: string;
  pairToken?: string;
  block: number;
  logIndex?: number;
}): Log {
  const words = [
    pad(input.pairToken ?? '0x0bd7d308f8e1639fab988df18a8011f41eacad73'),
    pad(input.pool),
    pad('1'),
    pad('2'),
    pad('7'),
    pad('0'),
    pad('de0b6b3a7640000'),
  ];
  return {
    address: input.factory,
    topics: [
      '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a',
      topic(input.token),
      topic(input.creator),
      topic('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),
    ],
    data: `0x${words.join('')}`,
    blockNumber: `0x${input.block.toString(16)}`,
    transactionHash: `0x${pad(input.block.toString(16))}`,
    logIndex: `0x${(input.logIndex ?? 0).toString(16)}`,
  };
}

export function swapLog(input: {
  pool: string;
  sender?: string;
  recipient: string;
  amount0: bigint;
  amount1: bigint;
  block: number;
  logIndex?: number;
  txHash?: string;
}): Log {
  return {
    address: input.pool,
    topics: [
      '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
      topic(input.sender ?? '0x00000000000000000000000000000000000000aa'),
      topic(input.recipient),
    ],
    data: `0x${int256(input.amount0)}${int256(input.amount1)}${pad('1')}${pad('1')}${pad('0')}`,
    blockNumber: `0x${input.block.toString(16)}`,
    transactionHash:
      input.txHash ?? `0x${pad(`${input.block.toString(16)}${input.logIndex ?? 0}`)}`,
    logIndex: `0x${(input.logIndex ?? 0).toString(16)}`,
  };
}
