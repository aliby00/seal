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

/** Where a field of a launch event sits: an indexed topic, or a 32-byte word of the data. */
export type EventField = { topic: 1 | 2 | 3 } | { word: number };

/**
 * A launchpad's launch event, as `LAUNCHPADS` in the application
 * (`src/lib/chain/launchpads.ts`, docs/launchpads.md): the same addresses,
 * topics and fields, copied because the indexer builds on its own. A test
 * checks the two lists agree.
 */
export type LaunchpadSource = FactoryRange & {
  id: string;
  topic0: string;
  token: EventField;
  creator: EventField;
  pool?: EventField;
};

/**
 * Les générations du launchpad pons, comme `PONS_FACTORIES` dans l'application.
 * Relevé le 17/10/2026 : 269 443 lancements en tout, dont plus de 268 000 sur
 * `0xa5aa…` entre les blocs 10 M et 40 M, plus 60 142 sur `0xd9ec…`, la
 * première génération (blocs 61 869 à 6 880 646).
 */
const pons = (address: string, fromBlock: number, toBlock?: number): LaunchpadSource => ({
  id: 'pons',
  address,
  topic0: TOKEN_LAUNCHED_TOPIC,
  token: { topic: 1 },
  creator: { topic: 2 },
  pool: { word: 1 },
  fromBlock,
  ...(toBlock !== undefined ? { toBlock } : {}),
});

/**
 * Every launchpad whose launch event names its creator. Doppler's Airlock is
 * left out: its `Create` does not name one, so it lists no creator's launches.
 */
export const LAUNCHPADS: readonly LaunchpadSource[] = [
  pons('0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75', 39_000_000),
  pons('0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe', 12_000_000),
  pons('0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', 8_991_118, 40_000_000),
  pons('0x0c37a24f5d23a486fa692d1500881d698b1f77a4', 8_600_612, 35_000_000),
  pons('0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb', 61_869, 7_000_000),
  // 373 159 lancements au 17/10/2026, rien d'indexé : le créateur est le
  // deuxième mot des données, le token le quatrième.
  {
    id: 'flap',
    address: '0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09',
    topic0: '0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603',
    token: { word: 3 },
    creator: { word: 1 },
    fromBlock: 4_200_000,
  },
  {
    id: 'curve-7ed5',
    address: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
    topic0: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
    token: { topic: 1 },
    creator: { topic: 3 },
    fromBlock: 27_000_000,
  },
  // Son routeur : 459 887 lancements, le portefeuille appelant en topic 3.
  {
    id: 'curve-7ed5',
    address: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
    topic0: '0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37',
    token: { topic: 1 },
    creator: { topic: 3 },
    fromBlock: 27_000_000,
  },
  {
    id: 'curve-3d6e',
    address: '0x3d6ea4e97b8ab9e1a1b4943febffe22d8c920091',
    topic0: '0xa0354dae199953f2dbde6be8415166a744e7f92b7328671692196d8fdbb6bd9d',
    token: { topic: 1 },
    creator: { topic: 3 },
    fromBlock: 88_500_000,
  },
  {
    id: 'v4-f05a',
    address: '0xf05a26e92e27b8f0385f6895f5507db26a2f4b8d',
    topic0: '0x8f9d1d4b2dfe54f1d49ec1d5b6a7b5bc380b5fac115339c49e671127d1481c69',
    token: { topic: 1 },
    creator: { topic: 2 },
    fromBlock: 87_700_000,
  },
  {
    id: 'doppler-22e9',
    address: '0x22e99278308b393ea1260859b181ad7e78f5eeed',
    topic0: '0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b',
    token: { topic: 1 },
    creator: { word: 1 },
    fromBlock: 8_600_000,
    toBlock: 60_000_000,
  },
  {
    id: 'metricpad',
    address: '0xd8e6fda8639b53c63ffe78eee5431d1af3c56c88',
    topic0: '0x14ab72c95fd9b13db14c65da0cd02173bfd0aea9005b9ed422810bb985b5942e',
    token: { topic: 2 },
    creator: { topic: 1 },
    pool: { topic: 3 },
    fromBlock: 89_500_000,
  },
  // Virtuals : 26 185 lancements au 18/10/2026. Son launchpad (`0xd4cc…`) ne
  // nomme pas le créateur ; son gestionnaire de taxe, dans la même
  // transaction, émet `TokenRegistered(token, creator, …)`, les deux indexés.
  {
    id: 'virtuals',
    address: '0x6d80b81d9fc56a7a839b1af9006eb49151961ce7',
    topic0: '0x8c768b5da89e637b23caac626ccd760ef89b9e8eaa2f45bbf8c9d68e231dabef',
    token: { topic: 1 },
    creator: { topic: 2 },
    fromBlock: 220_000,
  },
];

export const PONS_FACTORIES: readonly FactoryRange[] = LAUNCHPADS.filter((l) => l.id === 'pons');

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
  /** Launchpad id: `pons` for every row read before launchpads existed. */
  launchpad?: string;
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

function fieldWord(log: Log, field: EventField): string {
  if ('topic' in field) return (log.topics[field.topic] ?? '').slice(2);
  return word(log.data, field.word);
}

function fieldAddress(log: Log, field: EventField): string {
  const raw = fieldWord(log, field);
  return raw.length === 64 ? `0x${raw.slice(24)}`.toLowerCase() : '';
}

/**
 * Any launchpad's launch event, as a launch row. pons keeps its full reading
 * (pool, pair token, position); the others carry what their event says — the
 * curve or pool when it is named — and leave the pons-only columns empty.
 */
export function decodeLaunchOf(source: LaunchpadSource, log: Log): LaunchRow | null {
  if (source.id === 'pons') return { ...decodeLaunch(log), launchpad: 'pons' };
  const token = fieldAddress(log, source.token);
  const creator = fieldAddress(log, source.creator);
  if (!/^0x[0-9a-f]{40}$/.test(token) || !/^0x[0-9a-f]{40}$/.test(creator)) return null;
  return {
    launchpad: source.id,
    token,
    creator,
    dexFactory: '',
    pairToken: '',
    pool: source.pool ? fieldAddress(log, source.pool) : '',
    positionId: '0',
    initialBuyAmount: '0',
    factory: log.address.toLowerCase(),
    block: Number(log.blockNumber),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(log.logIndex),
  };
}
