/**
 * Événements lus par l'indexeur, décodés à la main : pas de dépendance, et les
 * trois formats sont fixes. Les constantes sont celles de l'application
 * (`src/lib/chain/factory.ts`, `pools.ts`, `trades.ts`), recopiées parce que
 * l'indexeur se construit seul, sans le reste du dépôt.
 */
import type { Log } from './rpc.ts';

export const TOKEN_LAUNCHED_TOPIC =
  '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
export const V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
export const INITIALIZE_TOPIC =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
/** `token0()` d'un pool Uniswap V3. */
export const TOKEN0_SELECTOR = '0x0dfe1681';

export type FactoryRange = { address: string; fromBlock: number; toBlock?: number };

/**
 * Les générations du launchpad pons, comme `PONS_FACTORIES` dans l'application.
 * Relevé le 17/10/2026 : 269 443 lancements en tout, dont plus de 268 000 sur
 * `0xa5aa…` entre les blocs 10 M et 40 M.
 */
export const PONS_FACTORIES: readonly FactoryRange[] = [
  { address: '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75', fromBlock: 39_000_000 },
  { address: '0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe', fromBlock: 12_000_000 },
  {
    address: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb',
    fromBlock: 8_991_118,
    toBlock: 40_000_000,
  },
  {
    address: '0x0c37a24f5d23a486fa692d1500881d698b1f77a4',
    fromBlock: 8_600_612,
    toBlock: 35_000_000,
  },
];

function word(data: string, index: number): string {
  return data.slice(2 + index * 64, 2 + (index + 1) * 64);
}

export function topicAddress(topic: string | undefined): string {
  return `0x${(topic ?? '').slice(-40)}`.toLowerCase();
}

function wordAddress(data: string, index: number): string {
  return `0x${word(data, index).slice(24)}`.toLowerCase();
}

function wordUint(data: string, index: number): bigint {
  const w = word(data, index);
  return w ? BigInt(`0x${w}`) : 0n;
}

/** Un mot de 32 octets lu comme `int256` (complément à deux). */
export function wordInt(data: string, index: number): bigint {
  const value = wordUint(data, index);
  return value >= 1n << 255n ? value - (1n << 256n) : value;
}

export type LaunchRow = {
  token: string;
  creator: string;
  dexFactory: string;
  pairToken: string;
  pool: string;
  positionId: string;
  initialBuyAmount: string;
  factory: string;
  block: number;
  txHash: string;
  logIndex: number;
};

/**
 * `TokenLaunched(token, deployer, dexFactory indexés ; pairToken, pool, dexId,
 * launchConfigId, positionId, restrictionsEndBlock, initialBuyAmount)`.
 */
export function decodeLaunch(log: Log): LaunchRow {
  return {
    token: topicAddress(log.topics[1]),
    creator: topicAddress(log.topics[2]),
    dexFactory: topicAddress(log.topics[3]),
    pairToken: wordAddress(log.data, 0),
    pool: wordAddress(log.data, 1),
    positionId: wordUint(log.data, 4).toString(),
    initialBuyAmount: wordUint(log.data, 6).toString(),
    factory: log.address.toLowerCase(),
    block: Number(log.blockNumber),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(log.logIndex),
  };
}

export type SwapLog = {
  pool: string;
  sender: string;
  recipient: string;
  amount0: bigint;
  amount1: bigint;
  block: number;
  txHash: string;
  logIndex: number;
};

/** Uniswap V3 `Swap(sender indexé, recipient indexé, amount0, amount1, sqrtPriceX96, liquidity, tick)`. */
export function decodeSwap(log: Log): SwapLog {
  return {
    pool: log.address.toLowerCase(),
    sender: topicAddress(log.topics[1]),
    recipient: topicAddress(log.topics[2]),
    amount0: wordInt(log.data, 0),
    amount1: wordInt(log.data, 1),
    block: Number(log.blockNumber),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(log.logIndex),
  };
}

/**
 * Achat ou vente du token, vu du pool : un montant négatif est sorti du pool.
 * Le token sorti du pool = un achat ; entré dans le pool = une vente.
 */
export function swapSide(
  swap: Pick<SwapLog, 'amount0' | 'amount1'>,
  tokenIsToken0: boolean,
): 'buy' | 'sell' {
  const tokenDelta = tokenIsToken0 ? swap.amount0 : swap.amount1;
  return tokenDelta < 0n ? 'buy' : 'sell';
}

export type MarketRow = {
  id: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hook: string;
  block: number;
  txHash: string;
  logIndex: number;
};

/** `Initialize(id, currency0, currency1 indexés ; fee, tickSpacing, hooks, sqrtPriceX96, tick)`. */
export function decodeInitialize(log: Log): MarketRow {
  return {
    id: (log.topics[1] ?? '').toLowerCase(),
    currency0: topicAddress(log.topics[2]),
    currency1: topicAddress(log.topics[3]),
    fee: Number(wordUint(log.data, 0)),
    tickSpacing: Number(wordInt(log.data, 1)),
    hook: wordAddress(log.data, 2),
    block: Number(log.blockNumber),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(log.logIndex),
  };
}
