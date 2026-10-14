import type { Address } from 'viem';
import { getLogsBatched, type RawLog } from './logs';
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

/**
 * When some windows could not be read, "nothing seen" is not "nothing
 * happened": those tokens are dropped, which the caller reports as `null`.
 * A positive stays — it was observed.
 */
function unseenAsUnknown(result: Map<string, boolean>, truncated: boolean): Map<string, boolean> {
  if (!truncated) return result;
  return new Map([...result].filter(([, seen]) => seen));
}

export type BehaviorWindow = { fromBlock: number; toBlock: number };

/** A token to watch, optionally over its own range (its first days after launch). */
export type BehaviorTarget = {
  token: Address;
  pool: Address;
  fromBlock?: number;
  toBlock?: number;
};

/**
 * Détecte les ventes du créateur.
 *
 * Un `Transfer` sortant du deployer ne suffit pas : envoyer ses tokens vers un
 * autre wallet n'est pas une vente. Le signal retenu est un transfert **vers le
 * pool**, ce qui correspond à un swap — c'est-à-dire une vente effective.
 *
 * One batched request covers every token of the creator.
 */
export async function detectCreatorSales(
  rpc: RpcClient,
  creator: Address,
  tokens: readonly BehaviorTarget[],
  window: BehaviorWindow,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>(tokens.map((t) => [t.token.toLowerCase(), false]));
  if (tokens.length === 0) return result;

  // One query per token: a list of addresses caps the window at 100,000 blocks.
  const { logs, truncated } = await getLogsBatched(
    rpc,
    {
      addresses: tokens.map((t) => ({
        address: t.token,
        fromBlock: t.fromBlock,
        toBlock: t.toBlock,
      })),
      topics: [TRANSFER_TOPIC, topicFor(creator)],
    },
    window,
  );

  const poolOf = new Map(tokens.map((t) => [t.token.toLowerCase(), t.pool.toLowerCase()]));
  for (const log of logs) {
    const token = log.address.toLowerCase();
    // Vers le pool = vente. Vers un autre wallet = simple transfert, ambigu.
    if (addressFromTopic(log.topics[2]) === poolOf.get(token)) result.set(token, true);
  }
  return unseenAsUnknown(result, truncated);
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
  tokens: readonly BehaviorTarget[],
  window: BehaviorWindow,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>(tokens.map((t) => [t.token.toLowerCase(), false]));
  const pools = tokens.filter((t) => t.pool && t.pool !== '0x');
  if (pools.length === 0) return result;

  const { logs, truncated } = await getLogsBatched(
    rpc,
    {
      addresses: pools.map((t) => ({
        address: t.pool,
        fromBlock: t.fromBlock,
        toBlock: t.toBlock,
      })),
      topics: [BURN_TOPIC],
    },
    window,
  );

  const tokenOfPool = new Map(pools.map((t) => [t.pool.toLowerCase(), t.token.toLowerCase()]));
  for (const log of logs) {
    if (!isRealLiquidityRemoval(log)) continue;
    const token = tokenOfPool.get(log.address.toLowerCase());
    if (token) result.set(token, true);
  }
  return unseenAsUnknown(result, truncated);
}
