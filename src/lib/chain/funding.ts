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
import { isDelegatedWallet } from './code';
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
  input?: string;
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

/**
 * WETH on Robinhood Chain (pools.ts, `symbol()` = WETH). ETH it sends in an
 * internal transfer is an unwrap: the wallet already held it as WETH, so it
 * is never the wallet's first funding.
 */
export const WRAPPED_NATIVE: readonly string[] = ['0x0bd7d308f8e1639fab988df18a8011f41eacad73'];

export type IncomingFilter = {
  /**
   * Transactions the wallet sent itself. Value it receives inside one of them
   * (an unwrap, a sale paid in ETH) was paid for with what it already had:
   * it needed gas to send it, so it was funded before.
   */
  ownTransactions?: ReadonlySet<string>;
};

/** Hashes of the transactions `wallet` sent, from its normal transaction list. */
export function sentBy(wallet: string, list: readonly EtherscanTx[]): Set<string> {
  const target = wallet.toLowerCase();
  return new Set(
    list
      .filter((tx) => (tx.from ?? '').toLowerCase() === target)
      .map((tx) => (tx.hash ?? tx.transactionHash ?? '').toLowerCase())
      .filter((hash) => hash !== ''),
  );
}

/** The first incoming transfer of value in a list sorted by block. */
export function firstIncoming(
  wallet: string,
  list: readonly EtherscanTx[],
  filter: IncomingFilter = {},
): FirstFunding | null {
  const target = wallet.toLowerCase();
  for (const tx of list) {
    if (tx.isError === '1') continue;
    if ((tx.to ?? '').toLowerCase() !== target || !tx.from) continue;
    // Verified live (BONER): the creator unwrapping its own WETH was read as
    // "first funded by WETH, a high-volume service".
    if (WRAPPED_NATIVE.includes(tx.from.toLowerCase())) continue;
    const hash = (tx.hash ?? tx.transactionHash ?? '').toLowerCase();
    if (hash && filter.ownTransactions?.has(hash)) continue;
    let value: bigint;
    try {
      value = BigInt(tx.value ?? '0');
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    return {
      funder: tx.from.toLowerCase(),
      txHash: hash,
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
  // Value received inside a transaction the wallet sent is not its funding.
  const b = firstIncoming(wallet, internal, { ownTransactions: sentBy(wallet, normal) });
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

/**
 * Blockscout flags a wallet delegating under EIP-7702 as a contract: it has
 * code. Every contract being a service, such a wallet would link nobody, so
 * its code is read: a delegation is a wallet. A code that could not be read
 * keeps Blockscout's word.
 */
async function asWallet(
  rpc: Pick<RpcClient, 'call'>,
  profile: FunderProfile | null,
): Promise<FunderProfile | null> {
  if (!profile?.isContract) return profile;
  const code = await rpc.call<string>('eth_getCode', [profile.address, 'latest']).catch(() => null);
  return isDelegatedWallet(code) ? { ...profile, isContract: false } : profile;
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
  const profile = await asWallet(rpc, await readFunderProfile(funding.funder, apiKey, base));
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
  const sender = origin ? await asWallet(rpc, await readFunderProfile(origin, apiKey, base)) : null;
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

/** A transaction an address sent: its hash, block, and whether it called a contract. */
export type SentTransaction = { hash: string; block: number; call: boolean };

/** Transactions listed in one read; an address that sent more is not listed whole. */
export const SENT_LISTED = 1_000;

export function sentListUrl(address: string, apiKey: string, base = BLOCKSCOUT_BASE): string {
  const url = new URL(`${base}/${CHAIN_ID}/api`);
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', 'txlist');
  url.searchParams.set('address', address);
  url.searchParams.set('filter_by', 'from');
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('page', '1');
  url.searchParams.set('offset', String(SENT_LISTED));
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

/**
 * Every transaction `wallet` sent, from Blockscout; `null` when it could not
 * be read or holds more than one page. Whether the list is whole is the
 * caller's to check, against the wallet's nonce: Blockscout may lag the head.
 */
export async function listSentTransactions(
  wallet: string,
  apiKey: string,
  base = BLOCKSCOUT_BASE,
): Promise<SentTransaction[] | null> {
  try {
    const body = await requestJson<EtherscanAnswer>(sentListUrl(wallet, apiKey, base), {
      source: 'blockscout',
      timeoutMs: 6_000,
      retries: 1,
    });
    const list = Array.isArray(body.result)
      ? body.result
      : /no transactions found/i.test(body.message ?? '')
        ? []
        : null;
    if (!list || list.length >= SENT_LISTED) return null;
    const target = wallet.toLowerCase();
    return list
      .filter((tx) => (tx.from ?? '').toLowerCase() === target)
      .map((tx) => ({
        hash: (tx.hash ?? tx.transactionHash ?? '').toLowerCase(),
        block: Number(tx.blockNumber ?? 0),
        call: (tx.input ?? '0x1') !== '0x',
      }))
      .filter((tx) => tx.hash !== '');
  } catch {
    return null;
  }
}
