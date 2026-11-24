import type { Completeness, SourceRef } from '../contracts/completeness';
import { BUNDLE_MIN_WALLETS, ROUND_TRIPS_LISTED, type LaunchSummary } from '../contracts/launch';
import type { SolanaSourceName } from '../contracts/solana';
import { SealError } from '../errors';
import { BudgetExhaustedError } from '../http';
import { isOnCurve, isSolanaAddress, shortAddress } from './address';
import type {
  SolanaLaunchCreation,
  SolanaLaunchGroup,
  SolanaLaunchMove,
  SolanaLaunchReplay,
  SolanaLaunchReplayData,
  SolanaLaunchStoryLine,
  SolanaRoundTrip,
} from './launch-types';
import { associatedTokenAddress, INCINERATOR, knownProgram } from './programs';
import {
  MAX_MULTIPLE_ACCOUNTS,
  MAX_SIGNATURES_PAGE,
  parsedAccount,
  SolanaRpcError,
  type SignatureInfo,
  type SolanaRpc,
  type SolanaTransaction,
} from './rpc';
import {
  movesOf,
  ownerKind,
  readFlows,
  solChange,
  type ActorKind,
  type DraftMove,
  type TransactionFlows,
} from './trades';

/**
 * The first transactions of a Solana token, replayed from the balances they
 * changed: who got the supply in the creation slot, who bought in the first
 * seconds, who sold back quickly, what the creator did. Facts and numbers,
 * never a verdict.
 *
 * 1. The creation. A token's history comes newest first, 1,000 signatures a
 *    page, and bots' no-op transactions swell it (2beK…pump: over 10,000
 *    signatures for about 114 trades, 25/11/2026). So the creation is looked
 *    for where it is cheap first: given by the caller, or as the oldest
 *    transaction of the creator's associated token account (pump.fun creates
 *    it in the creation when the creator buys), then as the oldest of the
 *    mint's whole history, read up to `maxPages` pages. A candidate counts
 *    only if its transaction creates the mint's account.
 * 2. The window. `getSignaturesForAddress` accepts as `before` a signature
 *    that does not involve the address: the first signature of a block a few
 *    slots after the creation, read with `getBlock`, bounds a page that runs
 *    from that block back to the creation (`until`). Checked on mainnet on
 *    25/11/2026: for FB5e…pump, block 473491350 → the 986 signatures of the
 *    mint between the creation and that block, in the same order as the full
 *    history.
 * 3. The transactions. The creation and the next ones, up to
 *    `maxTransactions`, read with `getTransaction`; their balances say who
 *    bought, sold or received (`trades.ts`).
 * 4. Who the owners are (one `getMultipleAccounts`), and what the buyers'
 *    token accounts hold today (one more).
 *
 * Every call counts against `maxCalls` and the whole read against
 * `deadlineMs`: what is not read in time is said, and the replay is partial.
 */

/** Transactions read from the creation on, at most. */
export const LAUNCH_MAX_TRANSACTIONS = 60;
/** RPC calls one replay may spend. */
export const LAUNCH_MAX_CALLS = 90;
/** Time one replay may take, in milliseconds. */
export const LAUNCH_DEADLINE_MS = 20_000;
/** Pages of the mint's history read, newest first, when the creation is looked for there. */
export const LAUNCH_HISTORY_PAGES = 5;
/** Buys in this many seconds after the creation are "the first buyers". */
export const SOLANA_EARLY_SECONDS = 10;
/**
 * Blocks used as upper bounds of the window, in slots after the creation:
 * about 4 s, 30 s and 2.5 min at the 0.215 s a slot measured on 25/11/2026
 * (see `slotAtTime`). The next one is read only while fewer than
 * `maxTransactions` were found.
 */
export const ANCHOR_SLOTS: readonly number[] = [20, 150, 750];
/** Pages read below one anchor; more than this many signatures between the creation and it, and the window is cut. */
const PAGES_PER_ANCHOR = 2;
/** A slot can be skipped (no block): the next ones are tried. */
const SLOTS_TRIED = 4;
/** Seconds a slot lasts, for a first estimate only. https://solana.com/docs/references/terminology#slot */
const SLOT_SECONDS = 0.4;
/** Estimates made to find the slot of a time, and how close (seconds) is close enough. */
const SLOT_SEARCH_STEPS = 8;
const SLOT_SEARCH_TOLERANCE = 2;
/**
 * Slots after the time given as the creation's where the earliest history is
 * bounded, the nearest first: DexScreener's `pairCreatedAt` was the
 * creation's block time for 6qmo…pump and ANDL…pump, 31 s before it for
 * FB5e…pump (read 25/11/2026). A bound that comes before the token gives no
 * signature, and the next is tried. Close bounds matter: 2beK…pump had over
 * 3,000 signatures, most of them failed, in its first 20 seconds.
 */
const HINT_MARGIN_SLOTS = [20, 150, 750];
/** Pages read back from a bound set by the time given, to the token's first signature. */
const HINT_PAGES = 3;
/** Oldest transactions of the history tried as the creation. */
const CREATION_CANDIDATES = 3;
/** Transactions asked at once; the client paces them. */
const TRANSACTION_CONCURRENCY = 4;
/** Moves listed; every move is counted in the summary. */
export const MAX_LISTED_MOVES = 40;
const MAX_CREATOR_MOVES = 15;
const MAX_LARGEST_MOVES = 10;
/** Addresses named in a group. */
const GROUP_ADDRESSES = 20;
/** Round trips told one by one in the story, the largest first. */
const STORY_ROUND_TRIPS = 3;

export type ReplayLaunchOptions = {
  /** The creator, read elsewhere (the launchpad's curve names it): its moves are flagged. */
  creator?: string | null;
  /** The creation transaction, when another reader already found it. */
  creationSignature?: string;
  maxTransactions?: number;
  maxCalls?: number;
  deadlineMs?: number;
  /** Pages of the mint's history read to find the creation. */
  maxPages?: number;
  /**
   * When the token was created, as another source says (unix seconds, such
   * as DexScreener's `pairCreatedAt`): a token whose history is too long to
   * page through is then read from a block just after that time. The
   * creation is still checked on chain.
   */
  createdAt?: number;
  earlySeconds?: number;
  /** Milliseconds clock; injectable for the tests. */
  now?: () => number;
};

/** The read ran out of calls or time. */
class StopReading extends Error {
  constructor(readonly reason: 'calls' | 'time') {
    super(reason === 'calls' ? 'call allowance spent' : 'time allowance spent');
    this.name = 'StopReading';
  }
}

/** Errors a replay absorbs (a source failing, an allowance spent); anything else is a bug and is thrown. */
function absorbed(error: unknown): boolean {
  return (
    error instanceof SealError ||
    error instanceof BudgetExhaustedError ||
    error instanceof StopReading
  );
}

