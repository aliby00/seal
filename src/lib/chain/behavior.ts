import type { Address } from 'viem';
import { getLogsChunked, type RawLog } from './logs';
import type { RpcClient } from './rpc';

/**
 * Deux signaux de comportement que le whitepaper met en avant : le créateur
 * a-t-il vendu son allocation, et la liquidité a-t-elle été retirée.
 *
 * Les deux se lisent on-chain, mais aucun des deux ne se lit naïvement — et
 * c'est tout l'enjeu de ce module.
 */

/** `Transfer(address,address,uint256)` — standard ERC-20. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** `Burn(address,int24,int24,uint128,uint256,uint256)` — Uniswap V3 Pool. */
export const BURN_TOPIC = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c';

/** Une adresse padée à 32 octets, pour servir de filtre sur un topic indexé. */
export function topicFor(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

function addressFromTopic(topic: string | undefined): string {
  return topic ? `0x${topic.slice(26)}`.toLowerCase() : '';
}

export type BehaviorWindow = { fromBlock: number; toBlock: number };

/**
 * Détecte les ventes du créateur.
 *
 * Un `Transfer` sortant du deployer ne suffit pas : envoyer ses tokens vers un
 * autre wallet n'est pas une vente. Le signal retenu est un transfert **vers le
 * pool**, ce qui correspond à un swap — c'est-à-dire une vente effective.
 *
 * Une seule requête couvre tous les tokens du créateur : `eth_getLogs` accepte
 * une liste d'adresses.
 */
export async function detectCreatorSales(
  rpc: RpcClient,
  creator: Address,
  tokens: readonly { token: Address; pool: Address }[],
  window: BehaviorWindow,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>(tokens.map((t) => [t.token.toLowerCase(), false]));
  if (tokens.length === 0) return result;

  const { logs } = await getLogsChunked(
    rpc,
    {
      address: tokens.map((t) => t.token),
      topics: [TRANSFER_TOPIC, topicFor(creator)],
    },
    { fromBlock: window.fromBlock, toBlock: window.toBlock },
  );

  const poolOf = new Map(tokens.map((t) => [t.token.toLowerCase(), t.pool.toLowerCase()]));
  for (const log of logs) {
    const token = log.address.toLowerCase();
    // Vers le pool = vente. Vers un autre wallet = simple transfert, ambigu.
    if (addressFromTopic(log.topics[2]) === poolOf.get(token)) result.set(token, true);
  }
  return result;
}

/** Vrai si ce log `Burn` retire réellement de la liquidité. */
export function isRealLiquidityRemoval(log: RawLog): boolean {
  const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (data.length < 64) return false;
  // Premier mot de `data` : le montant de liquidité retiré.
  return BigInt(`0x${data.slice(0, 64)}`) > 0n;
}

/**
 * Détecte les retraits de liquidité.
 *
 * Piège vérifié en direct : sur Uniswap V3, `burn(0)` est le motif standard
 * pour déclencher la comptabilisation des frais avant un `collect`. Sur un
 * token réel, les trois events `Burn` observés avaient tous `liquidity = 0`.
 * Compter les events sans lire le montant aurait fait annoncer « liquidité
 * retirée trois fois » là où rien n'avait été retiré.
 *
 * Le WETH sortant du pool n'est pas non plus un signal : c'est ce qui se passe
 * à chaque vente, l'acheteur reçoit le WETH du pool.
 */
export async function detectLiquidityRemovals(
  rpc: RpcClient,
  tokens: readonly { token: Address; pool: Address }[],
  window: BehaviorWindow,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>(tokens.map((t) => [t.token.toLowerCase(), false]));
  const pools = tokens.filter((t) => t.pool && t.pool !== '0x');
  if (pools.length === 0) return result;

  const { logs } = await getLogsChunked(
    rpc,
    { address: pools.map((t) => t.pool), topics: [BURN_TOPIC] },
    { fromBlock: window.fromBlock, toBlock: window.toBlock },
  );

  const tokenOfPool = new Map(pools.map((t) => [t.pool.toLowerCase(), t.token.toLowerCase()]));
  for (const log of logs) {
    if (!isRealLiquidityRemoval(log)) continue;
    const token = tokenOfPool.get(log.address.toLowerCase());
    if (token) result.set(token, true);
  }
  return result;
}
