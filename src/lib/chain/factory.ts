import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbiItem,
  type Address,
} from 'viem';
import type { RawLog } from './logs';
import { getLogsChunked, type GetLogsOptions } from './logs';
import type { RpcClient } from './rpc';

/**
 * `TokenLaunched` — ABI vérifiée en décodant un log réel (voir RESEARCH.md).
 * Les trois premiers paramètres sont indexés, les sept suivants occupent `data`.
 */
export const TOKEN_LAUNCHED = parseAbiItem(
  'event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)',
);

export const TOKEN_LAUNCHED_TOPIC =
  '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';

/**
 * The pons factories and the blocks where they launched tokens. Read off the
 * chain on 14/10/2026 by querying `TokenLaunched` on each of them:
 *
 * | factory   | launches | first block | last block  |
 * | --------- | -------- | ----------- | ----------- |
 * | `0xf4fc…` | 1,144    | 39,497,847  | 83,106,989  |
 * | `0xa24d…` | 183      | 12,278,587  | 86,025,151  |
 * | `0xa5aa…` | > 10,000 | 8,991,118   | ~38,650,000 |
 * | `0x0c37…` | 1,895    | 8,621,658   | 34,545,113  |
 *
 * `0xa5aa…` and `0x0c37…` are the two the pons docs list; they stopped
 * launching, so they get an upper bound. The two others are still open-ended.
 * Bounding each factory to its own range is what makes the whole history fit
 * in one batched request (19 windows of 10 M blocks).
 *
 * The launchpad has moved before — hard-coding the docs address is what broke
 * the first version — so a new generation must be added here.
 */
export type FactoryRange = {
  address: Address;
  fromBlock: number;
  toBlock?: number;
  /** Answers `getLaunchedToken(token)` with the layout the pons docs give. */
  getter: boolean;
};

export const PONS_FACTORIES: readonly FactoryRange[] = [
  { address: '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75', fromBlock: 39_000_000, getter: true },
  // Same event, but `getLaunchedToken` returns another layout and
  // `graduationStatus` does not answer: probably a fork of the launchpad.
  { address: '0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe', fromBlock: 12_000_000, getter: false },
  {
    address: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb',
    fromBlock: 8_991_118,
    toBlock: 40_000_000,
    getter: true,
  },
  {
    address: '0x0c37a24f5d23a486fa692d1500881d698b1f77a4',
    fromBlock: 8_600_612,
    toBlock: 35_000_000,
    getter: true,
  },
];

/** `getLaunchedToken(address)`, as documented by pons. Verified on `0xf4fc…` on 14/10/2026. */
export const GET_LAUNCHED_TOKEN = parseAbiItem(
  'function getLaunchedToken(address token) view returns ((address token, address deployer, address pairedToken, address positionManager, uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount) launched)',
);

/** `liquidityPool()` on a pons token. */
export const LIQUIDITY_POOL_SELECTOR = '0x665a11ca';

export function encodeGetLaunchedToken(token: Address): string {
  return encodeFunctionData({
    abi: [GET_LAUNCHED_TOKEN],
    functionName: 'getLaunchedToken',
    args: [token],
  });
}

export type LaunchedTokenInfo = {
  deployer: Address;
  /** The NFT position manager holding the launch liquidity, and the position's id in it. */
  positionManager: Address;
  positionId: bigint;
  pairedToken: Address;
  exists: boolean;
  initialBuyAmount: bigint;
};

/** `null` when the answer is empty, reverted, or laid out differently. */
export function decodeGetLaunchedToken(raw: string): LaunchedTokenInfo | null {
  if (!raw || raw === '0x') return null;
  try {
    return decodeFunctionResult({
      abi: [GET_LAUNCHED_TOKEN],
      functionName: 'getLaunchedToken',
      data: raw as `0x${string}`,
    }) as unknown as LaunchedTokenInfo;
  } catch {
    return null;
  }
}

/** A 32-byte word holding an address; `null` for zero or garbage. */
export function wordToAddress(raw: string): Address | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-f]{64}$/i.test(raw)) return null;
  if (BigInt(raw) === 0n) return null;
  return `0x${raw.slice(-40)}` as Address;
}

export type TokenLaunch = {
  token: Address;
  deployer: Address;
  dexFactory: Address;
  pairToken: Address;
  pool: Address;
  /** The launch liquidity's position in the DEX's position manager. */
  positionId: bigint;
  initialBuyAmount: bigint;
  blockNumber: number;
  factory: Address;
  transactionHash: string;
};

export function decodeTokenLaunched(log: RawLog): TokenLaunch {
  const decoded = decodeEventLog({
    abi: [TOKEN_LAUNCHED],
    data: log.data as `0x${string}`,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });
  const args = decoded.args as unknown as {
    token: Address;
    deployer: Address;
    dexFactory: Address;
    pairToken: Address;
    pool: Address;
    positionId: bigint;
    initialBuyAmount: bigint;
  };
  return {
    token: args.token,
    deployer: args.deployer,
    dexFactory: args.dexFactory,
    pairToken: args.pairToken,
    pool: args.pool,
    positionId: args.positionId,
    initialBuyAmount: args.initialBuyAmount,
    blockNumber: Number(log.blockNumber),
    factory: log.address as Address,
    transactionHash: log.transactionHash,
  };
}

/**
 * Découvre l'adresse du factory en interrogeant la chaîne, sans filtre d'adresse.
 *
 * Indispensable : la documentation pons annonce un factory « actif » qui revert,
 * et au moins quatre générations ont du bytecode déployé. Coder l'adresse en dur
 * revient à casser le produit au prochain déploiement du launchpad.
 */
export async function discoverActiveFactories(
  rpc: RpcClient,
  latestBlock: number,
  lookbackBlocks = 500_000,
  options: Partial<GetLogsOptions> = {},
): Promise<{ factories: Address[]; counts: Record<string, number> }> {
  const { logs } = await getLogsChunked(
    rpc,
    { topics: [TOKEN_LAUNCHED_TOPIC] },
    {
      fromBlock: Math.max(0, latestBlock - lookbackBlocks),
      toBlock: latestBlock,
      ...options,
    },
  );

  const counts: Record<string, number> = {};
  for (const log of logs) {
    const address = log.address.toLowerCase();
    counts[address] = (counts[address] ?? 0) + 1;
  }

  // Le plus actif en premier : c'est celui qui sert réellement.
  const factories = Object.keys(counts).sort(
    (a, b) => (counts[b] ?? 0) - (counts[a] ?? 0),
  ) as Address[];

  return { factories, counts };
}