/** Each call checks the allowance of calls and the deadline before it leaves. */
function metered(rpc: SolanaRpc, maxCalls: number, deadline: number, now: () => number) {
  let spent = 0;
  let stopped: StopReading['reason'] | null = null;
  const via = <T>(calls: number, run: () => Promise<T>): Promise<T> => {
    if (spent + calls > maxCalls) stopped = 'calls';
    else if (now() >= deadline) stopped = 'time';
    if (stopped) return Promise.reject(new StopReading(stopped));
    spent += calls;
    return run();
  };
  const wrapped: SolanaRpc = {
    call: (method, params) => via(1, () => rpc.call(method, params)),
    getAccountInfo: (address, options) => via(1, () => rpc.getAccountInfo(address, options)),
    getMultipleAccounts: (addresses, options) =>
      via(Math.max(1, Math.ceil(addresses.length / MAX_MULTIPLE_ACCOUNTS)), () =>
        rpc.getMultipleAccounts(addresses, options),
      ),
    getTokenLargestAccounts: (m) => via(1, () => rpc.getTokenLargestAccounts(m)),
    getProgramAccounts: (program, options) =>
      via(1, () => rpc.getProgramAccounts(program, options)),
    getSignaturesForAddress: (address, options) =>
      via(1, () => rpc.getSignaturesForAddress(address, options)),
    getTransaction: (signature, options) => via(1, () => rpc.getTransaction(signature, options)),
    getSlot: () => via(1, () => rpc.getSlot()),
  };
  return {
    rpc: wrapped,
    spent: () => spent,
    left: () => maxCalls - spent,
    stopped: () => stopped,
  };
}

type Timed = DraftMove & { seconds: number; index: number };

// ── Formatting: plain English, numbers only ─────────────────────────────────

