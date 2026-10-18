/**
 * What kind of address first funded a wallet.
 *
 * Most creator wallets are first funded by infrastructure: an exchange hot
 * wallet, a bridge, a router. That such an address also funded other
 * creators links nobody: it funds everyone. This module tells those apart
 * from the profile Blockscout gives (contract or not, verified name, tags,
 * transaction count), with fixed, readable rules:
 *
 *  - `tool`: a contract whose verified name is a batch-sending or airdrop
 *    tool (BatchTransfer, Disperse, GasliteDrop, MultiSend, Airdrop…). The
 *    real funder is whoever sent the transaction through it;
 *  - `service`: any other contract, whatever its name or its count (a
 *    contract is never "a wallet that funded others": a router, a relayer, a
 *    vault or an executor named "Executor" with 0 transactions sent
 *    alike), or an address with at least 50,000 transactions, or a public
 *    tag naming an exchange;
 *  - `wallet`: an address without code (or a wallet delegating under
 *    EIP-7702) with a known transaction count;
 *  - `unknown`: the profile could not be read. Never treated as a wallet.
 *
 * Pure and dependency-free. The indexer keeps an identical copy in
 * `indexer/src/funder-kind.ts` (it imports nothing from the app); a test runs
 * the same table against both.
 */

export type FunderKind = 'service' | 'tool' | 'wallet' | 'unknown';

export type FunderProfile = {
  address: string;
  isContract: boolean;
  /** The verified contract name, when there is one. */
  name: string | null;
  /** Transactions Blockscout counts for the address; `null` when unread. */
  txCount: number | null;
  /** Public tags Blockscout attaches to the address. */
  tags: string[];
};

/** From this many transactions on, an address serves the public: an exchange, a relayer, a router. */
export const SERVICE_TX_COUNT = 50_000;

/** Contracts that send to many addresses at once on behalf of their caller. */
export const TOOL_NAME =
  /batch\s*-?\s*(?:transfer|send)|disperse|gaslite\s*-?\s*drop|multi\s*-?\s*send|air\s*-?\s*drop|bulk\s*-?\s*(?:send|transfer)/i;

/**
 * Contracts that move other people's funds: routers, bridges, relayers. Every
 * contract is a service now; the name still says, in the report, which kind.
 */
export const SERVICE_NAME =
  /router|relay|depository|bridge|portal|multicall|exchange|vault|gateway|messenger|paymaster|entry\s*point|aggregator|settler/i;

/** Public tags that name an exchange or another service. */
export const SERVICE_TAG =
  /exchange|\bcex\b|hot\s*wallet|bridge|router|relay|binance|coinbase|kraken|okx|bybit|bitget|kucoin|gate\.io|htx|mexc/i;

export function classifyFunder(profile: FunderProfile | null | undefined): FunderKind {
  if (!profile) return 'unknown';
  const name = profile.name ?? '';
  if (profile.isContract && TOOL_NAME.test(name)) return 'tool';
  // A contract is not a person: whatever funded through it, it links nobody.
  // Verified live: an 8 KB contract named "Executor", 0 transactions sent,
  // was read as "the wallet that funded this creator also funded 25 others".
  if (profile.isContract) return 'service';
  if (profile.txCount !== null && profile.txCount >= SERVICE_TX_COUNT) return 'service';
  if (profile.tags.some((tag) => SERVICE_TAG.test(tag))) return 'service';
  // Without a count, a busy address cannot be told from a private one.
  if (profile.txCount === null) return 'unknown';
  return 'wallet';
}

/**
 * The address a funding is grouped by. A tool's own address groups nothing:
 * the transaction's sender is the funder. One level only: a sender that is
 * itself a tool is not followed further.
 */
export function effectiveFunder(input: {
  funder: string;
  kind: FunderKind;
  origin?: string | null;
  originKind?: FunderKind | null;
}): { effective: string | null; kind: FunderKind } {
  if (input.kind !== 'tool') return { effective: input.funder, kind: input.kind };
  if (!input.origin) return { effective: null, kind: 'unknown' };
  const kind = input.originKind ?? 'unknown';
  return { effective: input.origin, kind: kind === 'tool' ? 'unknown' : kind };
}

type BlockscoutAddress = {
  is_contract?: unknown;
  name?: unknown;
  metadata?: { tags?: { name?: unknown }[] | null } | null;
};
type BlockscoutCounters = { transactions_count?: unknown };

/**
 * A profile from Blockscout's `/api/v2/addresses/{a}` and `/counters`
 * answers. `null` when either answer does not have the expected shape.
 */
export function parseProfile(
  address: string,
  body: unknown,
  counters: unknown,
): FunderProfile | null {
  if (!body || typeof body !== 'object' || !counters || typeof counters !== 'object') return null;
  const a = body as BlockscoutAddress;
  const c = counters as BlockscoutCounters;
  const rawCount = c.transactions_count;
  const count =
    typeof rawCount === 'number'
      ? rawCount
      : typeof rawCount === 'string' && /^\d+$/.test(rawCount)
        ? Number(rawCount)
        : null;
  const rawTags = a.metadata?.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags
        .map((t) => (typeof t?.name === 'string' ? t.name.slice(0, 80) : ''))
        .filter((t) => t.length > 0)
    : [];
  return {
    address: address.toLowerCase(),
    isContract: a.is_contract === true,
    name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : null,
    txCount: count,
    tags,
  };
}
