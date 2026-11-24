import type {
  Completeness,
  Holder,
  HolderDistributionData,
  SetAsideHolding,
  SetAsideRole,
  SolanaMint,
  SolanaTokenProgram,
  Sourced,
} from '../contracts';
import { SealError } from '../errors';
import { BudgetExhaustedError } from '../http';
import { encodeBase58 } from './address';
import { STREAMFLOW_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './programs';
import {
  isSelfOwnedTokenAccount,
  roleFromAccount,
  roleWithoutAccount,
  STREAMFLOW_ESCROW_OFFSET,
  STREAMFLOW_MINT_OFFSET,
  type OwnerAccount,
  type OwnerRole,
} from './roles';
import {
  accountBytes,
  COMMITMENT,
  parsedAccount,
  type AccountInfo,
  type ProgramAccount,
  type SolanaRpc,
} from './rpc';

/**
 * Who holds a Solana token, read from its token accounts.
 *
 * A token account holds one mint for one owner; an owner may have several.
 * The holders are the owners, so the accounts are read, brought back to their
 * owners and added up per owner. Each owner is then said for what it is
 * (roles.ts): a wallet, or a program address holding for a curve, a pool, a
 * lock, the incinerator, or a program account whose role the chain does not
 * show.
 *
 * Two ways to read the accounts:
 *  - every account of the mint (`getProgramAccounts` filtered on the mint),
 *    only when the token has few of them: the holder count is then exact;
 *  - the 20 largest (`getTokenLargestAccounts`, keyed nodes only): the top is
 *    right, the count is only a floor.
 * A token with many accounts on a node that refuses the largest ones gets no
 * list at all, and says so.
 *
 * Measured on mainnet on 24/11/2026 (public node): 159 accounts in 51 ms
 * (45 KB), 30,515 in 379 ms (8.7 MB), 249,243 in 1.6 s (71 MB). The last is
 * too much to carry for one read; below 40,000 accounts it is not.
 */

// ── Layouts and limits, each read on chain ──────────────────────────────────

/**
 * Token account layout: mint at byte 0, owner at 32, amount (u64, little
 * endian) at 64; the same in SPL Token and Token-2022 (whose extensions come
 * after byte 165). Checked on 24/11/2026: owner and amount read from bytes
 * 32..72 matched the node's jsonParsed `owner` and `tokenAmount.amount` for
 * the five largest accounts of ANDLpP3C…pump (Token-2022).
 * https://github.com/solana-program/token/blob/main/program/src/state.rs (`Account`)
 */
export const TOKEN_ACCOUNT_MINT_OFFSET = 0;
export const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
export const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
/** An SPL Token account is exactly 165 bytes (every GOAT account read on 24/11/2026). */
export const SPL_TOKEN_ACCOUNT_SIZE = 165;
/** Owner and amount, the only bytes a holders read needs. */
const OWNER_AND_AMOUNT = {
  offset: TOKEN_ACCOUNT_OWNER_OFFSET,
  length: TOKEN_ACCOUNT_AMOUNT_OFFSET + 8 - TOKEN_ACCOUNT_OWNER_OFFSET,
};

/**
 * `getTokenLargestAccounts` returns at most this many accounts, zero
 * balances included: the node walks every account of the mint and keeps the
 * 20 largest (agave rpc/src/rpc.rs, `get_token_largest_accounts`,
 * NUM_LARGEST_ACCOUNTS). Fewer than 20 means the mint has no other account.
 * https://github.com/anza-xyz/agave/blob/master/rpc/src/rpc.rs
 */
export const NUM_LARGEST_ACCOUNTS = 20;

/**
 * Above this many token accounts, the mint's accounts are not all read.
 * Its size is not asked outright (no method counts them): one in 256 owners
 * starts with a zero byte, and those are read first. Checked on 24/11/2026:
 * that sample gave 111 accounts for a mint with 30,515 (×256 = 28,416) and
 * 1,020 for one with 249,243 (×256 = 261,120).
 */
export const FULL_READ_MAX_ACCOUNTS = 40_000;
export const SAMPLE_RATIO = 256;
/** Base58 of one zero byte: the owner's first byte is 0. */
const SAMPLE_PREFIX = '1';

/** Off-curve owners whose account is read to say what they are (100 per call). */
export const MAX_OWNER_LOOKUPS = 300;
/** Owners checked as Streamflow escrows (one call each). */
export const MAX_STREAMFLOW_LOOKUPS = 3;
/** Size of the Streamflow contracts read on 24/11/2026 (three of three). */
const STREAMFLOW_CONTRACT_SIZE = 1104;

/** Calls one holders read may spend, and how long it may take. */
export const DEFAULT_MAX_CALLS = 14;
export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_TOP = 20;

// ── Shapes ──────────────────────────────────────────────────────────────────

/** How the list was read. */
export type HoldersMethod =
  /** Every token account of the mint: the count is exact. */
  | 'all-accounts'
  /** The 20 largest token accounts only. */
  | 'largest-accounts'
  /** No list could be read. */
  | 'none';

/** A holder: an owner of token accounts, their balances added up. */
export type SolanaHolder = Holder & {
  /** What the owner is, and what was read to say so. */
  owner: OwnerRole;
  /** Part of the whole supply, 0 to 1. */
  ofSupply: number;
  /** The token accounts read for this owner, the largest first. */
  tokenAccounts: string[];
};

export type SolanaHoldersData = HolderDistributionData & {
  chain: 'solana';
  /** `null` when the mint could not be read. */
  program: SolanaTokenProgram | null;
  decimals: number;
  /** Raw units, as a decimal string. */
  supply: string;
  method: HoldersMethod;
  /** Token accounts read, empty ones included. */
  accountsRead: number;
  /**
   * Holders found, pools, curves, locks and burn excluded. Exact when
   * `holderCount` is set (every account read); a floor otherwise.
   */
  holdersAtLeast: number;
  top: SolanaHolder[];
  /**
   * Parts of the whole supply, 0 to 1; `null` when no list was read. From
   * the largest accounts only, each is what those accounts show: a floor.
   */
  ofSupply: {
    largestWallet: number | null;
    top10Wallets: number | null;
    /** In pools (PumpSwap, Raydium, Meteora, Orca). */
    pools: number | null;
    /** On a bonding curve (pump.fun, LaunchLab, Meteora DBC). */
    curves: number | null;
    /** Held by the incinerator. */
    burned: number | null;
    /** In a lock (Jupiter Lock, Streamflow). */
    locked: number | null;
  };
  /** The wallet asked about (`creator`), read on its own token accounts. */
  creator?: {
    address: string;
    /** Raw units. */
    balance: string;
    ofSupply: number;
    /** Part of what circulates (supply less pools, curves, locks and burn), as `top[].share`. */
    share: number;
    tokenAccounts: number;
  };
};

export type SolanaHolders = Sourced<SolanaHoldersData>;

export type ReadHoldersOptions = {
  /** The mint as already read: saves a call. Read here otherwise. */
  mint?: Pick<SolanaMint, 'program' | 'decimals' | 'supply'>;
  /** A wallet whose part is wanted, the creator's usually. */
  creator?: string;
  maxCalls?: number;
  timeoutMs?: number;
  topN?: number;
  now?: () => Date;
  /** Milliseconds, for the time allowance; injectable for tests. */
  clock?: () => number;
};

// ── The read ────────────────────────────────────────────────────────────────

/** The read ran out of calls or time: what was read so far is still said. */
class AllowanceError extends Error {
  constructor(readonly what: 'calls' | 'time') {
    super(what === 'calls' ? 'call allowance used up' : 'time allowance used up');
  }
}

type Allowance = {
  run<T>(cost: number, fn: () => Promise<T>): Promise<T>;
  spent(): number;
};

function allowance(maxCalls: number, timeoutMs: number, clock: () => number): Allowance {
  const start = clock();
  let spent = 0;
  return {
    spent: () => spent,
    async run<T>(cost: number, fn: () => Promise<T>): Promise<T> {
      if (spent + cost > maxCalls) throw new AllowanceError('calls');
      const left = timeoutMs - (clock() - start);
      if (left <= 0) throw new AllowanceError('time');
      spent += cost;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new AllowanceError('time')), left);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Errors a read survives: the source failed, the read goes on without it. */
function isSourceFailure(error: unknown): boolean {
  return (
    error instanceof SealError ||
    error instanceof BudgetExhaustedError ||
    error instanceof AllowanceError
  );
}

function why(error: unknown): string {
  if (error instanceof AllowanceError) return error.message;
  if (error instanceof BudgetExhaustedError) return 'call allowance used up';
  if (error instanceof SealError) return `${error.kind}: ${error.message}`;
  return String(error);
}

type TokenAccount = { address: string; owner: string; amount: bigint };

function decodeOwnerAndAmount(
  info: Pick<AccountInfo, 'data'>,
): { owner: string; amount: bigint } | null {
  const bytes = accountBytes(info);
  if (!bytes || bytes.length < OWNER_AND_AMOUNT.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { owner: encodeBase58(bytes.subarray(0, 32)), amount: view.getBigUint64(32, true) };
}

function programOf(owner: string): SolanaTokenProgram | null {
  if (owner === TOKEN_PROGRAM) return 'spl-token';
  if (owner === TOKEN_2022_PROGRAM) return 'token-2022';
  return null;
}

const programId = (program: SolanaTokenProgram) =>
  program === 'spl-token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;

/** The filters of "every token account of this mint". */
export function mintAccountFilters(mint: string, program: SolanaTokenProgram) {
  return [
    ...(program === 'spl-token' ? [{ dataSize: SPL_TOKEN_ACCOUNT_SIZE }] : []),
    { memcmp: { offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mint } },
  ];
}

/**
 * Reads the holders of `mint`. Never throws for a source that fails: the
 * answer says what it could read, its completeness and why.
 */
export async function readHolders(
  mint: string,
  rpc: SolanaRpc,
  options: ReadHoldersOptions = {},
): Promise<SolanaHolders> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const budget = allowance(
    options.maxCalls ?? DEFAULT_MAX_CALLS,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.clock ?? Date.now,
  );
  const notes: string[] = [];
  const source = (completeness: Completeness, data: SolanaHoldersData): SolanaHolders => ({
    completeness,
    sources: [
      { name: 'solana-rpc', fetchedAt, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) },
    ],
    data,
  });

  // 1. The mint: its program, decimals and supply.
  let mintInfo = options.mint;
  if (!mintInfo) {
    try {
      const account = await budget.run(1, () =>
        rpc.getAccountInfo(mint, { encoding: 'jsonParsed' }),
      );
      const program = account ? programOf(account.owner) : null;
      const parsed = account ? parsedAccount(account) : null;
      const info =
        (parsed?.parsed as { type?: string; info?: { decimals?: number; supply?: string } }) ??
        null;
      if (!account || !program || info?.type !== 'mint' || !info.info?.supply) {
        notes.push(account ? 'not a token mint' : 'no account at this address');
        return source('unavailable', emptyData(mint));
      }
      mintInfo = { program, decimals: info.info.decimals ?? 0, supply: info.info.supply };
    } catch (error) {
      if (!isSourceFailure(error)) throw error;
      notes.push(`mint not read (${why(error)})`);
      return source('unavailable', emptyData(mint));
    }
  }
  const supply = BigInt(mintInfo.supply);

  // 2. The token accounts.
  let accounts: TokenAccount[] = [];
  let method: HoldersMethod = 'none';
  let largest: { address: string; amount: string }[] | null = null;
  let largestError = '';
  try {
    largest = await budget.run(1, () => rpc.getTokenLargestAccounts(mint));
  } catch (error) {
    if (!isSourceFailure(error)) throw error;
    // The public node refuses it: the full read below may still do.
    largestError = why(error);
  }

  if (largest !== null && largest.length < NUM_LARGEST_ACCOUNTS) {
    method = 'all-accounts';
  } else {
    try {
      const sample = await budget.run(1, () =>
        rpc.getProgramAccounts(programId(mintInfo.program), {
          encoding: 'base64',
          dataSlice: { offset: 0, length: 0 },
          filters: [
            ...mintAccountFilters(mint, mintInfo.program),
            { memcmp: { offset: TOKEN_ACCOUNT_OWNER_OFFSET, bytes: SAMPLE_PREFIX } },
          ],
        }),
      );
      if (sample.length * SAMPLE_RATIO <= FULL_READ_MAX_ACCOUNTS) {
        const all = await budget.run(1, () =>
          rpc.getProgramAccounts(programId(mintInfo.program), {
            encoding: 'base64',
            dataSlice: OWNER_AND_AMOUNT,
            filters: mintAccountFilters(mint, mintInfo.program),
          }),
        );
        accounts = fromProgramAccounts(all);
        method = 'all-accounts';
        largest = null;
      } else {
        notes.push('too many token accounts to read them all');
      }
    } catch (error) {
      if (!isSourceFailure(error)) throw error;
      notes.push(`token accounts not all read (${why(error)})`);
    }
    if (method === 'none' && largest !== null) method = 'largest-accounts';
  }

  // The largest accounts name token accounts, not owners: read them.
  if (largest !== null && method !== 'none') {
    try {
      accounts = await readTokenAccounts(
        rpc,
        budget,
        mint,
        largest.map((l) => l.address),
      );
    } catch (error) {
      if (!isSourceFailure(error)) throw error;
      notes.push(`owners of the largest accounts not read (${why(error)})`);
      method = 'none';
      accounts = [];
    }
  }
  if (method === 'largest-accounts') {
    notes.push(
      `only the ${NUM_LARGEST_ACCOUNTS} largest token accounts were read: the holder count is a floor, and an owner's smaller accounts are not added`,
    );
  } else if (method === 'none' && largest === null) {
    notes.push(`largest token accounts not read (${largestError})`);
  }

  // 3. Owners, their balances added up.
  const owners = groupByOwner(accounts);

  // 4. What each owner is.
  const roles = await classifyOwners(rpc, budget, mint, owners, notes);

  // 5. The wallet asked about.
  let creator: { address: string; amount: bigint; accounts: number } | null = null;
  let creatorFailed = false;
  if (options.creator) {
    const listed = owners.find((o) => o.owner === options.creator);
    if (method === 'all-accounts') {
      creator = {
        address: options.creator,
        amount: listed?.amount ?? 0n,
        accounts: listed?.accounts.length ?? 0,
      };
    } else {
      try {
        creator = await readOwnerBalance(rpc, budget, options.creator, mint);
      } catch (error) {
        if (!isSourceFailure(error)) throw error;
        creatorFailed = true;
        notes.push(`creator's balance not read (${why(error)})`);
      }
    }
  }

  const data = summarize({
    mint,
    program: mintInfo.program,
    decimals: mintInfo.decimals,
    supply,
    method,
    accountsRead: accounts.length,
    owners,
    roles,
    creator,
    topN: options.topN ?? DEFAULT_TOP,
  });

  const unlooked = [...roles.values()].some((r) => r.evidence === NOT_LOOKED_UP);
  const completeness: Completeness =
    method === 'none'
      ? creator !== null
        ? 'partial'
        : 'unavailable'
      : method === 'largest-accounts' || unlooked || creatorFailed
        ? 'partial'
        : 'full';
  return source(completeness, data);
}

function fromProgramAccounts(list: readonly ProgramAccount[]): TokenAccount[] {
  const out: TokenAccount[] = [];
  for (const entry of list) {
    // A token account is at least 165 bytes; anything shorter is not one.
    if (entry.account.space < SPL_TOKEN_ACCOUNT_SIZE) continue;
    const decoded = decodeOwnerAndAmount(entry.account);
    if (decoded) out.push({ address: entry.pubkey, ...decoded });
  }
  return out;
}

type ParsedTokenAccount = {
  type?: string;
  info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string } };
};