function percent(share: number): string {
  const p = share * 100;
  if (p > 0 && p < 0.01) return 'under 0.01%';
  return `${p >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
}

function sol(lamports: bigint): string {
  const value = Number(lamports) / 1e9;
  return `${value >= 1 ? value.toFixed(2) : value.toFixed(4)} SOL`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Share of `supply`, rounded to 1e-6. */
function shareOf(value: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  return Number((value * 1_000_000n) / supply) / 1_000_000;
}

const sum = (values: Iterable<bigint>) => {
  let total = 0n;
  for (const v of values) total += v;
  return total;
};

// ── Reading ─────────────────────────────────────────────────────────────────

/** The first signature of the first block at or after `slot`, with that block's time. */
async function anchorAt(
  rpc: SolanaRpc,
  slot: number,
): Promise<{ signature: string; slot: number; blockTime: number | null } | null> {
  for (let s = slot; s < slot + SLOTS_TRIED; s += 1) {
    try {
      const block = await rpc.call<{ signatures?: string[]; blockTime?: number | null } | null>(
        'getBlock',
        [
          s,
          {
            commitment: 'confirmed',
            transactionDetails: 'signatures',
            rewards: false,
            maxSupportedTransactionVersion: 1,
          },
        ],
      );
      const first = block?.signatures?.[0];
      if (first) return { signature: first, slot: s, blockTime: block?.blockTime ?? null };
    } catch (error) {
      if (skipped(error)) continue;
      throw error;
    }
  }
  return null;
}

/**
 * -32007 and -32009: no block in this slot (skipped, or missing from the
 * node's storage). https://github.com/anza-xyz/agave/blob/master/rpc-client-api/src/custom_error.rs
 */
function skipped(error: unknown): boolean {
  return error instanceof SolanaRpcError && (error.code === -32007 || error.code === -32009);
}

/** The block time of the first block at or after `slot`. */
async function blockTimeFrom(
  rpc: SolanaRpc,
  slot: number,
): Promise<{ slot: number; time: number } | null> {
  for (let s = slot; s < slot + SLOTS_TRIED; s += 1) {
    try {
      const time = await rpc.call<number | null>('getBlockTime', [s]);
      if (typeof time === 'number') return { slot: s, time };
    } catch (error) {
      if (skipped(error)) continue;
      throw error;
    }
  }
  return null;
}

/**
 * The slot whose block came at `time` (unix seconds), within a few seconds.
 * A first jump assumes 400 ms a slot (https://solana.com/docs/references/terminology#slot);
 * the next ones use the pace measured between the last two blocks read, as
 * slots are not that long everywhere: 183,380 slots took 39,409 s, 0.215 s a
 * slot, in the day before 25/11/2026 (pump-normal fixture).
 */
async function slotAtTime(
  rpc: SolanaRpc,
  time: number,
  currentSlot: number,
): Promise<number | null> {
  // A few slots back: the newest confirmed block may not have its time yet.
  let at = await blockTimeFrom(rpc, Math.max(0, currentSlot - 50));
  let previous: { slot: number; time: number } | null = null;
  for (let step = 0; step < SLOT_SEARCH_STEPS && at; step += 1) {
    const gap = at.time - time;
    if (Math.abs(gap) <= SLOT_SEARCH_TOLERANCE) return at.slot;
    const pace =
      previous && previous.slot !== at.slot && previous.time !== at.time
        ? (previous.time - at.time) / (previous.slot - at.slot)
        : SLOT_SECONDS;
    const next = Math.max(0, at.slot - Math.round(gap / (pace > 0 ? pace : SLOT_SECONDS)));
    previous = at;
    at = await blockTimeFrom(rpc, next);
  }
  return at && Math.abs(at.time - time) <= SLOT_SEARCH_TOLERANCE ? at.slot : null;
}

type Earliest = { signatures: SignatureInfo[]; slot: number; blockTime: number | null };

/**
 * How far a listing bounded by an anchor block reaches, from the creation.
 * `before` = the first signature of a block leaves out every transaction of
 * that block: on 6qmo…pump (25/11/2026), `before` = the first signature of
 * the block at creation + 3 gave the mint's 19, 8 and 11 transactions of
 * slots +0, +1 and +2 and none of the 23 of slot +3. So the listing ends at
 * the slot before the anchor; its time is not read, and the anchor's time,
 * less a second, stands for it rather than overstate the window.
 */
function coveredBefore(
  anchor: { slot: number; blockTime: number | null },
  creationSlot: number,
  creationTime: number | null,
): { seconds: number; slot: number } | null {
  if (anchor.blockTime === null || creationTime === null) return null;
  return {
    seconds: Math.max(0, anchor.blockTime - creationTime - 1),
    slot: Math.max(0, anchor.slot - 1 - creationSlot),
  };
}

/**
 * The token's first signatures, oldest first, read back from a block just
 * after `time`: the pages end at the token's first signature. `null`, with
 * a note, when no such block bounds them.
 */
async function earliestFromTime(
  rpc: SolanaRpc,
  mint: string,
  time: number,
  currentSlot: number,
  notes: string[],
): Promise<Earliest | null> {
  const slot = await slotAtTime(rpc, time, currentSlot);
  if (slot === null) {
    notes.push('no block was found at the creation time given');
    return null;
  }
  for (const margin of HINT_MARGIN_SLOTS) {
    if (slot + margin >= currentSlot) break;
    const anchor = await anchorAt(rpc, slot + margin);
    if (!anchor) continue;
    const page = await signaturesBetween(rpc, mint, anchor.signature, undefined, HINT_PAGES);
    // Nothing before that block: the token came later.
    if (page.signatures.length === 0) continue;
    if (!page.reached) {
      notes.push(
        `more than ${(HINT_PAGES * MAX_SIGNATURES_PAGE).toLocaleString('en-US')} transactions came before the block found from the creation time given`,
      );
      return null;
    }
    return {
      signatures: [...page.signatures].reverse(),
      slot: anchor.slot,
      blockTime: anchor.blockTime,
    };
  }
  notes.push(
    'no transaction of the token came before the blocks found from the creation time given',
  );
  return null;
}

/**
 * The mint's signatures older than `before` (all of them up to now when
 * omitted) and newer than `until`, newest first. `reached` is false when the
 * pages ran out before `until`.
 */
async function signaturesBetween(
  rpc: SolanaRpc,
  mint: string,
  before: string | undefined,
  until: string | undefined,
  pages = PAGES_PER_ANCHOR,
): Promise<{ signatures: SignatureInfo[]; reached: boolean }> {
  const signatures: SignatureInfo[] = [];
  let cursor = before;
  for (let page = 0; page < pages; page += 1) {
    const batch = await rpc.getSignaturesForAddress(mint, {
      limit: MAX_SIGNATURES_PAGE,
      ...(until ? { until } : {}),
      ...(cursor ? { before: cursor } : {}),
    });
    signatures.push(...batch);
    if (batch.length < MAX_SIGNATURES_PAGE) return { signatures, reached: true };
    cursor = batch[batch.length - 1]?.signature;
  }
  return { signatures, reached: false };
}

// ── The replay ──────────────────────────────────────────────────────────────

export async function replayLaunch(
  mint: string,
  rpc: SolanaRpc,
  options: ReplayLaunchOptions = {},
): Promise<SolanaLaunchReplay> {
  const now = options.now ?? Date.now;
  const started = now();
  const fetchedAt = new Date(started).toISOString();
  const maxTransactions = Math.max(1, options.maxTransactions ?? LAUNCH_MAX_TRANSACTIONS);
  const earlySeconds = options.earlySeconds ?? SOLANA_EARLY_SECONDS;
  const meter = metered(
    rpc,
    options.maxCalls ?? LAUNCH_MAX_CALLS,
    started + (options.deadlineMs ?? LAUNCH_DEADLINE_MS),
    now,
  );
  const r = meter.rpc;
  const source: SolanaSourceName = 'solana-rpc';
  const creator = options.creator && isSolanaAddress(options.creator) ? options.creator : null;

  const blank: SolanaLaunchReplayData = {
    chain: 'solana',
    token: mint,
    tokenProgram: null,
    decimals: null,
    supply: null,
    creation: null,
    launchBlock: null,
    launchedAt: null,
    windowSeconds: 0,
    windowSlots: 0,
    moves: [],
    movesInWindow: 0,
    summary: null,
    sameSlot: null,
    payerGroup: null,
    roundTrips: [],
    transactions: {
      wanted: 0,
      read: 0,
      failed: 0,
      withoutChange: 0,
      beyond: 0,
      wholeHistory: false,
    },
    calls: 0,
    story: [],
  };
  const stopNote = () => {
    const reason = meter.stopped();
    return reason === 'calls'
      ? 'the allowance of calls for this read was spent'
      : reason === 'time'
        ? 'the time allowed for this read ran out'
        : null;
  };
  const unavailable = (
    note: string,
    data: Partial<SolanaLaunchReplayData> = {},
  ): SolanaLaunchReplay => {
    const stop = stopNote();
    return {
      completeness: 'unavailable',
      sources: [{ name: source, fetchedAt, note: stop ? `${note}; ${stop}` : note }],
      data: { ...blank, ...data, calls: meter.spent() },
    };
  };

  if (!isSolanaAddress(mint)) return unavailable('not a Solana address');

  // ── 1. The mint ──
  let supply: bigint;
  let decimals: number;
  let tokenProgram: string;
  try {
    const account = await r.getAccountInfo(mint, { encoding: 'jsonParsed' });
    if (!account) return unavailable('no account lives at this address');
    const parsed = parsedAccount(account)?.parsed as
      { type?: string; info?: { supply?: string; decimals?: number } } | undefined;
    if (parsed?.type !== 'mint' || typeof parsed.info?.supply !== 'string') {
      return unavailable('this address is not a token mint');
    }
    supply = BigInt(parsed.info.supply);
    decimals = parsed.info.decimals ?? 0;
    tokenProgram = account.owner;
  } catch (error) {
    if (!absorbed(error)) throw error;
    return unavailable('the mint could not be read');
  }
  const known = { tokenProgram, decimals, supply: supply.toString() };

  // ── 2. The creation ──
  const transactions = new Map<string, SolanaTransaction | null>();
  const readTransaction = async (signature: string) => {
    if (transactions.has(signature)) return transactions.get(signature) ?? null;
    const tx = await r.getTransaction(signature);
    transactions.set(signature, tx);
    return tx;
  };
  const found: { tx: SolanaTransaction; foundBy: SolanaLaunchCreation['foundBy'] }[] = [];
  const tryCreation = async (signature: string, foundBy: SolanaLaunchCreation['foundBy']) => {
    const tx = await readTransaction(signature);
    if (tx && tx.meta && tx.meta.err === null && readFlows(tx, mint).createsMint) {
      found.push({ tx, foundBy });
    }
  };
  const searchNotes: string[] = [];
  if (options.creationSignature) {
    try {
      await tryCreation(options.creationSignature, 'given');
    } catch (error) {
      if (!absorbed(error)) throw error;
      searchNotes.push('the creation transaction given could not be read');
    }
  }
  if (found.length === 0 && creator) {
    try {
      // pump.fun creates the creator's token account in the creation when the creator buys.
      const account = associatedTokenAddress(creator, mint, tokenProgram);
      const signatures = await r.getSignaturesForAddress(account, { limit: MAX_SIGNATURES_PAGE });
      const oldest = [...signatures].reverse().find((s) => s.err === null);
      if (oldest && signatures.length < MAX_SIGNATURES_PAGE) {
        await tryCreation(oldest.signature, 'creator-account');
      }
    } catch (error) {
      if (!absorbed(error)) throw error;
      searchNotes.push('the creator’s token account could not be read');
    }
  }
  // The mint's history, oldest first: whole, or its earliest part, up to a
  // block found from the creation time given.
  let history: SignatureInfo[] | null = null;
  let earliest: Earliest | null = null;
  let currentSlot: number | null = null;
  const slotNow = async () => (currentSlot ??= await r.getSlot());
  if (found.length === 0) {
    try {
      const maxPages = Math.max(1, options.maxPages ?? LAUNCH_HISTORY_PAGES);
      const listed: SignatureInfo[] = [];
      let complete = false;
      let before: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const batch = await r.getSignaturesForAddress(mint, {
          limit: MAX_SIGNATURES_PAGE,
          ...(before ? { before } : {}),
        });
        listed.push(...batch);
        if (batch.length < MAX_SIGNATURES_PAGE) {
          complete = true;
          break;
        }
        before = batch[batch.length - 1]?.signature;
        // A long history, and a creation time given: read from there instead.
        if (page === 0 && options.createdAt !== undefined) {
          earliest = await earliestFromTime(
            r,
            mint,
            options.createdAt,
            await slotNow(),
            searchNotes,
          );
          if (earliest) break;
        }
      }
      if (earliest) {
        for (const candidate of earliest.signatures
          .filter((s) => s.err === null)
          .slice(0, CREATION_CANDIDATES)) {
          await tryCreation(candidate.signature, 'creation-time');
          if (found.length > 0) break;
        }
      } else if (!complete) {
        return unavailable(
          [
            `the token has more than ${listed.length.toLocaleString('en-US')} transactions: its creation lies beyond those read`,
            ...searchNotes,
          ].join('; '),
          known,
        );
      } else {
        history = [...listed].reverse();
        for (const candidate of history
          .filter((s) => s.err === null)
          .slice(0, CREATION_CANDIDATES)) {
          await tryCreation(candidate.signature, 'history');
          if (found.length > 0) break;
        }
      }
    } catch (error) {
      if (!absorbed(error)) throw error;
      return unavailable(
        ['the creation of the token could not be found', ...searchNotes].join('; '),
        known,
      );
    }
  }
  const creation = found[0];
  if (!creation) {
    return unavailable('no transaction read creates the token’s mint account', known);
  }
  const { tx: creationTx, foundBy } = creation;
  const creationFlows = readFlows(creationTx, mint);
  const creationSlot = creationTx.slot;
  const creationTime = creationTx.blockTime;
  const creationInfo: SolanaLaunchCreation = {
    signature: creationFlows.signature,
    slot: creationSlot,
    launchedAt: creationTime === null ? null : new Date(creationTime * 1000).toISOString(),
    payer: creationFlows.payer,
    signers: creationFlows.signers,
    foundBy,
  };

  // ── 3. The window: the signatures after the creation, oldest first ──
  const failedParts: string[] = [];
  let after: SignatureInfo[] = [];
  let wholeHistory = false;
  /** Seconds and slots up to which every signature of the mint is known, when bounded by an anchor block. */
  let knownUntil: { seconds: number; slot: number } | null = null;
  if (history) {
    const at = history.findIndex((s) => s.signature === creationInfo.signature);
    after = history.slice(at + 1);
    wholeHistory = true;
  } else {
    let until = creationInfo.signature;
    let bounded = false;
    let fromOffset = 0;
    if (earliest) {
      const at = earliest.signatures.findIndex((s) => s.signature === creationInfo.signature);
      after = earliest.signatures.slice(at + 1);
      const newest = after[after.length - 1];
      if (newest) until = newest.signature;
      bounded = true;
      fromOffset = earliest.slot - creationSlot;
      knownUntil = coveredBefore(earliest, creationSlot, creationTime);
    }
    try {
      for (const offset of ANCHOR_SLOTS.filter((o) => o > fromOffset)) {
        if (after.filter((s) => s.err === null).length >= maxTransactions - 1) break;
        const slot = creationSlot + offset;
        const latest = await slotNow();
        const anchor = slot < latest ? await anchorAt(r, slot) : null;
        if (slot < latest && !anchor) continue;
        const page = await signaturesBetween(r, mint, anchor?.signature, until);
        bounded = true;
        if (!page.reached) {
          failedParts.push(
            `more than ${(PAGES_PER_ANCHOR * MAX_SIGNATURES_PAGE).toLocaleString('en-US')} transactions came within ${offset} slots of the creation, and the earliest of them could not be listed`,
          );
          break;
        }
        const ascending = [...page.signatures].reverse();
        after.push(...ascending);
        const newest = ascending[ascending.length - 1];
        if (newest) until = newest.signature;
        if (!anchor) {
          wholeHistory = true;
          break;
        }
        knownUntil = coveredBefore(anchor, creationSlot, creationTime);
      }
      if (!bounded) failedParts.push('no block after the creation could bound the window');
    } catch (error) {
      if (!absorbed(error)) throw error;
      failedParts.push('the transactions after the creation could not all be listed');
    }
  }
  const succeeded = after.filter((s) => s.err === null);
  const following = succeeded.slice(0, maxTransactions - 1);
  const lastWanted = following[following.length - 1];
  const windowEnd = lastWanted ? after.indexOf(lastWanted) + 1 : 0;
  const failed = after.slice(0, windowEnd).filter((s) => s.err !== null).length;
  const beyond = after.length - windowEnd;
  const cutByCount = succeeded.length > following.length;

  // ── 4. The transactions ──
  const wanted = [creationInfo.signature, ...following.map((s) => s.signature)];
  const unreadable: string[] = [];
  // Two calls are kept for who the owners are and what they hold today.
  const reserved = 2;
  for (let i = 0; i < wanted.length; i += TRANSACTION_CONCURRENCY) {
    if (meter.stopped()) break;
    const room = meter.left() - reserved;
    const chunk = wanted
      .slice(i, i + TRANSACTION_CONCURRENCY)
      .filter((s) => !transactions.has(s))
      .slice(0, Math.max(0, room));
    if (chunk.length === 0) {
      if (room > 0) continue;
      failedParts.push(
        'the allowance of calls ran out before every transaction of the window was read',
      );
      break;
    }
    const outcomes = await Promise.allSettled(chunk.map((s) => readTransaction(s)));
    outcomes.forEach((outcome, j) => {
      const signature = chunk[j] as string;
      if (outcome.status === 'rejected') {
        if (!absorbed(outcome.reason)) throw outcome.reason;
        unreadable.push(signature);
      } else if (!outcome.value) unreadable.push(signature);
    });
  }
  const notRead = wanted.filter((s) => !transactions.get(s) && !unreadable.includes(s));
  unreadable.push(...notRead);
  const read = wanted
    .map((s) => transactions.get(s))
    .filter((tx): tx is SolanaTransaction => !!tx && !!tx.meta && tx.meta.err === null);
  const flows = read.map((tx) => readFlows(tx, mint));
  const withoutChange = flows.filter((f) => f.changes.length === 0).length;

  // ── 5. Who the owners are ──
  const owners = [...new Set(flows.flatMap((f) => f.changes.map((c) => c.owner)))];
  const offCurve = owners.filter((o) => o !== INCINERATOR && !isOnCurve(o));
  const programOf = new Map<string, string | null>();
  const asked = offCurve.slice(0, MAX_MULTIPLE_ACCOUNTS);
  if (asked.length > 0) {
    try {
      const infos = await r.getMultipleAccounts(asked, {
        encoding: 'base64',
        dataSlice: { offset: 0, length: 0 },
      });
      asked.forEach((owner, i) => programOf.set(owner, infos[i]?.owner ?? null));
    } catch (error) {
      if (!absorbed(error)) throw error;
      failedParts.push('which owners are pools or programs could not be read');
    }
  }
  const kinds = new Map(owners.map((o) => [o, ownerKind(o, programOf.get(o))]));
  const kindOf = (owner: string): ActorKind => kinds.get(owner) ?? ownerKind(owner, undefined);

  // ── 6. The moves, timed ──
  const timeOf = new Map<string, number>();
  let lastTime = creationTime ?? 0;
  for (const f of flows) {
    lastTime = f.blockTime ?? lastTime;
    timeOf.set(f.signature, Math.max(0, lastTime - (creationTime ?? lastTime)));
  }
  const moves: Timed[] = flows.flatMap((f, index) =>
    movesOf(f, kindOf, mint).map((m) => ({ ...m, seconds: timeOf.get(f.signature) ?? 0, index })),
  );
  // The other side of buys and sales is the market, whatever program owns
  // its account. On the Meteora DBC launch of 8xKZ… (mainnet, 25/11/2026) the
  // supply was created in the token account of FhVo…HLuM, the DBC program's
  // ["pool_authority"] address, an account of the System Program holding no
  // data: it was the other side of every trade read. As a `contract` it was
  // counted as a holder that got 100 % of the supply at launch.
  for (const m of moves) {
    if ((m.kind === 'buy' || m.kind === 'sell') && kinds.get(m.counterparty) === 'contract') {
      kinds.set(m.counterparty, 'pool');
    }
  }
  const lastFlow = flows[flows.length - 1];
  const lastSeconds = lastFlow ? (timeOf.get(lastFlow.signature) ?? 0) : 0;
  // Every signature up to the anchor block was listed and read: the window
  // reaches that block, even when nothing happened between the last read and it.
  const reachesAnchor =
    !cutByCount && !wholeHistory && knownUntil !== null && unreadable.length === 0;
  const windowSeconds =
    reachesAnchor && knownUntil ? Math.max(knownUntil.seconds, lastSeconds) : lastSeconds;
  const windowSlots =
    reachesAnchor && knownUntil
      ? Math.max(knownUntil.slot, lastFlow ? lastFlow.slot - creationSlot : 0)
      : lastFlow
        ? lastFlow.slot - creationSlot
        : 0;
  const lastSlot = windowSlots;
  // Transactions after the window exist (or may): the window then ends the counts.
  const moreAfter = cutByCount || beyond > 0 || !wholeHistory;
  const earlyCut = windowSeconds < earlySeconds && moreAfter;

  // ── 7. The totals ──
  const isActor = (owner: string) => {
    const k = kindOf(owner);
    return k === 'wallet' || k === 'contract';
  };
  const gets = (m: Timed) =>
    (m.kind === 'buy' || m.kind === 'allocation' || m.kind === 'mint') && isActor(m.actor);
  const own = (m: Timed) => creator !== null && m.actor === creator;
  // Shares are of today's supply, or of what the transactions read created
  // when that is more: tokens burned since would otherwise lift the launch's
  // shares above 100 % (8xKZ…: 1e15 created, less today; mainnet, 25/11/2026).
  const created = sum(flows.map((f) => (f.minted > 0n ? f.minted : 0n)));
  const base = created > supply ? created : supply;
  const share = (v: bigint) => shareOf(v, base);

  const creatorMoves = moves.filter(own);
  const creatorAtLaunch = sum(
    creatorMoves.filter((m) => m.slot === creationSlot && gets(m)).map((m) => m.value),
  );
  const creatorBuys = creatorMoves.filter((m) => m.kind === 'buy');
  const creatorSales = creatorMoves.filter((m) => m.kind === 'sell');

  const byActor = <T extends Timed>(list: readonly T[]) => {
    const out = new Map<string, bigint>();
    for (const m of list) out.set(m.actor, (out.get(m.actor) ?? 0n) + m.value);
    return out;
  };
  const otherBuys = moves.filter((m) => m.kind === 'buy' && isActor(m.actor) && !own(m));
  const earlyBuys = otherBuys.filter((m) => m.seconds <= earlySeconds);
  const earlyBought = byActor(earlyBuys);
  const earlyWithin = Math.max(0, ...earlyBuys.map((m) => m.seconds));

  // The transaction delivering the most to several addresses at once.
  const perTx = new Map<string, Timed[]>();
  for (const m of otherBuys) perTx.set(m.transaction, [...(perTx.get(m.transaction) ?? []), m]);
  const severalAtOnce = [...perTx.values()]
    .filter((list) => new Set(list.map((m) => m.actor)).size >= BUNDLE_MIN_WALLETS)
    .sort((a, b) => {
      const d = sum(b.map((m) => m.value)) - sum(a.map((m) => m.value));
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
  const bundleTx = severalAtOnce[0];
  const bundleBought = bundleTx ? byActor(bundleTx) : null;
  // Every such transaction, not only the largest: on ANDL…pump three of them
  // served three wallets each in the creation slot (mainnet, 25/11/2026).
  const severalBought = byActor(severalAtOnce.flat());

  // What the creation transaction delivered to others than the creator (its
  // fee payer, when the creator is not known).
  const launcher = creator ?? creationInfo.payer;
  const viaCreation = moves.filter(
    (m) => m.transaction === creationInfo.signature && gets(m) && m.actor !== launcher,
  );
  const creationBought = byActor(viaCreation);
  const payerAtLaunch =
    creator === null
      ? sum(
          moves
            .filter(
              (m) =>
                m.transaction === creationInfo.signature &&
                gets(m) &&
                m.actor === creationInfo.payer,
            )
            .map((m) => m.value),
        )
      : 0n;
  const linkedOut = new Set([creator, creationInfo.payer].filter((a): a is string => !!a));

  // Got tokens in the creation slot, the creator aside.
  const slotMoves = moves.filter((m) => m.slot === creationSlot && gets(m) && !own(m));
  const slotGot = byActor(slotMoves);

  // Got tokens in transactions paid by the creation's fee payer or the creator.
  const payers = [...linkedOut];
  const payerMoves = moves.filter(
    (m) => payers.includes(m.payer) && gets(m) && !linkedOut.has(m.actor),
  );
  const payerGot = byActor(payerMoves);

  // Bought, then sold in a later transaction of the window.
  const roundTrips: SolanaRoundTrip[] = [];
  const firstBuy = new Map<string, Timed>();
  for (const m of moves) {
    if (m.kind === 'buy' && isActor(m.actor) && !firstBuy.has(m.actor)) firstBuy.set(m.actor, m);
  }
  const tripSeen = new Set<string>();
  for (const m of moves) {
    if (m.kind !== 'sell' || tripSeen.has(m.actor)) continue;
    const buy = firstBuy.get(m.actor);
    if (!buy || m.index <= buy.index) continue;
    tripSeen.add(m.actor);
    roundTrips.push({
      address: m.actor,
      boughtAt: buy.seconds,
      soldAt: m.seconds,
      boughtSlot: buy.slot - creationSlot,
      soldSlot: m.slot - creationSlot,
      // Every buy and sale of the window, not only the first sale: on GdmU…pump
      // (mainnet, 25/11/2026) 3Ugj… bought 2.90 % and sold it in two sales of
      // 1.45 % in the next slot; the first alone read as half kept.
      bought: share(
        sum(moves.filter((x) => x.actor === m.actor && x.kind === 'buy').map((x) => x.value)),
      ),
      sold: share(
        sum(
          moves
            .filter((x) => x.actor === m.actor && x.kind === 'sell' && x.index > buy.index)
            .map((x) => x.value),
        ),
      ),
    });
  }
  roundTrips.sort(
    (a, b) =>
      Number(b.address === creator) - Number(a.address === creator) ||
      a.boughtSlot - b.boughtSlot ||
      a.soldSlot - b.soldSlot,
  );

  // ── 8. What the buyers' token accounts hold today ──
  const accountsOf = new Map<string, string[]>();
  for (const f of flows) {
    for (const { account, owner } of f.accounts) {
      const list = accountsOf.get(owner) ?? [];
      if (!list.includes(account)) list.push(account);
      accountsOf.set(owner, list);
    }
  }
  const ranked = (got: ReadonlyMap<string, bigint>) =>
    [...got].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).map(([a]) => a);
  const selected = selectMoves(moves, creator);
  const balanceWanted = [
    ...new Set([
      ...(creator && accountsOf.has(creator) ? [creator] : []),
      ...ranked(slotGot),
      ...ranked(payerGot),
      ...ranked(creationBought),
      ...(bundleBought ? ranked(bundleBought) : []),
      ...ranked(earlyBought),
      ...selected.filter((m) => isActor(m.actor)).map((m) => m.actor),
    ]),
  ];
  const balanceAccounts: string[] = [];
  const balanceOwners: string[] = [];
  for (const owner of balanceWanted) {
    const list = accountsOf.get(owner) ?? [];
    if (balanceAccounts.length + list.length > MAX_MULTIPLE_ACCOUNTS) break;
    balanceAccounts.push(...list);
    balanceOwners.push(owner);
  }
  const held = new Map<string, number>();
  if (balanceAccounts.length > 0) {
    try {
      const infos = await r.getMultipleAccounts(balanceAccounts, { encoding: 'jsonParsed' });
      const amountIn = new Map<string, bigint>();
      balanceAccounts.forEach((account, i) => {
        const info = infos[i];
        const parsed = info
          ? (parsedAccount(info)?.parsed as TokenAccountParsed | undefined)
          : null;
        const owner = parsed?.info?.owner;
        // A closed account holds nothing; an account given to another owner holds nothing for this one.
        const amount =
          parsed?.info?.mint === mint && owner
            ? BigInt(parsed.info.tokenAmount?.amount ?? '0')
            : 0n;
        if (owner) amountIn.set(`${owner} ${account}`, amount);
        else amountIn.set(`- ${account}`, 0n);
      });
      for (const owner of balanceOwners) {
        const total = sum(
          (accountsOf.get(owner) ?? []).map((account) => amountIn.get(`${owner} ${account}`) ?? 0n),
        );
        held.set(owner, share(total));
      }
    } catch (error) {
      if (!absorbed(error)) throw error;
      failedParts.push('what the buyers hold today could not be read');
    }
  }

  const groupOf = (
    got: ReadonlyMap<string, bigint>,
    list: readonly Timed[],
  ): SolanaLaunchGroup | null => {
    if (got.size === 0) return null;
    let heldSum = 0;
    let readCount = 0;
    for (const [address, value] of got) {
      const h = held.get(address);
      if (h === undefined) continue;
      readCount += 1;
      heldSum += Math.min(h, share(value));
    }
    const spent = sum(
      [...new Map(list.map((m) => [`${m.transaction} ${m.actor}`, m])).values()].map((m) => {
        const f = flows[m.index] as TransactionFlows;
        const change = solChange(f, m.actor);
        return change < 0n ? -change : 0n;
      }),
    );
    return {
      wallets: got.size,
      share: share(sum(got.values())),
      transactions: new Set(list.map((m) => m.transaction)).size,
      heldNow: readCount > 0 ? Math.round(heldSum * 1_000_000) / 1_000_000 : null,
      unread: got.size - readCount,
      soldInWindow: [...got.keys()].filter((a) =>
        moves.some(
          (m) =>
            m.actor === a &&
            m.kind === 'sell' &&
            list.some((x) => x.actor === a && x.index < m.index),
        ),
      ).length,
      solSpent: Number(spent) / 1e9,
      addresses: ranked(got).slice(0, GROUP_ADDRESSES),
    };
  };
  const heldOf = (got: ReadonlyMap<string, bigint>) => {
    const g = groupOf(got, []);
    return { heldNow: g?.heldNow ?? null, unread: g?.unread ?? got.size };
  };
  const contractsAmong = (got: ReadonlyMap<string, bigint>) =>
    [...got.keys()].filter((a) => kindOf(a) === 'contract').length;

  const sameSlot = groupOf(slotGot, slotMoves);
  const payerGroupBase = groupOf(payerGot, payerMoves);
  const payerGroup = payerGroupBase
    ? { ...payerGroupBase, payers: payers.filter((p) => payerMoves.some((m) => m.payer === p)) }
    : null;

  const tripDelays = roundTrips.map((t) => t.soldAt - t.boughtAt);
  const bundled = bundleBought ? new Set(bundleBought.keys()) : null;
  const summary: LaunchSummary = {
    moves: moves.length,
    earlySeconds: Math.min(earlySeconds, earlyCut ? windowSeconds : earlySeconds),
    creatorAtLaunch: share(creatorAtLaunch),
    creatorBought: share(sum(creatorBuys.map((m) => m.value))),
    creatorSold: share(sum(creatorSales.map((m) => m.value))),
    creatorFirstBuyAt: creatorBuys[0]?.seconds ?? null,
    creatorLastSaleAt: creatorSales.at(-1)?.seconds ?? null,
    creatorSaleConfirmed: creatorSales.some((m) => kindOf(m.counterparty) === 'pool'),
    creatorTx:
      creationBought.size > 0
        ? {
            transaction: creationInfo.signature,
            addresses: creationBought.size,
            share: share(sum(creationBought.values())),
            ...heldOf(creationBought),
            contracts: contractsAmong(creationBought),
          }
        : null,
    early: {
      wallets: earlyBought.size,
      share: share(sum(earlyBought.values())),
      within: earlyWithin,
      ...heldOf(earlyBought),
      contracts: contractsAmong(earlyBought),
    },
    bundle:
      bundleTx && bundleBought
        ? {
            transaction: (bundleTx[0] as Timed).transaction,
            wallets: bundleBought.size,
            share: share(sum(bundleBought.values())),
            seconds: (bundleTx[0] as Timed).seconds,
            ...heldOf(bundleBought),
            contracts: contractsAmong(bundleBought),
          }
        : null,
    roundTrips: {
      wallets: roundTrips.length,
      creator: roundTrips.some((t) => t.address === creator),
      delays:
        tripDelays.length > 0
          ? { min: Math.min(...tripDelays), max: Math.max(...tripDelays) }
          : null,
      fromBundle: bundled ? roundTrips.filter((t) => bundled.has(t.address)).length : null,
      listed: roundTrips
        .slice(0, ROUND_TRIPS_LISTED)
        .map(({ address, boughtAt, soldAt }) => ({ address, boughtAt, soldAt })),
    },
    receiptsRead: read.length,
    receiptsWanted: wanted.length,
    balancesRead: held.size,
    balancesWanted: balanceWanted.length,
  };

  const listed: SolanaLaunchMove[] = selected.map((m) => ({
    kind: m.kind,
    seconds: m.seconds,
    block: m.slot - creationSlot,
    actor: m.actor,
    counterparty: m.counterparty,
    actorKind: kindOf(m.actor),
    share: share(m.value),
    actorIsCreator: own(m),
    counterpartyIsCreator: creator !== null && m.counterparty === creator,
    heldNow: held.get(m.actor) ?? null,
    transaction: m.transaction,
    amount: m.value.toString(),
    slot: m.slot,
    payer: m.payer,
    quote: m.quote
      ? { asset: m.quote.asset, amount: m.quote.amount.toString(), decimals: m.quote.decimals }
      : null,
  }));

  // ── 9. Notes, completeness, story ──
  const changed = flows.length - withoutChange;
  // Block times are whole seconds: the slots say more in a busy launch.
  const windowText = `${plural(lastSlot, 'slot')} (${plural(windowSeconds, 'second')} by block time)`;
  const notes = [
    `${plural(read.length, 'transaction')} read from the creation on, covering ${windowText}; ${changed} of them changed balances of this token`,
    ...(moreAfter ? [`later transactions are not read (at most ${maxTransactions})`] : []),
    ...(failed > 0 ? [`${plural(failed, 'failed transaction')} in the window moved nothing`] : []),
    ...(earlyCut
      ? [
          `the window read ends before ${earlySeconds} seconds: later buys are not counted among the first buyers`,
        ]
      : []),
    ...(unreadable.length > 0
      ? [`${unreadable.length} of ${wanted.length} transactions of the window could not be read`]
      : []),
    ...(summary.balancesWanted > summary.balancesRead
      ? [
          `what ${summary.balancesRead} of ${summary.balancesWanted} addresses hold today was read, in the token accounts they used`,
        ]
      : []),
    ...(base > supply
      ? [
          `shares are of the ${base.toString()} units created in the transactions read; today's supply is ${supply.toString()}`,
        ]
      : []),
    ...(offCurve.length > asked.length
      ? [`${offCurve.length - asked.length} program accounts were not identified`]
      : []),
  ];
  const stop = stopNote();
  const partialParts = [...failedParts, ...(stop ? [stop] : [])];
  const completeness: Completeness =
    earlyCut || unreadable.length > 0 || partialParts.length > 0 ? 'partial' : 'full';
  const sources: SourceRef[] = [
    { name: source, fetchedAt, note: notes.join('; ') },
    ...partialParts.map((part) => ({
      name: source,
      fetchedAt,
      note: part,
    })),
  ];

  const story = tellStory({
    creation: creationInfo,
    creator,
    moves,
    kindOf,
    programOf,
    share,
    creatorAtLaunch,
    payerAtLaunch,
    creationBought,
    sameSlot,
    payerGroup,
    payerGroupWithCreation: payerMoves.some((m) => m.transaction === creationInfo.signature),
    bundle: summary.bundle,
    severalAtOnce: {
      transactions: severalAtOnce.length,
      wallets: severalBought.size,
      share: share(sum(severalBought.values())),
    },
    earlyBought,
    earlySlot: Math.max(0, ...earlyBuys.map((m) => m.slot - creationSlot)),
    earlySeconds,
    earlyCut,
    windowSeconds,
    roundTrips,
    creatorSales,
    read: read.length,
    changed,
    lastSlot,
    beyond: moreAfter,
    earlyWithin,
  });

  return {
    completeness,
    sources,
    data: {
      ...blank,
      ...known,
      supply: base.toString(),
      creation: creationInfo,
      launchBlock: creationSlot,
      launchedAt: creationInfo.launchedAt,
      windowSeconds,
      windowSlots: lastSlot,
      moves: listed,
      movesInWindow: moves.length,
      summary,
      sameSlot,
      payerGroup,
      roundTrips,
      transactions: {
        wanted: wanted.length,
        read: read.length,
        failed,
        withoutChange,
        beyond,
        wholeHistory,
      },
      calls: meter.spent(),
      story,
    },
  };
}

