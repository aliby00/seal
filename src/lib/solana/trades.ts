import type { LaunchMove, LaunchMoveKind } from '../contracts/launch';
import { isOnCurve } from './address';
import { INCINERATOR, KNOWN_PROGRAMS, NATIVE_MINT } from './programs';
import { transactionKeys, type SolanaTransaction } from './rpc';

/**
 * What one Solana transaction did to a token, read from the balances the
 * node reports before and after it (`preTokenBalances`, `postTokenBalances`,
 * `preBalances`, `postBalances`). No instruction is decoded: whatever program
 * moved the tokens (pump.fun, a router, a bot's own program), the balances
 * say who gained and who lost.
 *
 * Holders are read from each token account's `owner` field, never derived
 * back: in the creation slot of 6qmo…pump, four buyers used token accounts
 * that are not their associated ones (tests/fixtures/solana/REFERENCE.md).
 */

export type ActorKind = LaunchMove['actorKind'];

/** One owner's change of the token's balance in a transaction. */
export type OwnerChange = {
  /** The token accounts' owner; the token account itself when the node did not name one. */
  owner: string;
  ownerNamed: boolean;
  /** Raw units, after minus before, over all its token accounts of the mint. */
  delta: bigint;
};

export type AssetChange = { delta: bigint; decimals: number };

export type TransactionFlows = {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** The fee payer: the first signer. */
  payer: string;
  signers: string[];
  /** Owners whose balance of the token changed, in the order the node listed them. */
  changes: OwnerChange[];
  /** Every token account of the mint the transaction touched, with its owner. */
  accounts: { account: string; owner: string }[];
  /** Sum of the changes: above zero tokens were created, below zero destroyed. */
  minted: bigint;
  /** The mint's account went from no lamports to some: this transaction created it. */
  createsMint: boolean;
  /** Lamports gained (or lost) by each account of the transaction, zero changes left out. */
  lamports: ReadonlyMap<string, bigint>;
  /** Other tokens each owner gained or lost, by mint (wrapped SOL included). */
  others: ReadonlyMap<string, ReadonlyMap<string, AssetChange>>;
  /** Every program the transaction ran, its inner instructions included. */
  programs: string[];
};

type Side = { owner: string | undefined; amount: bigint };

