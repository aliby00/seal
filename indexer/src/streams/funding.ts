import type { Db, FundingInsert } from '../db.ts';
import { classifyFunder, parseProfile, type FunderProfile } from '../funder-kind.ts';
import type { Logger, Stream } from '../loop.ts';
import type { Rpc } from '../rpc.ts';

/**
 * Qui a envoyé le premier ETH au portefeuille d'un créateur.
 *
 * Par l'API PRO Blockscout (la clé passe en paramètre `apikey`, comme dans
 * `src/lib/holders/blockscout.ts`), au format compatible Etherscan : les
 * transactions normales et internes de l'adresse, dans l'ordre croissant. Le
 * premier transfert entrant de valeur non nulle, des deux listes, est le
 * financement. RPC seul, il faudrait relire toute la chaîne.
 *
 * Tier gratuit : 5 req/s et 100 000 crédits/jour, PARTAGÉS avec le site (la
 * carte des détenteurs passe par la même clé). Relire les ~92 000 créateurs à
 * 2 req/s épuisait ce quota en moins d'une heure et faisait tomber le site :
 * les appels sont donc plafonnés par jour (`dailyCalls`) et étalés sur la
 * journée. Les créateurs les plus récents d'abord ; un créateur demandé par
 * l'API passe devant, sans attendre l'étalement, mais dans le même plafond.
 *
 * Le même flux profile les financeurs (API v2 : contrat ou non, nom vérifié,
 * nombre de transactions), dans le même plafond : un exchange qui a financé
 * cent créateurs ne les relie pas entre eux. Les plus utilisés d'abord,
 * relus après 30 jours. Quand le financeur est un outil d'envoi groupé,
 * l'expéditeur de la transaction (lu par le RPC, hors plafond) est le vrai
 * financeur.
 */
export const BLOCKSCOUT_BASE = 'https://api.blockscout.com';
export const CHAIN_ID = 4663;
/** Entrées lues par liste : le financement est presque toujours parmi les toutes premières. */
const PAGE = 50;
const MIN_GAP_MS = 500;
const RETRY_LATER_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** Normal and internal transactions for a creator; address and counters for a funder. */
const CALLS_PER_CREATOR = 2;
/** A profile is read again after this long: a wallet can become a busy one. */
export const PROFILE_MAX_AGE_MS = 30 * DAY_MS;
/** Senders behind a batch-sending tool are read by the RPC: paced apart from Blockscout. */
const ORIGIN_GAP_MS = 2_000;
/** ~20 credits a call: 2,000 calls leave most of the 100,000 daily credits to the site. */
export const DEFAULT_DAILY_CALLS = 2_000;

type EtherscanTx = {
  blockNumber?: string;
  hash?: string;
  transactionHash?: string;
  from?: string;
  to?: string;
  value?: string;
  isError?: string;
};

type EtherscanAnswer = { status?: string; message?: string; result?: EtherscanTx[] | string };