type TokenAccountParsed = {
  type?: string;
  info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string } };
};

/**
 * Which moves are listed: every move of the creator, then the largest, then
 * the earliest, up to MAX_LISTED_MOVES, in time order. The same choice as the
 * EVM replay's.
 */
export function selectMoves<T extends DraftMove & { index: number }>(
  moves: readonly T[],
  creator: string | null,
): T[] {
  if (moves.length <= MAX_LISTED_MOVES) return [...moves];
  const chosen = new Set<T>();
  const add = (list: readonly T[], cap: number) => {
    for (const m of list) {
      if (chosen.size >= MAX_LISTED_MOVES || cap <= 0) break;
      if (!chosen.has(m)) {
        chosen.add(m);
        cap -= 1;
      }
    }
  };
  if (creator) {
    add(
      moves.filter((m) => m.actor === creator || m.counterparty === creator),
      MAX_CREATOR_MOVES,
    );
  }
  add(
    [...moves].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0)),
    MAX_LARGEST_MOVES,
  );
  add(moves, MAX_LISTED_MOVES);
  return moves.filter((m) => chosen.has(m));
}

// ── The story ───────────────────────────────────────────────────────────────

type StoryInput = {
  creation: SolanaLaunchCreation;
  creator: string | null;
  moves: readonly Timed[];
  kindOf: (owner: string) => ActorKind;
  programOf: ReadonlyMap<string, string | null>;
  share: (value: bigint) => number;
  creatorAtLaunch: bigint;
  /** What the creation's fee payer got in it, when the creator is not known. */
  payerAtLaunch: bigint;
  creationBought: ReadonlyMap<string, bigint>;
  sameSlot: SolanaLaunchGroup | null;
  payerGroup: (SolanaLaunchGroup & { payers: string[] }) | null;
  /** The creation is one of the transactions counted in `payerGroup`. */
  payerGroupWithCreation: boolean;
  bundle: LaunchSummary['bundle'];
  /** Every transaction of the window that delivered to BUNDLE_MIN_WALLETS wallets or more, together. */
  severalAtOnce?: { transactions: number; wallets: number; share: number };
  earlyBought: ReadonlyMap<string, bigint>;
  /** Slots from the creation to the last of those buys. */
  earlySlot: number;
  earlySeconds: number;
  earlyCut: boolean;
  /** Seconds of the last of the first buys. */
  earlyWithin: number;
  windowSeconds: number;
  roundTrips: readonly SolanaRoundTrip[];
  creatorSales: readonly Timed[];
  read: number;
  changed: number;
  lastSlot: number;
  beyond: boolean;
};