export function readFlows(tx: SolanaTransaction, mint: string): TransactionFlows {
  const keys = transactionKeys(tx);
  const meta = tx.meta;
  const signers = keys.slice(0, tx.transaction.message.header.numRequiredSignatures);

  const lamports = new Map<string, bigint>();
  if (meta) {
    keys.forEach((key, i) => {
      const pre = meta.preBalances[i];
      const post = meta.postBalances[i];
      if (pre === undefined || post === undefined || pre === post) return;
      lamports.set(key, (lamports.get(key) ?? 0n) + BigInt(post) - BigInt(pre));
    });
  }

  // Token balances by account index: an account created in the transaction
  // has no `pre` entry, one closed in it has no `post` entry.
  const target = new Map<number, { pre?: Side; post?: Side }>();
  const others = new Map<string, Map<string, AssetChange>>();
  for (const [side, list] of [
    ['pre', meta?.preTokenBalances ?? []],
    ['post', meta?.postTokenBalances ?? []],
  ] as const) {
    for (const balance of list) {
      const amount = BigInt(balance.uiTokenAmount.amount);
      if (balance.mint === mint) {
        const entry = target.get(balance.accountIndex) ?? {};
        entry[side] = { owner: balance.owner, amount };
        target.set(balance.accountIndex, entry);
        continue;
      }
      const owner = balance.owner ?? keys[balance.accountIndex] ?? '';
      const byMint = others.get(owner) ?? new Map<string, AssetChange>();
      const known = byMint.get(balance.mint) ?? {
        delta: 0n,
        decimals: balance.uiTokenAmount.decimals,
      };
      known.delta += side === 'pre' ? -amount : amount;
      byMint.set(balance.mint, known);
      others.set(owner, byMint);
    }
  }

  const byOwner = new Map<string, OwnerChange>();
  const accounts: { account: string; owner: string }[] = [];
  let minted = 0n;
  for (const [index, { pre, post }] of target) {
    const account = keys[index] ?? '';
    const named = post?.owner ?? pre?.owner;
    const owner = named ?? account;
    const delta = (post?.amount ?? 0n) - (pre?.amount ?? 0n);
    minted += delta;
    accounts.push({ account, owner });
    const change = byOwner.get(owner) ?? { owner, ownerNamed: named !== undefined, delta: 0n };
    change.delta += delta;
    byOwner.set(owner, change);
  }

  const programs = [
    ...new Set(
      [
        ...tx.transaction.message.instructions,
        ...(meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
      ].map((ix) => keys[ix.programIdIndex] ?? ''),
    ),
  ].filter((program) => program !== '');

  const mintIndex = keys.indexOf(mint);
  const createsMint =
    meta !== null &&
    mintIndex >= 0 &&
    meta.preBalances[mintIndex] === 0 &&
    (meta.postBalances[mintIndex] ?? 0) > 0;

  return {
    signature: tx.transaction.signatures[0] ?? '',
    slot: tx.slot,
    blockTime: tx.blockTime,
    payer: keys[0] ?? '',
    signers,
    changes: [...byOwner.values()].filter((c) => c.delta !== 0n),
    accounts,
    minted,
    createsMint,
    lamports,
    others,
    programs,
  };
}

/** Programs whose accounts hold a market's tokens: the launchpads' curves and the AMMs' pools. */
export const MARKET_PROGRAMS: ReadonlySet<string> = new Set(
  KNOWN_PROGRAMS.filter((p) => p.kind === 'launchpad' || p.kind === 'amm').map((p) => p.address),
);

/** Lock and vesting programs (Streamflow, Jupiter Lock), by address, with their names. */
const LOCK_PROGRAMS: ReadonlyMap<string, string> = new Map(
  KNOWN_PROGRAMS.filter((p) => p.kind === 'lock').map((p) => [p.address, p.name]),
);

/**
 * Who an owner is. A wallet is a key on the ed25519 curve, one somebody can
 * sign for; an address off the curve is derived by a program. It is a `pool`
 * when a known launchpad or AMM owns its account (the pump.fun curve is owned
 * by pump.fun), a `contract` otherwise (a pool's authority that holds no data,
 * a vault, a program's own account), and `burn` for the incinerator.
 *
 * `programOwner` is the program owning the owner's account, read on chain;
 * `undefined` when it was not read.
 */
export function ownerKind(owner: string, programOwner: string | null | undefined): ActorKind {
  if (owner === INCINERATOR) return 'burn';
  if (isOnCurve(owner)) return 'wallet';
  if (programOwner && MARKET_PROGRAMS.has(programOwner)) return 'pool';
  return 'contract';
}

/** A move of the supply in one transaction, before it is timed and measured. */
export type DraftMove = {
  kind: LaunchMoveKind;
  actor: string;
  counterparty: string;
  /** Raw units. */
  value: bigint;
  slot: number;
  blockTime: number | null;
  transaction: string;
  payer: string;
  quote: { asset: string; amount: bigint; decimals: number } | null;
  /**
   * The lock or vesting program the transaction ran (Streamflow, Jupiter
   * Lock), on a move outside any market: tokens put into or taken out of its
   * custody. Absent otherwise.
   */
  lock?: string;
};

const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * The moves of one transaction.
 *
 * - Tokens created (`minted` above zero) go first to the market that gained
 *   the most (pump.fun mints the whole supply to its curve), else to the
 *   largest gainer: a `mint` move.
 * - When a pool's balance changed (a curve owned by a launchpad, a pool owned
 *   by an AMM), that is the market: every other owner that gained bought
 *   from it, every one that lost sold to it.
 * - Without a pool, an off-curve account whose balance changed is the market
 *   only when something was paid for the tokens: a buy cost the buyer SOL or
 *   another token, a sale brought the seller some. Tokens that only changed
 *   hands are no trade: on BONK, the creator's deposits into Streamflow
 *   escrows (3LEjgMEm…, 16/12/2022) and a plain transfer (4t4zSDDL…) cost it
 *   fees and rent only, and read as 20 % of the supply sold back. Nor is a
 *   transaction that ran a lock program (Streamflow, Jupiter Lock): its moves
 *   name that program in `lock`.
 * - Tokens put into a market's account with another asset, in a transaction
 *   that ran a known launchpad or AMM and traded nothing, are liquidity: a
 *   `provide` (BONK's creator added BONK and USDC to Raydium, 4FrAbnEn…).
 * - Otherwise an owner that gained received the tokens from the owner that
 *   lost the most: an `allocation`.
 */
export function movesOf(
  flows: TransactionFlows,
  kindOf: (owner: string) => ActorKind,
  mint: string,
): DraftMove[] {
  const deltas = new Map(flows.changes.map((c) => [c.owner, c.delta]));
  const kind = new Map(flows.changes.map((c) => [c.owner, kindOf(c.owner)]));
  const base = {
    slot: flows.slot,
    blockTime: flows.blockTime,
    transaction: flows.signature,
    payer: flows.payer,
  };
  const moves: DraftMove[] = [];

  if (flows.minted > 0n) {
    const gainers = flows.changes.filter((c) => c.delta > 0n);
    const markets = gainers.filter((c) => {
      const k = kind.get(c.owner);
      return k === 'pool' || k === 'contract';
    });
    const pick = largest(markets.length > 0 ? markets : gainers, (c) => c.delta);
    if (pick) {
      moves.push({
        ...base,
        kind: 'mint',
        actor: pick.owner,
        counterparty: mint,
        value: flows.minted,
        quote: null,
      });
      deltas.set(pick.owner, pick.delta - flows.minted);
    }
  }

  const moved = [...deltas].filter(([, d]) => d !== 0n);
  const pooled = moved.some(([o]) => kind.get(o) === 'pool');
  const side: ActorKind = pooled ? 'pool' : 'contract';
  const markets = moved.filter(([o]) => kind.get(o) === side);
  const lock = pooled
    ? undefined
    : flows.programs.map((p) => LOCK_PROGRAMS.get(p)).find((name) => name !== undefined);

  const trades: DraftMove[] = [];
  if (markets.length > 0 && lock === undefined) {
    for (const [owner, delta] of moved) {
      if (kind.get(owner) === side) continue;
      const buy = delta > 0n;
      // The market that gave (for a buy) or took (for a sale) the most.
      const counterparty =
        largest(
          markets.filter(([, d]) => (buy ? d < 0n : d > 0n)),
          ([, d]) => abs(d),
        )?.[0] ??
        largest(markets, ([, d]) => abs(d))?.[0] ??
        '';
      trades.push({
        ...base,
        kind: buy ? 'buy' : 'sell',
        actor: owner,
        counterparty,
        value: abs(delta),
        quote: quoteOf(flows, owner, counterparty, buy),
      });
    }
  }
  if (pooled || trades.some((m) => m.quote !== null)) return [...moves, ...trades];

  // Nothing was traded: liquidity put into a market, or tokens passed on.
  const provided = new Set<string>();
  if (flows.programs.some((p) => MARKET_PROGRAMS.has(p))) {
    for (const [owner, delta] of moved) {
      if (delta >= 0n) continue;
      const pool = largest(
        moved.filter(
          ([o, d]) => d > 0n && kind.get(o) === 'contract' && pairedInto(flows, owner, o),
        ),
        ([, d]) => d,
      )?.[0];
      if (pool === undefined) continue;
      provided.add(pool);
      moves.push({
        ...base,
        kind: 'provide',
        actor: owner,
        counterparty: pool,
        value: -delta,
        quote: null,
      });
    }
  }
  for (const [owner, delta] of moved) {
    if (delta <= 0n || provided.has(owner)) continue;
    const giver = largest(
      moved.filter(([, d]) => d < 0n),
      ([, d]) => -d,
    )?.[0];
    moves.push({
      ...base,
      kind: 'allocation',
      actor: owner,
      counterparty: giver ?? mint,
      value: delta,
      quote: null,
      ...(lock !== undefined ? { lock } : {}),
    });
  }
  return moves;
}

/** `actor` gave `pool` another asset in the same transaction: a token it lost and the pool gained. */
function pairedInto(flows: TransactionFlows, actor: string, pool: string): boolean {
  const given = flows.others.get(actor);
  const taken = flows.others.get(pool);
  if (!given || !taken) return false;
  return [...given].some(([asset, c]) => c.delta < 0n && (taken.get(asset)?.delta ?? 0n) > 0n);
}

function largest<T>(list: readonly T[], size: (item: T) => bigint): T | undefined {
  let best: T | undefined;
  let bestSize = -1n;
  for (const item of list) {
    const s = size(item);
    if (s > bestSize) {
      best = item;
      bestSize = s;
    }
  }
  return best;
}

/** SOL an owner gained or lost in the transaction: its lamports and its wrapped SOL. */
export function solChange(flows: TransactionFlows, owner: string): bigint {
  return (
    (flows.lamports.get(owner) ?? 0n) + (flows.others.get(owner)?.get(NATIVE_MINT)?.delta ?? 0n)
  );
}

/**
 * What the actor paid (buy) or received (sale), in the asset the market
 * traded: the other token the market's own accounts gained or lost the most,
 * else SOL. When the actor's balance of that asset did not move the right
 * way (a router paid in wrapped SOL for a curve quoted in another token), its
 * SOL is tried; `null` when neither moved the right way.
 */
function quoteOf(
  flows: TransactionFlows,
  actor: string,
  market: string,
  buy: boolean,
): DraftMove['quote'] {
  const marketTokens = [...(flows.others.get(market) ?? new Map<string, AssetChange>())]
    .filter(([m, c]) => m !== NATIVE_MINT && c.delta !== 0n)
    .sort((a, b) => (abs(b[1].delta) > abs(a[1].delta) ? 1 : -1))
    .map(([m]) => m);
  for (const asset of [...marketTokens.slice(0, 1), 'SOL']) {
    const change =
      asset === 'SOL'
        ? solChange(flows, actor)
        : (flows.others.get(actor)?.get(asset)?.delta ?? 0n);
    if (buy ? change < 0n : change > 0n) {
      const decimals = asset === 'SOL' ? 9 : (flows.others.get(actor)?.get(asset)?.decimals ?? 0);
      return { asset, amount: abs(change), decimals };
    }
  }
  return null;
}