async function readTokenAccounts(
  rpc: SolanaRpc,
  budget: Allowance,
  mint: string,
  addresses: readonly string[],
): Promise<TokenAccount[]> {
  if (addresses.length === 0) return [];
  const infos = await budget.run(Math.ceil(addresses.length / 100), () =>
    rpc.getMultipleAccounts(addresses, { encoding: 'jsonParsed' }),
  );
  const out: TokenAccount[] = [];
  for (const [i, info] of infos.entries()) {
    const parsed = info
      ? (parsedAccount(info)?.parsed as ParsedTokenAccount | undefined)
      : undefined;
    const owner = parsed?.info?.owner;
    const amount = parsed?.info?.tokenAmount?.amount;
    // Closed since, or not an account of this mint: not counted.
    if (parsed?.type !== 'account' || parsed.info?.mint !== mint || !owner || !amount) continue;
    out.push({ address: addresses[i] as string, owner, amount: BigInt(amount) });
  }
  return out;
}

async function readOwnerBalance(
  rpc: SolanaRpc,
  budget: Allowance,
  owner: string,
  mint: string,
): Promise<{ address: string; amount: bigint; accounts: number }> {
  const answer = await budget.run(1, () =>
    rpc.call<{ value: ProgramAccount[] }>('getTokenAccountsByOwner', [
      owner,
      { mint },
      { commitment: COMMITMENT, encoding: 'base64', dataSlice: OWNER_AND_AMOUNT },
    ]),
  );
  let amount = 0n;
  for (const entry of answer.value) {
    const decoded = decodeOwnerAndAmount(entry.account);
    if (decoded && decoded.owner === owner) amount += decoded.amount;
  }
  return { address: owner, amount, accounts: answer.value.length };
}