/**
 * What happened, in order, in a few plain sentences: amounts and times, never
 * a judgement. Addresses are shortened (`EPjF…Dt1v`); the data holds them whole.
 */
export function tellStory(input: StoryInput): SolanaLaunchStoryLine[] {
  const lines: (SolanaLaunchStoryLine & { order: number })[] = [];
  const { creation, creator, share } = input;
  const short = (a: string) => shortAddress(a);
  const add = (seconds: number, slot: number, text: string, order: number, transaction?: string) =>
    lines.push({ seconds, slot, text, order, ...(transaction ? { transaction } : {}) });

  add(
    0,
    0,
    creator === creation.payer
      ? `The token was created in transaction ${short(creation.signature)}, paid for by the creator ${short(creator)}.`
      : `The token was created in transaction ${short(creation.signature)}; ${short(creation.payer)} paid the fee${
          creator
            ? creation.signers.includes(creator)
              ? ` and the creator ${short(creator)} signed it`
              : `; the creator is ${short(creator)}`
            : ''
        }.`,
    0,
    creation.signature,
  );

  const minted = input.moves.find((m) => m.kind === 'mint' && m.transaction === creation.signature);
  if (minted) {
    const program = input.programOf.get(minted.actor);
    // Only a launchpad's or a market's name says something: an account of the
    // System Program (FhVo…, the DBC pool authority) is just an account.
    const known = program ? knownProgram(program) : undefined;
    const name =
      known && (known.kind === 'launchpad' || known.kind === 'amm') ? known.name : undefined;
    add(
      0,
      0,
      `${percent(share(minted.value))} of the supply was created on ${
        name
          ? `an account of ${name}`
          : input.kindOf(minted.actor) === 'wallet'
            ? 'the wallet'
            : 'the account'
      } ${short(minted.actor)}.`,
      1,
    );
  }

  if (creator && input.creatorAtLaunch > 0n) {
    const first = input.moves.find((m) => m.actor === creator && m.slot === creation.slot);
    const inCreation = first?.transaction === creation.signature;
    const paid =
      first?.kind === 'buy' && first.quote?.asset === 'SOL'
        ? ` for ${sol(first.quote.amount)}, fees included`
        : '';
    add(
      0,
      0,
      `The creator ${first?.kind === 'buy' ? 'bought' : 'received'} ${percent(share(input.creatorAtLaunch))} of the supply ${
        inCreation ? 'in the creation transaction' : 'in the creation slot'
      }${paid}.`,
      2,
    );
  }

  if (input.payerAtLaunch > 0n) {
    const first = input.moves.find(
      (m) => m.actor === creation.payer && m.transaction === creation.signature,
    );
    add(
      0,
      0,
      `The fee payer ${first?.kind === 'buy' ? 'bought' : 'received'} ${percent(share(input.payerAtLaunch))} of the supply in the creation transaction.`,
      2,
    );
  }

  if (input.creationBought.size > 0) {
    const payerAmong =
      creator !== null && creator !== creation.payer && input.creationBought.has(creation.payer);
    const total = percent(share(sum(input.creationBought.values())));
    add(
      0,
      0,
      payerAmong && input.creationBought.size === 1
        ? `The creation's fee payer ${short(creation.payer)} got ${total} of the supply in it.`
        : `The creation transaction ${input.creatorAtLaunch > 0n || input.payerAtLaunch > 0n ? 'also ' : ''}delivered ${total} of the supply to ${plural(
            input.creationBought.size,
            'other wallet',
          )}${payerAmong ? `, its fee payer ${short(creation.payer)} among them` : ''}.`,
      3,
    );
  }

  if (input.sameSlot) {
    const g = input.sameSlot;
    add(
      0,
      0,
      `In the creation slot, ${plural(g.wallets, creator ? 'wallet other than the creator' : 'wallet', creator ? 'wallets other than the creator' : 'wallets')} got ${percent(
        g.share,
      )} of the supply in ${plural(g.transactions, 'transaction')}${
        g.solSpent > 0
          ? `; their SOL balances fell by ${g.solSpent.toFixed(2)} SOL in them, fees included`
          : ''
      }.`,
      4,
    );
  }

  if (input.payerGroup && input.payerGroup.transactions > 0) {
    const g = input.payerGroup;
    const byCreator = creator !== null && g.payers.includes(creator);
    const byPayer = g.payers.includes(creation.payer) && creation.payer !== creator;
    const who =
      byCreator && byPayer
        ? `The creator and ${short(creation.payer)}, who paid for the creation,`
        : byCreator
          ? 'The creator'
          : `${short(creation.payer)}, who paid for the creation,`;
    // Only when the creation is one of the transactions counted in the group:
    // what it gave the fee payer itself is not.
    const withCreation = input.payerGroupWithCreation;
    add(
      0,
      0,
      `${who} paid for ${plural(g.transactions, 'transaction')}${
        withCreation ? ' (the creation among them)' : ''
      } that delivered ${percent(g.share)} of the supply to ${plural(
        g.wallets,
        creator ? 'wallet other than the creator' : 'other wallet',
        creator ? 'wallets other than the creator' : 'other wallets',
      )}.`,
      5,
    );
  }

  if (input.bundle) {
    const b = input.bundle;
    const tx = input.moves.find((m) => m.transaction === b.transaction);
    add(
      b.seconds,
      tx ? tx.slot - creation.slot : 0,
      `Transaction ${short(b.transaction)} delivered ${percent(b.share)} of the supply to ${plural(
        b.wallets,
        'wallet',
      )} at once.`,
      6,
      b.transaction,
    );
    const all = input.severalAtOnce;
    if (all && all.transactions > 1) {
      add(
        b.seconds,
        tx ? tx.slot - creation.slot : 0,
        `In all, ${all.transactions} transactions of the window read each delivered the token to ${BUNDLE_MIN_WALLETS} or more wallets at once: ${percent(
          all.share,
        )} of the supply to ${plural(all.wallets, 'wallet')}.`,
        6,
      );
    }
  }

  if (input.earlyBought.size > 0) {
    const who = plural(
      input.earlyBought.size,
      creator ? 'wallet other than the creator' : 'wallet',
      creator ? 'wallets other than the creator' : 'wallets',
    );
    const when = input.earlyCut
      ? `In the window read (${plural(input.lastSlot, 'slot')})`
      : `Within the first ${plural(input.earlySeconds, 'second')}`;
    add(
      input.earlyWithin,
      input.earlySlot,
      `${when}, ${who} bought ${percent(share(sum(input.earlyBought.values())))} of the supply in total.`,
      7,
    );
  }

  const largeTrips = [...input.roundTrips]
    .sort((a, b) => b.sold - a.sold)
    .slice(0, STORY_ROUND_TRIPS)
    .filter((t) => t.sold > 0);
  for (const t of largeTrips) {
    add(
      t.soldAt,
      t.soldSlot,
      `${t.address === creator ? 'The creator' : short(t.address)} bought ${percent(t.bought)} of the supply and sold ${percent(
        t.sold,
      )} in the window read, the first sale ${
        t.soldSlot === t.boughtSlot
          ? 'in the slot of its first buy'
          : `${plural(t.soldSlot - t.boughtSlot, 'slot')} after its first buy`
      }.`,
      8,
    );
  }
  if (input.roundTrips.length > largeTrips.length) {
    const fastest = Math.min(...input.roundTrips.map((t) => t.soldSlot - t.boughtSlot));
    add(
      input.windowSeconds,
      input.lastSlot,
      `${plural(input.roundTrips.length, 'wallet')} bought and then sold in the window read, the fastest ${plural(
        fastest,
        'slot',
      )} apart.`,
      9,
    );
  }

  for (const sale of input.creatorSales) {
    if (
      // Its sales from the first one on are told in its round trip.
      largeTrips.some((t) => t.address === sale.actor && sale.slot - creation.slot >= t.soldSlot)
    )
      continue;
    add(
      sale.seconds,
      sale.slot - creation.slot,
      `The creator sold ${percent(share(sale.value))} of the supply.`,
      8,
      sale.transaction,
    );
  }

  add(
    input.windowSeconds,
    input.lastSlot,
    `The window read ends ${plural(input.windowSeconds, 'second')} (${plural(input.lastSlot, 'slot')}) after the creation: ${plural(
      input.read,
      'transaction',
    )}, ${input.changed} of which moved this token${input.beyond ? '; later ones are not read' : ''}.`,
    10,
  );

  return lines
    .sort((a, b) => a.slot - b.slot || a.order - b.order)
    .map(({ seconds, slot, text, transaction }) => ({
      seconds,
      slot,
      text,
      ...(transaction ? { transaction } : {}),
    }));
}
