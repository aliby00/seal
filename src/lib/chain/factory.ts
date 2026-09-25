import { decodeEventLog, parseAbiItem, type Address } from 'viem';
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

export type TokenLaunch = {
  token: Address;
  deployer: Address;
  dexFactory: Address;
  pairToken: Address;
  pool: Address;
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
    initialBuyAmount: bigint;
  };
  return {
    token: args.token,
    deployer: args.deployer,
    dexFactory: args.dexFactory,
    pairToken: args.pairToken,
    pool: args.pool,
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
