import type { Address } from 'viem';
import { CREATOR_SENDS_LISTED, type CreatorSends } from '../contracts/creator';
import { getLogsBatched, type RawLog } from './logs';
import { POOL_MANAGER } from './pools';
import type { RpcClient } from './rpc';
import { findRoutedSales, readTxNatures, SWAP_TOPICS } from './trades';

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

const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

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
 * pool** dans une transaction où le pool a réellement échangé (`Swap`). Un
 * transfert vers le pool sans échange est un apport de liquidité : le compter
 * comme une vente accusait un créateur d'avoir vendu alors qu'il approvisionnait
 * son marché.
 *
 * One batched request covers every token of the creator, then one batch of
 * receipts for the transfers into a pool.
 */
export async function detectCreatorSales(
  rpc: RpcClient,
  creator: Address,
  tokens: readonly BehaviorTarget[],
  window: BehaviorWindow,
  /** Filled with the creator's transfers read, for a caller that counts their recipients. */
  read?: { logs: RawLog[]; truncated: boolean },
  /** The analysed token: its routed transactions are read first. */
  focus?: string,
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
  if (read) {
    read.logs = logs;
    read.truncated = truncated;
  }

  const poolOf = new Map(tokens.map((t) => [t.token.toLowerCase(), t.pool.toLowerCase()]));
  // Vers le pool = vente possible. Vers un autre wallet = simple transfert,
  // ambigu — or a sale routed through a router, which the receipt tells.
  const intoPool = new Map<string, string[]>();
  const elsewhere: { token: string; to: string; hash: string }[] = [];
  for (const log of logs) {
    const token = log.address.toLowerCase();
    const to = addressFromTopic(log.topics[2]);
    if (to !== poolOf.get(token)) {
      if (to && !BURN.has(to)) elsewhere.push({ token, to, hash: log.transactionHash });
      continue;
    }
    intoPool.set(token, [...(intoPool.get(token) ?? []), log.transactionHash]);
  }

  const pools = new Set([...poolOf.values(), POOL_MANAGER.toLowerCase()]);
  const marketsOf = (token: string): ReadonlySet<string> =>
    new Set([poolOf.get(token) ?? '', POOL_MANAGER.toLowerCase()].filter(Boolean));
  const [natures, routed] = await Promise.all([
    intoPool.size > 0
      ? readTxNatures(rpc, [...intoPool.values()].flat(), pools).catch(
          () => new Map<string, never>(),
        )
      : Promise.resolve(new Map<string, never>()),
    findRoutedSales(rpc, creator, elsewhere, marketsOf, SWAP_TOPICS, focus),
  ]);
  for (const [token, hashes] of intoPool) {
    const read = hashes.map((h) => natures.get(h));
    if (read.includes('swap')) result.set(token, true);
    // A transaction whose receipt was not read could have been a sale.
    else if (read.includes(undefined)) result.delete(token);
  }
  for (const token of routed) result.set(token, true);
  return unseenAsUnknown(result, truncated);
}

/** Vrai si ce log retire réellement de la liquidité : son premier mot est le montant. */
export function isRealLiquidityRemoval(log: RawLog): boolean {
  const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (data.length < 64) return false;
  // Premier mot de `data` : le montant de liquidité retiré.
  return BigInt(`0x${data.slice(0, 64)}`) > 0n;
}

/**
 * `DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`
 * — Uniswap V3 NonfungiblePositionManager.
 */
export const DECREASE_LIQUIDITY_TOPIC =
  '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';

/** The launch liquidity of one token: where it sits and over which blocks to watch it. */
export type LaunchPosition = {
  token: Address;
  positionManager: Address;
  positionId: bigint;
  fromBlock?: number;
  toBlock?: number;
};

/**
 * Détecte les retraits de la liquidité **du lancement**.
 *
 * Un `Burn` sur le pool ne suffit pas : n'importe qui peut y fournir de la
 * liquidité puis la retirer. Vérifié en direct sur le seul token gradué de
 * 0xf4fc : cinquante `Burn`, tous d'un tiers qui rééquilibrait ses positions,
 * alors que la position du lancement n'avait jamais bougé — et SEAL annonçait
 * « liquidité retirée ». Le signal retenu est donc un `DecreaseLiquidity` sur
 * la position du lancement elle-même, avec un montant non nul : `burn(0)` sert
 * seulement à comptabiliser des frais.
 *
 * One query per launch position, all in one batch.
 */