type OwnerTotal = { owner: string; amount: bigint; accounts: string[] };

/** Owners with a balance, the largest first; ties by address, for a stable order. */
export function groupByOwner(accounts: readonly TokenAccount[]): OwnerTotal[] {
  const byOwner = new Map<string, { amount: bigint; accounts: TokenAccount[] }>();
  for (const account of accounts) {
    const entry = byOwner.get(account.owner) ?? { amount: 0n, accounts: [] };
    entry.amount += account.amount;
    entry.accounts.push(account);
    byOwner.set(account.owner, entry);
  }
  return [...byOwner]
    .filter(([, e]) => e.amount > 0n)
    .map(([owner, e]) => ({
      owner,
      amount: e.amount,
      accounts: e.accounts
        .filter((a) => a.amount > 0n)
        .sort((a, b) => cmpDesc(a.amount, b.amount) || cmpText(a.address, b.address))
        .map((a) => a.address),
    }))
    .sort((a, b) => cmpDesc(a.amount, b.amount) || cmpText(a.owner, b.owner));
}

const cmpDesc = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);
const cmpText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const NOT_LOOKED_UP = 'off the ed25519 curve; its account was not read in this read';

async function classifyOwners(
  rpc: SolanaRpc,
  budget: Allowance,
  mint: string,
  owners: readonly OwnerTotal[],
  notes: string[],
): Promise<Map<string, OwnerRole>> {
  const roles = new Map<string, OwnerRole>();
  const toRead: string[] = [];
  for (const { owner } of owners) {
    const known = roleWithoutAccount(owner);
    if (known) roles.set(owner, known);
    else toRead.push(owner);
  }
  const looked = toRead.slice(0, MAX_OWNER_LOOKUPS);
  let accounts: OwnerAccount[] = [];
  try {
    if (looked.length > 0) {
      const infos = await budget.run(Math.ceil(looked.length / 100), () =>
        rpc.getMultipleAccounts(looked, {
          encoding: 'base64',
          dataSlice: { offset: 0, length: 64 },
        }),
      );
      accounts = infos.map((info) =>
        info ? { owner: info.owner, head: accountBytes(info) ?? new Uint8Array() } : null,
      );
    }
  } catch (error) {
    if (!isSourceFailure(error)) throw error;
    notes.push(`program owners not looked up (${why(error)})`);
    accounts = [];
  }

  // Streamflow escrows are found by the contract that names them.
  const streamflow = new Map<string, string | null>();
  const escrows = looked.filter((owner, i) => isSelfOwnedTokenAccount(owner, accounts[i] ?? null));
  if (escrows.length > MAX_STREAMFLOW_LOOKUPS) {
    notes.push(
      `${escrows.length - MAX_STREAMFLOW_LOOKUPS} possible Streamflow escrows not checked`,
    );
  }
  for (const owner of escrows.slice(0, MAX_STREAMFLOW_LOOKUPS)) {
    try {
      const found = await budget.run(1, () =>
        rpc.getProgramAccounts(STREAMFLOW_PROGRAM, {
          encoding: 'base64',
          dataSlice: { offset: STREAMFLOW_MINT_OFFSET, length: 32 },
          filters: [
            { dataSize: STREAMFLOW_CONTRACT_SIZE },
            { memcmp: { offset: STREAMFLOW_ESCROW_OFFSET, bytes: owner } },
          ],
        }),
      );
      const bytes = found[0] ? accountBytes(found[0].account) : null;
      streamflow.set(owner, bytes && bytes.length === 32 ? encodeBase58(bytes) : null);
    } catch (error) {
      if (!isSourceFailure(error)) throw error;
      notes.push(`Streamflow contracts not looked up (${why(error)})`);
      break;
    }
  }

  for (const [i, owner] of toRead.entries()) {
    if (i < accounts.length) {
      roles.set(owner, roleFromAccount(owner, mint, accounts[i] ?? null, streamflow.get(owner)));
    } else {
      roles.set(owner, {
        kind: 'program-account',
        name: 'program account',
        evidence: NOT_LOOKED_UP,
      });
    }
  }
  if (toRead.length > accounts.length && accounts.length > 0) {
    notes.push(`${toRead.length - accounts.length} smaller off-curve owners not looked up`);
  }
  return roles;
}

