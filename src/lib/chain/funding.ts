import { BLOCKSCOUT_BASE } from '../holders/blockscout';
import { requestJson } from '../http';

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
