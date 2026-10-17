import { TtlCache } from '../cache';
import { BLOCKSCOUT_BASE } from '../holders/blockscout';
import { requestJson } from '../http';
import {
  classifyFunder,
  effectiveFunder,
  parseProfile,
  type FunderKind,
  type FunderProfile,
} from './funder-kind';
import type { RpcClient } from './rpc';

/**
 * Who first sent ETH to a wallet, read straight from Blockscout.
 *
 * The indexer reads every creator in the background, but a creator it has
 * not reached yet would leave the funding question unanswered on the first
 * analysis. Two calls answer it now: the wallet's normal and internal
 * transactions, oldest first; the first incoming transfer of value is the
 * funding.
 */

const CHAIN_ID = 4663;
/** The funding is almost always among the very first entries. */
const PAGE = 50;

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

export type FirstFunding = { funder: string; txHash: string; block: number };

export function accountListUrl(
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

/** The first incoming transfer of value in a list sorted by block. */
export function firstIncoming(wallet: string, list: readonly EtherscanTx[]): FirstFunding | null {
  const target = wallet.toLowerCase();
  for (const tx of list) {
    if (tx.isError === '1') continue;
    if ((tx.to ?? '').toLowerCase() !== target || !tx.from) continue;
    let value: bigint;
    try {
      value = BigInt(tx.value ?? '0');
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    return {
      funder: tx.from.toLowerCase(),
      txHash: (tx.hash ?? tx.transactionHash ?? '').toLowerCase(),
      block: Number(tx.blockNumber ?? 0),
    };
  }
  return null;
}

async function list(
  action: 'txlist' | 'txlistinternal',
  wallet: string,
  apiKey: string,
  base: string,
): Promise<EtherscanTx[]> {
  const body = await requestJson<EtherscanAnswer>(accountListUrl(action, wallet, apiKey, base), {
    source: 'blockscout',
    timeoutMs: 6_000,
    retries: 1,
  });
  if (Array.isArray(body.result)) return body.result;
  // "No transactions found" comes back as status 0 with an empty result.
  if (/no (internal )?transactions found/i.test(body.message ?? '')) return [];
  throw new Error(`blockscout: ${String(body.result ?? body.message ?? '').slice(0, 120)}`);
}

/**
 * The wallet's first funding, `null` when it never received value, and a
 * thrown error when Blockscout could not be read (the caller says "not
 * looked up" rather than "none").
 */
export async function findFirstFunding(
  wallet: string,
  apiKey: string,
  base = BLOCKSCOUT_BASE,
): Promise<FirstFunding | null> {
  const [normal, internal] = await Promise.all([
    list('txlist', wallet, apiKey, base),
    list('txlistinternal', wallet, apiKey, base),
  ]);
  const a = firstIncoming(wallet, normal);
  const b = firstIncoming(wallet, internal);
  if (a && b) return a.block <= b.block ? a : b;
  return a ?? b;
}

export function addressProfileUrl(
  address: string,
  apiKey: string,
  counters: boolean,
  base = BLOCKSCOUT_BASE,
): string {
  const url = new URL(
    `${base}/${CHAIN_ID}/api/v2/addresses/${address.toLowerCase()}${counters ? '/counters' : ''}`,
  );
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

/** A day: an address does not turn from a private wallet into an exchange overnight. */
export const PROFILE_TTL_MS = 24 * 60 * 60_000;

/** Profiles read on this instance; a failed read is not kept, so it is tried again. */
const profiles = new TtlCache<FunderProfile | null>({
  ttlMs: PROFILE_TTL_MS,
  maxEntries: 2_000,
  keep: (value) => value !== null,
});

/**
 * What Blockscout says of an address: contract or not, verified name, tags,
 * transaction count. `null` when it could not be read: the caller then says
 * "unknown", never "wallet".
 */
export async function readFunderProfile(
  address: string,
  apiKey: string,
  base = BLOCKSCOUT_BASE,
): Promise<FunderProfile | null> {
  const key = address.toLowerCase();
  const { value } = await profiles.resolve(key, async () => {
    try {
      const options = { source: 'blockscout' as const, timeoutMs: 6_000, retries: 1 };
      const [body, counters] = await Promise.all([
        requestJson<unknown>(addressProfileUrl(key, apiKey, false, base), options),
        requestJson<unknown>(addressProfileUrl(key, apiKey, true, base), options),
      ]);
      return parseProfile(key, body, counters);
    } catch {
      return null;
    }
  });
  return value;
}

export function resetFunderProfiles(): void {
  profiles.clear();
}

export type FundingClassification = {
  funderKind: FunderKind;
  funderName: string | null;
  funderTxCount: number | null;
  /** The sender behind a batch-sending tool, when the funding went through one. */
  origin?: string | null;
  originKind?: FunderKind | null;
  originTxCount?: number | null;
  /** The address to group by, and its kind. */
  effective: string | null;
  effectiveKind: FunderKind;
};

/**
 * What first funded a wallet: a service, a tool, a wallet, or unknown. For a
 * batch-sending tool, the sender of the funding transaction is read and
 * classified in turn, one level only.
 */
export async function classifyFunding(
  rpc: Pick<RpcClient, 'call'>,
  funding: { funder: string; txHash?: string | null },
  apiKey: string,
  base = BLOCKSCOUT_BASE,
): Promise<FundingClassification> {
  const profile = await readFunderProfile(funding.funder, apiKey, base);
  const funderKind = classifyFunder(profile);
  const own = {
    funderKind,
    funderName: profile?.name ?? null,
    funderTxCount: profile?.txCount ?? null,
  };
  if (funderKind !== 'tool') {
    return { ...own, effective: funding.funder.toLowerCase(), effectiveKind: funderKind };
  }
  let origin: string | null = null;
  if (funding.txHash) {
    const tx = await rpc
      .call<{ from?: string } | null>('eth_getTransactionByHash', [funding.txHash])
      .catch(() => null);
    origin = tx?.from?.toLowerCase() ?? null;
  }
  const sender = origin ? await readFunderProfile(origin, apiKey, base) : null;
  const originKind = origin ? classifyFunder(sender) : null;
  const { effective, kind } = effectiveFunder({
    funder: funding.funder,
    kind: funderKind,
    origin,
    originKind,
  });
  return {
    ...own,
    origin,
    originKind,
    originTxCount: sender?.txCount ?? null,
    effective,
    effectiveKind: kind,
  };
}
