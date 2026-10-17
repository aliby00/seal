import type { Db, FundingInsert } from '../db.ts';
import type { Logger, Stream } from '../loop.ts';

/**
 * Qui a envoyé le premier ETH au portefeuille d'un créateur.
 *
 * Par l'API PRO Blockscout (la clé passe en paramètre `apikey`, comme dans
 * `src/lib/holders/blockscout.ts`), au format compatible Etherscan : les
 * transactions normales et internes de l'adresse, dans l'ordre croissant. Le
 * premier transfert entrant de valeur non nulle, des deux listes, est le
 * financement. RPC seul, il faudrait relire toute la chaîne.
 *
 * Tier gratuit : 5 req/s et 100 000 crédits/jour. On reste à 2 req/s, les
 * créateurs les plus récents d'abord ; un créateur demandé par l'API passe
 * devant.
 */
export const BLOCKSCOUT_BASE = 'https://api.blockscout.com';
export const CHAIN_ID = 4663;
/** Entrées lues par liste : le financement est presque toujours parmi les toutes premières. */
const PAGE = 50;
const MIN_GAP_MS = 500;
const RETRY_LATER_MS = 10 * 60_000;

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

class TransientError extends Error {}

/** Le premier versement entrant de valeur, parmi une liste triée par bloc. */
export function firstIncoming(
  creator: string,
  list: readonly EtherscanTx[],
): { from: string; txHash: string; block: number } | null {
  for (const tx of list) {
    if (tx.isError === '1') continue;
    if ((tx.to ?? '').toLowerCase() !== creator) continue;
    let value: bigint;
    try {
      value = BigInt(tx.value ?? '0');
    } catch {
      continue;
    }
    if (value <= 0n || !tx.from) continue;
    return {
      from: tx.from.toLowerCase(),
      txHash: (tx.hash ?? tx.transactionHash ?? '').toLowerCase(),
      block: Number(tx.blockNumber ?? 0),
    };
  }
  return null;
}

export function fundingStream(deps: {
  db: Db;
  apiKey: string;
  log: Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  base?: string;
}): Stream & { prioritize(creator: string): void } {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const urgent = new Set<string>();
  const retryAt = new Map<string, number>();
  let last = 0;
  const pick = deps.db.raw.prepare(
    `SELECT creator FROM launches l
     WHERE NOT EXISTS (SELECT 1 FROM funding f WHERE f.creator = l.creator)
     ORDER BY block DESC LIMIT 200`,
  );

  async function list(
    action: 'txlist' | 'txlistinternal',
    address: string,
  ): Promise<EtherscanTx[]> {
    let wait = 1_000;
    for (let attempt = 1; ; attempt += 1) {
      const gap = last + MIN_GAP_MS - now();
      if (gap > 0) await sleep(gap);
      last = now();
      try {
        const response = await doFetch(accountUrl(action, address, deps.apiKey, deps.base), {
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 429 || response.status >= 500) {
          throw new TransientError(`blockscout HTTP ${response.status}`);
        }
        if (!response.ok) throw new Error(`blockscout HTTP ${response.status}`);
        const body = (await response.json()) as EtherscanAnswer;
        if (Array.isArray(body.result)) return body.result;
        // Etherscan says "no transactions" with status 0 and an empty result.
        if (/no (internal )?transactions found/i.test(body.message ?? '')) return [];
        const message = typeof body.result === 'string' ? body.result : (body.message ?? '');
        if (/rate limit|too many/i.test(message)) throw new TransientError(message);
        throw new Error(`blockscout: ${message.slice(0, 120)}`);
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

  async function resolve(creator: string): Promise<FundingInsert> {
    const normal = firstIncoming(creator, await list('txlist', creator));
    const internal = firstIncoming(creator, await list('txlistinternal', creator));
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

  function next(): string[] {
    const t = now();
    const ready = (c: string) => (retryAt.get(c) ?? 0) <= t;
    const first = [...urgent].filter(ready);
    if (first.length > 0) return first.slice(0, 10);
    const rows = pick.all() as { creator: string }[];
    return [...new Set(rows.map((r) => r.creator))].filter(ready).slice(0, 10);
  }

  return {
    name: 'funding',
    prioritize(creator: string) {
      urgent.add(creator.toLowerCase());
    },
    async step() {
      const batch = next();
      if (batch.length === 0) return false;
      const started = now();
      let found = 0;
      let failed = 0;
      for (const creator of batch) {
        try {
          const row = await resolve(creator);
          deps.db.setFunding(row);
          if (row.status === 'found') found += 1;
          retryAt.delete(creator);
        } catch (error) {
          failed += 1;
          retryAt.set(creator, now() + RETRY_LATER_MS);
          deps.log('funding-error', { creator, error: String(error).slice(0, 200) });
        }
        urgent.delete(creator);
      }
      deps.log('batch', {
        stream: 'funding',
        creators: batch.length,
        found,
        failed,
        ms: now() - started,
      });
      return true;
    },
  };
}