// ── The figures ─────────────────────────────────────────────────────────────

const share6 = (value: bigint, base: bigint) =>
  base > 0n ? Number((value * 1_000_000n) / base) / 1_000_000 : 0;
/** A sum of shares, without the float's trailing digits (0.9139819999999999). */
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

const SET_ASIDE: Partial<Record<OwnerRole['kind'], SetAsideRole>> = {
  pool: 'pool',
  curve: 'curve',
  lock: 'vesting',
  burn: 'burn',
};

function holderKind(role: OwnerRole): Holder['kind'] {
  if (role.kind === 'wallet') return 'wallet';
  if (role.kind === 'program-account') return 'contract';
  if (role.kind === 'burn') return 'burn';
  return 'pool';
}

export type SummaryInput = {
  mint: string;
  program: SolanaTokenProgram;
  decimals: number;
  supply: bigint;
  method: HoldersMethod;
  accountsRead: number;
  owners: readonly OwnerTotal[];
  roles: ReadonlyMap<string, OwnerRole>;
  creator: { address: string; amount: bigint; accounts: number } | null;
  topN: number;
};

/**
 * The figures, measured as the EVM read measures them (holders/index.ts):
 * `top[].share` and `concentration` on what circulates, the supply less the
 * pools, curves, locks and burn, so that a curve holding 80 % does not make
 * every other holder look small; `ofSupply` and `setAside` on the whole supply.
 */