export function accountUrl(
  action: 'txlist' | 'txlistinternal',
  address: string,
  apiKey: string,
  base = BLOCKSCOUT_BASE,
): string {
  const url = new URL(`${base}/${CHAIN_ID}/api`);
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', action);
  url.searchParams.set('address', address);
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('page', '1');
  url.searchParams.set('offset', String(PAGE));
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

export function addressUrl(
  address: string,
  apiKey: string,
  counters: boolean,
  base = BLOCKSCOUT_BASE,
): string {
  const url = new URL(
    `${base}/${CHAIN_ID}/api/v2/addresses/${address}${counters ? '/counters' : ''}`,
  );
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

class TransientError extends Error {}

/**
 * WETH on Robinhood Chain (`symbol()` = WETH, src/lib/chain/pools.ts). ETH it
 * sends in an internal transfer is an unwrap: never a first funding.
 */
export const WRAPPED_NATIVE: readonly string[] = ['0x0bd7d308f8e1639fab988df18a8011f41eacad73'];

/** Hashes of the transactions `creator` sent, from its normal transaction list. */
export function sentBy(creator: string, list: readonly EtherscanTx[]): Set<string> {
  return new Set(
    list
      .filter((tx) => (tx.from ?? '').toLowerCase() === creator)
      .map((tx) => (tx.hash ?? tx.transactionHash ?? '').toLowerCase())
      .filter((hash) => hash !== ''),
  );
}

/**
 * Le premier versement entrant de valeur, parmi une liste triée par bloc.
 * Value received inside a transaction the creator sent itself (an unwrap, a
 * sale paid in ETH) is skipped: it needed gas to send it, so it was funded
 * before. So is ETH sent by WETH: the creator unwrapping its own.
 */
export function firstIncoming(
  creator: string,
  list: readonly EtherscanTx[],
  ownTransactions: ReadonlySet<string> = new Set(),
): { from: string; txHash: string; block: number } | null {
  for (const tx of list) {
    if (tx.isError === '1') continue;
    if ((tx.to ?? '').toLowerCase() !== creator) continue;
    if (tx.from && WRAPPED_NATIVE.includes(tx.from.toLowerCase())) continue;
    const hash = (tx.hash ?? tx.transactionHash ?? '').toLowerCase();
    if (hash && ownTransactions.has(hash)) continue;
    let value: bigint;
    try {
      value = BigInt(tx.value ?? '0');
    } catch {
      continue;
    }
    if (value <= 0n || !tx.from) continue;
    return {
      from: tx.from.toLowerCase(),
      txHash: hash,
      block: Number(tx.blockNumber ?? 0),
    };
  }
  return null;
}

type Task =
  | { type: 'funding'; address: string }
  | { type: 'profile'; address: string }
  | { type: 'origin'; creator: string; txHash: string };

const keyOf = (t: Task): string =>
  t.type === 'origin' ? `origin:${t.creator}` : `${t.type}:${t.address}`;

export function fundingStream(deps: {
  db: Db;
  apiKey: string;
  log: Logger;
  /** Reads the sender of a funding sent through a batch-sending tool. */
  rpc?: Pick<Rpc, 'call'>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  base?: string;
  /** Appels Blockscout permis par jour UTC, file prioritaire comprise. */
  dailyCalls?: number;
}): Stream & {
  prioritize(creator: string): void;
  prioritizeProfile(address: string): void;
  prioritizeOrigin(creator: string): void;
  usage(): { callsToday: number; dailyCalls: number };
} {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const urgent = new Set<string>();
  const urgentProfiles = new Set<string>();
  const urgentOrigins = new Set<string>();
  const retryAt = new Map<string, number>();
  let last = 0;
  const dailyCalls = deps.dailyCalls ?? DEFAULT_DAILY_CALLS;
  // Background reads spread over the day instead of spending the budget at midnight.
  const spreadMs = Math.max(MIN_GAP_MS, Math.floor(DAY_MS / dailyCalls) * CALLS_PER_CREATOR);
  let day = -1;
  let callsToday = 0;
  let lastBackground = -Infinity;
  let lastOrigin = -Infinity;
  // Background turns alternate: new creators, then the most-used funders.
  let profileTurn = true;
  /** Two calls per item: room for both, or none started. */
  function budgetLeft(): boolean {
    const today = Math.floor(now() / DAY_MS);
    if (today !== day) {
      day = today;
      callsToday = 0;
    }
    return callsToday + CALLS_PER_CREATOR <= dailyCalls;
  }
  const pick = deps.db.raw.prepare(
    // A funding stored as an internal transfer from WETH predates the rule
    // that an unwrap is never a funding: it is read again.
    `SELECT creator FROM launches l
     WHERE NOT EXISTS (
       SELECT 1 FROM funding f WHERE f.creator = l.creator
         AND NOT (f.kind = 'internal' AND f.funder IN (${WRAPPED_NATIVE.map((a) => `'${a}'`).join(', ')}))
     )
     ORDER BY block DESC LIMIT 200`,
  );
  // Funders (and senders behind tools) never profiled, or profiled too long
  // ago; the ones that funded the most first.
  const pickProfiles = deps.db.raw.prepare(
    `SELECT a.addr AS address FROM (
       SELECT funder AS addr FROM funding WHERE status = 'found' AND funder IS NOT NULL
       UNION ALL
       SELECT origin AS addr FROM funding WHERE origin IS NOT NULL
     ) a LEFT JOIN funders p ON p.address = a.addr
     WHERE p.address IS NULL OR p.checked_at < ?
     GROUP BY a.addr
     ORDER BY MAX(p.address IS NULL) DESC, COUNT(*) DESC
     LIMIT 50`,
  );
  const pickOrigins = deps.db.raw.prepare(
    `SELECT f.creator, f.tx_hash FROM funding f JOIN funders p ON p.address = f.funder
     WHERE p.kind = 'tool' AND f.status = 'found' AND f.origin IS NULL AND f.tx_hash IS NOT NULL
     LIMIT 50`,
  );

  async function get(url: string, label: string): Promise<unknown> {
    let wait = 1_000;
    for (let attempt = 1; ; attempt += 1) {
      const gap = last + MIN_GAP_MS - now();
      if (gap > 0) await sleep(gap);
      last = now();
      callsToday += 1;
      try {
        const response = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
        if (response.status === 429 || response.status >= 500) {
          throw new TransientError(`blockscout HTTP ${response.status}`);
        }
        if (!response.ok) throw new Error(`blockscout ${label} HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        const transient =
          error instanceof TransientError ||
          (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'TypeError'));
        if (!transient || attempt >= 5) throw error;
        await sleep(wait);
        wait *= 2;
      }
    }
  }

  async function list(
    action: 'txlist' | 'txlistinternal',
    address: string,
  ): Promise<EtherscanTx[]> {
    const body = (await get(
      accountUrl(action, address, deps.apiKey, deps.base),
      action,
    )) as EtherscanAnswer;
    if (Array.isArray(body.result)) return body.result;
    // Etherscan says "no transactions" with status 0 and an empty result.
    if (/no (internal )?transactions found/i.test(body.message ?? '')) return [];
    const message = typeof body.result === 'string' ? body.result : (body.message ?? '');
    if (/rate limit|too many/i.test(message)) throw new TransientError(message);
    throw new Error(`blockscout: ${message.slice(0, 120)}`);
  }

  async function resolve(creator: string): Promise<FundingInsert> {
    const sent = await list('txlist', creator);
    const normal = firstIncoming(creator, sent);
    const internal = firstIncoming(
      creator,
      await list('txlistinternal', creator),
      sentBy(creator, sent),
    );
    const first =
      normal && internal
        ? normal.block <= internal.block
          ? { ...normal, kind: 'tx' as const }
          : { ...internal, kind: 'internal' as const }
        : normal
          ? { ...normal, kind: 'tx' as const }
          : internal
            ? { ...internal, kind: 'internal' as const }
            : null;
    return first
      ? {
          creator,
          status: 'found',
          funder: first.from,
          txHash: first.txHash,
          block: first.block,
          kind: first.kind,
        }
      : { creator, status: 'none', funder: null, txHash: null, block: null, kind: null };
  }

  async function profile(address: string): Promise<FunderProfile> {
    const body = await get(addressUrl(address, deps.apiKey, false, deps.base), 'address');
    const counters = await get(addressUrl(address, deps.apiKey, true, deps.base), 'counters');
    const parsed = parseProfile(address, body, counters);
    if (!parsed || parsed.txCount === null) throw new Error('blockscout: unreadable profile');
    // Blockscout flags a wallet delegating under EIP-7702 as a contract, and
    // a contract is a service: its code says whether it is a delegation.
    if (parsed.isContract && deps.rpc) {
      const code = await deps.rpc
        .call<string>('eth_getCode', [address, 'latest'])
        .catch(() => null);
      if (typeof code === 'string' && code.toLowerCase().startsWith('0xef0100')) {
        return { ...parsed, isContract: false };
      }
    }
    return parsed;
  }

  async function origin(txHash: string): Promise<string> {
    if (!deps.rpc) throw new Error('no rpc client');
    const tx = await deps.rpc.call<{ from?: string } | null>('eth_getTransactionByHash', [txHash]);
    if (!tx?.from) throw new Error('transaction not found');
    return tx.from.toLowerCase();
  }

  function next(): Task | null {
    const t = now();
    const ready = (task: Task) => (retryAt.get(keyOf(task)) ?? 0) <= t;
    const budget = budgetLeft();
    if (budget) {
      for (const address of urgent) {
        const task: Task = { type: 'funding', address };
        if (ready(task)) return task;
      }
      for (const address of urgentProfiles) {
        const task: Task = { type: 'profile', address };
        if (ready(task)) return task;
      }
    }
    if (deps.rpc) {
      for (const creator of urgentOrigins) {
        const row = deps.db.funding(creator);
        if (!row?.tx_hash || row.origin) {
          urgentOrigins.delete(creator);
          continue;
        }
        const task: Task = { type: 'origin', creator, txHash: row.tx_hash };
        if (ready(task)) return task;
      }
      if (t - lastOrigin >= ORIGIN_GAP_MS) {
        const rows = pickOrigins.all() as { creator: string; tx_hash: string }[];
        const task = rows
          .map((r): Task => ({ type: 'origin', creator: r.creator, txHash: r.tx_hash }))
          .find(ready);
        if (task) {
          lastOrigin = t;
          return task;
        }
      }
    }
    if (!budget || t - lastBackground < spreadMs) return null;
    const creators = (): Task | undefined =>
      [...new Set((pick.all() as { creator: string }[]).map((r) => r.creator))]
        .map((address): Task => ({ type: 'funding', address }))
        .find(ready);
    const profiles = (): Task | undefined =>
      (pickProfiles.all(t - PROFILE_MAX_AGE_MS) as { address: string }[])
        .map((r): Task => ({ type: 'profile', address: r.address }))
        .find(ready);
    const task = profileTurn ? (profiles() ?? creators()) : (creators() ?? profiles());
    if (task) {
      lastBackground = t;
      profileTurn = !profileTurn;
    }
    return task ?? null;
  }

  async function run(task: Task): Promise<string> {
    if (task.type === 'funding') {
      const row = await resolve(task.address);
      deps.db.setFunding(row);
      return row.status;
    }
    if (task.type === 'profile') {
      const read = await profile(task.address);
      const kind = classifyFunder(read);
      deps.db.setFunder(read, kind);
      return kind;
    }
    deps.db.setOrigin(task.creator, await origin(task.txHash));
    return 'origin';
  }

  return {
    name: 'funding',
    prioritize(creator: string) {
      urgent.add(creator.toLowerCase());
    },
    prioritizeProfile(address: string) {
      urgentProfiles.add(address.toLowerCase());
    },
    prioritizeOrigin(creator: string) {
      urgentOrigins.add(creator.toLowerCase());
    },
    usage() {
      budgetLeft();
      return { callsToday, dailyCalls };
    },
    async step() {
      const task = next();
      if (!task) return false;
      const started = now();
      let outcome = 'failed';
      try {
        outcome = await run(task);
        retryAt.delete(keyOf(task));
      } catch (error) {
        retryAt.set(keyOf(task), now() + RETRY_LATER_MS);
        deps.log('funding-error', {
          task: task.type,
          address: task.type === 'origin' ? task.creator : task.address,
          error: String(error).slice(0, 200),
        });
      }
      if (task.type === 'funding') urgent.delete(task.address);
      if (task.type === 'profile') urgentProfiles.delete(task.address);
      if (task.type === 'origin') urgentOrigins.delete(task.creator);
      deps.log('batch', { stream: 'funding', task: task.type, outcome, ms: now() - started });
      return true;
    },
  };
}