export async function detectLiquidityRemovals(
  rpc: RpcClient,
  positions: readonly LaunchPosition[],
  window: BehaviorWindow,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>(positions.map((p) => [p.token.toLowerCase(), false]));
  if (positions.length === 0) return result;

  // One query per position, each over its own window: this node caps a
  // filter listing several values in one topic position at 100,000 blocks.
  const hex = (n: number) => `0x${n.toString(16)}`;
  const queries = positions.map((p) => ({
    position: p,
    fromBlock: Math.max(window.fromBlock, p.fromBlock ?? window.fromBlock),
    toBlock: Math.min(window.toBlock, p.toBlock ?? window.toBlock),
  }));
  const outcomes = await rpc.callBatch<RawLog[]>(
    queries.map((q) => ({
      method: 'eth_getLogs',
      params: [
        {
          address: q.position.positionManager,
          topics: [DECREASE_LIQUIDITY_TOPIC, topicForId(q.position.positionId)],
          fromBlock: hex(q.fromBlock),
          toBlock: hex(q.toBlock),
        },
      ],
    })),
  );

  queries.forEach((q, i) => {
    const outcome = outcomes[i];
    if (!outcome?.ok || !Array.isArray(outcome.value)) {
      // Not read: unknown for this token, never "untouched".
      result.delete(q.position.token.toLowerCase());
      return;
    }
    const id = topicForId(q.position.positionId);
    for (const log of outcome.value) {
      if ((log.topics[1] ?? '').toLowerCase() !== id) continue;
      if (log.address.toLowerCase() !== q.position.positionManager.toLowerCase()) continue;
      if (isRealLiquidityRemoval(log)) result.set(q.position.token.toLowerCase(), true);
    }
  });
  return result;
}

function topicForId(id: bigint): string {
  return `0x${id.toString(16).padStart(64, '0')}`;
}

/**
 * The analysed token's own sales are read over its whole life: a creator who
 * sold on day 78 (ASTEROID, tx 0x765959…, a swap on the v4 PoolManager) was
 * reported as never having sold, the read stopping at day 11. It is one
 * token, so one address: 10 M-block windows, up to this many blocks (~140
 * days at 0.1 s a block). Beyond, the report says up to which day it read.
 */
export const OWN_SALES_MAX_BLOCKS = 120_000_000;

/** Seconds per block on Robinhood Chain, measured: only used when no time is known. */
const SECONDS_PER_BLOCK = 0.101;

/**
 * How long a sales window is, in days from the launch. With the launch time
 * and the time now, a window that reached the latest block is the token's
 * age; a shorter one is that age in proportion.
 */
export function salesWindowDays(input: {
  fromBlock: number;
  toBlock: number;
  latest: number;
  launchedAt: string | null;
  now: Date;
}): number | null {
  const span = Math.max(0, input.toBlock - input.fromBlock);
  const launched = input.launchedAt ? Date.parse(input.launchedAt) : NaN;
  if (Number.isFinite(launched) && input.latest > input.fromBlock) {
    const age = (input.now.getTime() - launched) / 86_400_000;
    return Math.max(0, Math.round((age * span) / (input.latest - input.fromBlock)));
  }
  return Math.round((span * SECONDS_PER_BLOCK) / 86_400);
}

/**
 * What the creator sent of `token` outside its markets, by recipient, and
 * what it burned. Read from the same transfers as its sales: no extra query.
 */
export function creatorSendsOf(
  logs: readonly RawLog[],
  token: string,
  creator: string,
  markets: ReadonlySet<string>,
): CreatorSends {
  const from = topicFor(creator);
  const sent = new Map<string, bigint>();
  let burned = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    if ((log.topics[1] ?? '').toLowerCase() !== from || log.topics.length !== 3) continue;
    const to = addressFromTopic(log.topics[2]);
    const raw = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
    if (!to || raw.length < 64) continue;
    const value = BigInt(`0x${raw.slice(0, 64)}`);
    if (value === 0n) continue;
    if (BURN.has(to)) burned += value;
    else if (!markets.has(to)) sent.set(to, (sent.get(to) ?? 0n) + value);
  }
  const recipients = [...sent.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, CREATOR_SENDS_LISTED)
    .map(([address, value]) => ({ address, value: value.toString() }));
  return { recipients, distinct: sent.size, burned: burned.toString() };
}

/** Distinct addresses `creator` sent the token to, outside the markets and burn addresses. */
export function distinctRecipients(
  logs: readonly RawLog[],
  token: string,
  creator: string,
  markets: ReadonlySet<string>,
): number {
  const from = topicFor(creator);
  const out = new Set<string>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    if ((log.topics[1] ?? '').toLowerCase() !== from) continue;
    const to = addressFromTopic(log.topics[2]);
    if (
      !to ||
      markets.has(to) ||
      /^0x0{40}$/.test(to) ||
      to === '0x000000000000000000000000000000000000dead'
    )
      continue;
    out.add(to);
  }
  return out.size;
}