export function summarize(input: SummaryInput): SolanaHoldersData {
  const { owners, roles, supply } = input;
  const roleOf = (owner: string): OwnerRole =>
    roles.get(owner) ?? {
      kind: 'program-account',
      name: 'program account',
      evidence: NOT_LOOKED_UP,
    };
  const isSetAside = (owner: string) => SET_ASIDE[roleOf(owner).kind] !== undefined;

  const listed = owners.filter((o) => !isSetAside(o.owner)).reduce((s, o) => s + o.amount, 0n);
  const setAsideTotal = owners
    .filter((o) => isSetAside(o.owner))
    .reduce((s, o) => s + o.amount, 0n);
  const fromSupply = supply > setAsideTotal ? supply - setAsideTotal : 0n;
  const circulating = fromSupply > listed ? fromSupply : listed;
  const whole = supply > 0n ? supply : listed + setAsideTotal;

  const holders: SolanaHolder[] = owners.map((o) => {
    const role = roleOf(o.owner);
    const aside = SET_ASIDE[role.kind];
    return {
      address: o.owner,
      balance: o.amount.toString(),
      share: aside ? 0 : share6(o.amount, circulating),
      kind: holderKind(role),
      ...(aside ? { role: aside } : {}),
      ...(role.kind !== 'wallet' ? { name: role.name } : {}),
      owner: role,
      ofSupply: share6(o.amount, whole),
      tokenAccounts: o.accounts,
    };
  });
  const counted = holders.filter((h) => h.kind === 'wallet' || h.kind === 'contract');
  const wallets = holders.filter((h) => h.kind === 'wallet');
  const byKind = (kind: OwnerRole['kind']) =>
    share6(
      owners.filter((o) => roleOf(o.owner).kind === kind).reduce((s, o) => s + o.amount, 0n),
      whole,
    );
  const sumOf = (list: readonly SolanaHolder[]) => list.reduce((s, h) => s + BigInt(h.balance), 0n);

  const setAside: SetAsideHolding[] = holders
    .filter((h) => h.role !== undefined)
    .slice(0, 10)
    .map((h) => ({
      address: h.address,
      role: h.role as SetAsideRole,
      share: h.ofSupply,
      ...(h.name ? { name: h.name } : {}),
    }));

  const read = input.method !== 'none';
  const creator = input.creator
    ? {
        address: input.creator.address,
        balance: input.creator.amount.toString(),
        ofSupply: share6(input.creator.amount, whole),
        share: share6(input.creator.amount, circulating),
        tokenAccounts: input.creator.accounts,
      }
    : undefined;

  return {
    token: input.mint,
    chain: 'solana',
    program: input.program,
    decimals: input.decimals,
    supply: supply.toString(),
    method: input.method,
    accountsRead: input.accountsRead,
    countedSupply: circulating.toString(),
    holderCount: input.method === 'all-accounts' ? counted.length : null,
    holdersAtLeast: counted.length,
    // Holders first, then what is set aside, as the EVM list orders them.
    top: [...holders].sort((a, b) => b.share - a.share).slice(0, input.topN),
    concentration: {
      top1: counted[0]?.share ?? 0,
      top10: round6(counted.slice(0, 10).reduce((s, h) => s + h.share, 0)),
    },
    pooledShare: read ? share6(setAsideTotal, whole) : null,
    setAside,
    distinctTraders: null,
    ofSupply: {
      largestWallet: read && wallets[0] ? wallets[0].ofSupply : read ? 0 : null,
      top10Wallets: read ? share6(sumOf(wallets.slice(0, 10)), whole) : null,
      pools: read ? byKind('pool') : null,
      curves: read ? byKind('curve') : null,
      burned: read ? byKind('burn') : null,
      locked: read ? byKind('lock') : null,
    },
    ...(creator ? { creator } : {}),
  };
}

function emptyData(mint: string): SolanaHoldersData {
  return {
    token: mint,
    chain: 'solana',
    program: null,
    decimals: 0,
    supply: '0',
    method: 'none',
    accountsRead: 0,
    countedSupply: '0',
    holderCount: null,
    holdersAtLeast: 0,
    top: [],
    concentration: { top1: 0, top10: 0 },
    pooledShare: null,
    setAside: [],
    distinctTraders: null,
    ofSupply: {
      largestWallet: null,
      top10Wallets: null,
      pools: null,
      curves: null,
      burned: null,
      locked: null,
    },
  };
}
