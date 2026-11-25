import type { Completeness, SourceRef, TokenReport } from '@/lib/contracts';
import type { SolanaHolder } from '@/lib/solana/holders';
import type { OwnerRoleKind } from '@/lib/solana/roles';
import type { TokenPower } from '@/lib/solana/token-types';
import { displayName } from '@/lib/specialists/names';
import { short } from './explorer';

/**
 * What the report screen draws of a Solana reading, taken from the collected
 * report (`TokenReport`) and nothing else. Each block keeps its completeness
 * and the note its source gave: a block that was not read is drawn as "not
 * read", never as zero, and a partial read never turns an absence into a
 * fact ("no sale" is said only when every move was read).
 *
 * Shares are fractions of the whole supply, from 0 to 1; amounts in raw units
 * are turned into shares here so the screen never needs the decimals.
 * Addresses keep their case: base58 is case-sensitive.
 *
 * Lists are capped so the response stays small; each cap says how many were
 * left out (`more`).
 *
 * Names and symbols come from the chain, chosen by whoever made the token:
 * each goes through `displayName`, as in the report header, so a name that
 * reads as a verdict ("SAFE 100X") is withheld and invisible or bidi
 * characters are taken out.
 */

export type ViewBlock<T> = { read: Completeness; note?: string; data: T };

export type PowerView = Pick<TokenPower, 'power' | 'status' | 'holder' | 'sentence'>;

export type HolderView = {
  address: string;
  /** Part of the whole supply. */
  ofSupply: number;
  /** Part of what circulates (supply less curves, pools, locks and burn). */
  share: number;
  owner: OwnerRoleKind;
  /** What the chain names it, when it says more than "wallet". */
  name: string | null;
};

export type SetAsideView = {
  address: string;
  role: string;
  share: number | null;
  name: string | null;
};

export type PoolView = {
  pool: string;
  /** "PumpSwap", "Raydium CPMM", "Orca Whirlpool"… */
  type: string;
  known: boolean;
  burned: number | null;
  locked: number | null;
  withdrawable: number | null;
  note: string | null;
};

export type MoveView = {
  signature: string;
  kind: 'buy' | 'sell' | 'locked' | 'unlocked' | 'sent' | 'received' | 'burned';
  /** Part of the supply, when the supply was read. */
  share: number | null;
  at: string | null;
};

export type OtherTokenView = {
  mint: string;
  name: string | null;
  symbol: string | null;
  launchpad: string | null;
  launchedAt: string | null;
  outcome: 'graduated' | 'dead' | 'active' | 'unknown';
  trades24h: number | null;
};

export type FundedView = {
  wallet: string;
  /** SOL the creator sent it in the window. */
  sol: number | null;
  /** What it did with the token, shares of supply; `null` when not read. */
  bought: number | null;
  sold: number | null;
  holdsNow: number | null;
  /** Whether all its trades of the token were read. */
  complete: boolean;
};

export type GroupView = {
  wallets: number;
  share: number;
  /** What the wallets read today hold, capped at what they got: a floor when some were not read. */
  heldNow: number | null;
  /** How many of them were not read today. */
  unread: number;
  soldInWindow: number;
  addresses: string[];
};

export type SolanaView = {
  mint: ViewBlock<{
    program: 'spl-token' | 'token-2022';
    decimals: number;
    supply: string;
    /** Token-2022 extensions, by name; empty for an SPL Token mint. */
    extensions: string[];
    metadata: {
      /** `null` when none was set, or when it was withheld. */
      name: string | null;
      symbol: string | null;
      /** A name or symbol was set but reads as a verdict or advice: not repeated. */
      withheld: boolean;
      from: 'tokenMetadata' | 'metaplex';
      mutable: boolean;
      updateAuthority: string | null;
    } | null;
    gaps: string[];
  } | null>;
  powers: PowerView[];
  creator: ViewBlock<{
    address: string | null;
    from: 'pump-curve' | 'creation-transaction' | 'metadata-update-authority' | null;
    creation: { signature: string; slot: number; at: string | null; payer: string } | null;
  }>;
  onToken: ViewBlock<{
    bought: number | null;
    sold: number | null;
    received: number | null;
    burned: number | null;
    locked: number | null;
    holdsNow: number | null;
    moves: MoveView[];
    more: number;
    transactions: { listed: number; read: number };
  }> | null;
  history: ViewBlock<{
    launched: number;
    counts: { graduated: number; dead: number; active: number; unknown: number };
    /** Every pump.fun curve naming the creator was listed. */
    curvesListed: boolean;
    /** The creator's whole transaction history was reached. */
    historyComplete: boolean;
    tokens: OtherTokenView[];
    more: number;
  }> | null;
  linked: ViewBlock<{
    funding: 'found' | 'none-seen' | 'not-reached';
    firstFunding: { from: string; sol: number | null; signature: string; at: string | null } | null;
    window: { from: string; to: string } | null;
    funded: FundedView[];
    more: number;
  }> | null;
  holders: ViewBlock<{
    method: 'all-accounts' | 'largest-accounts' | 'none';
    holderCount: number | null;
    holdersAtLeast: number;
    top: HolderView[];
    setAside: SetAsideView[];
    ofSupply: {
      largestWallet: number | null;
      top10Wallets: number | null;
      pools: number | null;
      curves: number | null;
      burned: number | null;
      locked: number | null;
    };
    creator: { address: string; ofSupply: number } | null;
  }>;
  market: ViewBlock<{
    pair: string | null;
    dex: string | null;
    pairedWith: string | null;
    marketCapUsd: number | null;
    pairCreatedAt: string | null;
  }>;
  launchpad: ViewBlock<{ name: string; account: string | null } | null>;
  graduation: ViewBlock<{
    graduated: boolean | null;
    progress: number | null;
    basis: 'tokens-sold' | 'quote-raised' | null;
    destination: { pool: string; name: string } | null;
  }> | null;
  liquidity: ViewBlock<{ pools: PoolView[] }>;
  launch: ViewBlock<{
    creation: { signature: string; slot: number; at: string | null; payer: string } | null;
    sameSlot: GroupView | null;
    payerGroup: GroupView | null;
  }>;
  failed: { read: string; note: string }[];
};

/** Caps on the lists the screen draws. */
export const TOP_HOLDERS = 10;
export const MOVES_SHOWN = 12;
export const OTHER_TOKENS_SHOWN = 20;
export const FUNDED_SHOWN = 10;

const noteOf = (sources: readonly SourceRef[]) => sources.find((s) => s.note)?.note;

function block<T>(
  sourced: { completeness: Completeness; sources: readonly SourceRef[] },
  data: T,
): ViewBlock<T> {
  const note = noteOf(sourced.sources);
  return { read: sourced.completeness, ...(note ? { note } : {}), data };
}

const SHARE_SCALE = 1_000_000n;

/**
 * `raw / supply`, rounded down to six places; `null` when either cannot be
 * read. A positive amount below one millionth is kept at one millionth: a
 * move that happened is never drawn as 0 % (PYUSD's creator received a few
 * units, 25/11/2026).
 */
export function shareOf(
  raw: string | null | undefined,
  supply: string | null | undefined,
): number | null {
  if (raw == null || supply == null) return null;
  try {
    const total = BigInt(supply);
    if (total <= 0n) return null;
    const amount = BigInt(raw);
    if (amount > 0n && amount * SHARE_SCALE < total) return 1 / Number(SHARE_SCALE);
    return Number((amount * SHARE_SCALE) / total) / Number(SHARE_SCALE);
  } catch {
    return null;
  }
}

/** Lamports to SOL; `null` when the string is not an amount. */
export function solOf(lamports: string | null | undefined): number | null {
  if (lamports == null) return null;
  try {
    return Number(BigInt(lamports)) / 1e9;
  } catch {
    return null;
  }
}

const iso = (seconds: number | null | undefined): string | null =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;

/**
 * An amount read from the moves: a positive amount is a fact; zero is one only
 * when every move was read. A partial read that saw none leaves it unknown
 * (Meteora DBC 8xKZ…, 2 of 16 transactions read, 25/11/2026).
 */
function moved(raw: string, supply: string | null, complete: boolean): number | null {
  const share = shareOf(raw, supply);
  if (share === null) return null;
  if (raw === '0') return complete ? 0 : null;
  return share;
}

const POOL_TYPE: Record<string, string> = {
  pumpswap: 'PumpSwap',
  'raydium-amm-v4': 'Raydium AMM',
  'raydium-cpmm': 'Raydium CPMM',
  'raydium-clmm': 'Raydium CLMM',
  'meteora-damm-v2': 'Meteora DAMM v2',
  'meteora-damm-v1': 'Meteora DAMM v1',
  'meteora-dlmm': 'Meteora DLMM',
  'orca-whirlpool': 'Orca Whirlpool',
  other: 'Other pool',
};

function group(g: TokenReport['launch']['data']['sameSlot']): GroupView | null {
  if (!g) return null;
  return {
    wallets: g.wallets,
    share: g.share,
    heldNow: g.heldNow,
    unread: g.unread,
    soldInWindow: g.soldInWindow,
    addresses: g.addresses.slice(0, 10),
  };
}

/** The token's name and symbol as the page shows them, and whether one was withheld. */
function shownNames(rawName: string, rawSymbol: string) {
  const name = displayName(rawName);
  const symbol = displayName(rawSymbol);
  const set = (raw: string) => raw.trim().length > 0;
  return {
    name,
    symbol,
    withheld: (set(rawName) && name === null) || (set(rawSymbol) && symbol === null),
  };
}

/** The token the main pair trades against: its symbol, or its address when the symbol is withheld. */
function pairedWith(token: TokenReport['market']['data']['pairedWith']): string | null {
  if (!token?.symbol) return null;
  return displayName(token.symbol) ?? (token.address ? short(token.address) : null);
}

export function toSolanaView(report: TokenReport): SolanaView {
  const mint = report.mint.data;
  const supply = mint?.supply ?? report.holders.data.supply ?? null;

  const creation = report.creator.data.creation;
  const onToken = report.creatorOnToken;
  const history = report.creatorHistory;
  const linked = report.linkedWallets;
  const holders = report.holders.data;
  const launch = report.launch.data;

  const onTokenView: SolanaView['onToken'] = onToken
    ? (() => {
        const d = onToken.data;
        const s = d.supply ?? supply;
        const complete = onToken.completeness === 'full';
        return block(onToken, {
          bought: moved(d.bought, s, complete),
          sold: moved(d.sold, s, complete),
          received: moved(d.received, s, complete),
          burned: moved(d.burned, s, complete),
          locked: moved(d.locked, s, complete),
          holdsNow: d.holdsNow === null ? null : shareOf(d.holdsNow, s),
          moves: d.moves.slice(0, MOVES_SHOWN).map((m) => ({
            signature: m.signature,
            kind: m.kind,
            share: m.share ?? shareOf(m.amount, s),
            at: iso(m.blockTime),
          })),
          more: Math.max(0, d.moves.length - MOVES_SHOWN),
          transactions: d.transactions,
        });
      })()
    : null;

  const historyView: SolanaView['history'] = history
    ? block(history, {
        launched: history.data.counts.launched,
        counts: {
          graduated: history.data.counts.graduated,
          dead: history.data.counts.dead,
          active: history.data.counts.active,
          unknown: history.data.counts.unknown,
        },
        curvesListed: history.data.scanned.pumpCurvesListed,
        historyComplete: history.data.scanned.signaturesComplete,
        tokens: history.data.tokens.slice(0, OTHER_TOKENS_SHOWN).map((t) => ({
          mint: t.mint,
          name: displayName(t.name),
          symbol: displayName(t.symbol),
          launchpad: t.launchpad,
          launchedAt: t.launchedAt,
          outcome: t.outcome,
          trades24h: t.trades24h,
        })),
        more: Math.max(0, history.data.tokens.length - OTHER_TOKENS_SHOWN),
      })
    : null;

  const linkedView: SolanaView['linked'] = linked
    ? block(linked, {
        funding: linked.data.funding,
        firstFunding: linked.data.firstFunding
          ? {
              from: linked.data.firstFunding.from,
              sol: solOf(linked.data.firstFunding.lamports),
              signature: linked.data.firstFunding.signature,
              at: iso(linked.data.firstFunding.blockTime),
            }
          : null,
        window: linked.data.window
          ? { from: iso(linked.data.window.from)!, to: iso(linked.data.window.to)! }
          : null,
        funded: linked.data.funded.slice(0, FUNDED_SHOWN).map((f) => ({
          wallet: f.wallet,
          sol: solOf(f.lamports),
          bought: f.onToken ? moved(f.onToken.bought, supply, f.onToken.complete) : null,
          sold: f.onToken ? moved(f.onToken.sold, supply, f.onToken.complete) : null,
          holdsNow: f.onToken?.holdsNow != null ? shareOf(f.onToken.holdsNow, supply) : null,
          complete: f.onToken?.complete ?? false,
        })),
        more: Math.max(0, linked.data.funded.length - FUNDED_SHOWN),
      })
    : null;

  const graduation = report.graduation;
  const pad = report.launchpad.data.launchpad;

  return {
    mint: block(
      report.mint,
      mint
        ? {
            program: mint.program,
            decimals: mint.decimals,
            supply: mint.supply,
            extensions: mint.extensions.map((e) => e.extension),
            metadata: mint.metadata
              ? {
                  ...shownNames(mint.metadata.name, mint.metadata.symbol),
                  from: mint.metadata.source,
                  mutable: mint.metadata.isMutable,
                  updateAuthority: mint.metadata.updateAuthority,
                }
              : null,
            gaps: mint.gaps,
          }
        : null,
    ),
    powers: report.powers.map(({ power, status, holder, sentence }) => ({
      power,
      status,
      holder,
      sentence,
    })),
    creator: block(report.creator, {
      address: report.creator.data.creator,
      from: report.creator.data.from,
      creation: creation
        ? {
            signature: creation.signature,
            slot: creation.slot,
            at: iso(creation.blockTime),
            payer: creation.feePayer,
          }
        : null,
    }),
    onToken: onTokenView,
    history: historyView,
    linked: linkedView,
    holders: block(report.holders, {
      method: holders.method,
      holderCount: holders.holderCount,
      holdersAtLeast: holders.holdersAtLeast,
      // `top` is typed through the EVM holders shape too: these are Solana holders.
      top: (holders.top as SolanaHolder[])
        .filter((h) => h.owner.kind === 'wallet' || h.owner.kind === 'program-account')
        .slice(0, TOP_HOLDERS)
        .map((h) => ({
          address: h.address,
          ofSupply: h.ofSupply,
          share: h.share,
          owner: h.owner.kind,
          name: h.owner.kind === 'wallet' ? null : h.owner.name,
        })),
      setAside: (holders.setAside ?? []).map((s) => ({
        address: s.address,
        role: s.role,
        share: s.share,
        name: s.name ?? null,
      })),
      ofSupply: holders.ofSupply,
      creator: holders.creator
        ? { address: holders.creator.address, ofSupply: holders.creator.ofSupply }
        : null,
    }),
    market: block(report.market, {
      pair: report.market.data.pair,
      dex: report.market.data.dex,
      pairedWith: pairedWith(report.market.data.pairedWith),
      marketCapUsd: report.market.data.marketCapUsd,
      pairCreatedAt: report.market.data.pairCreatedAt,
    }),
    launchpad: block(
      report.launchpad,
      pad ? { name: pad.name, account: report.launchpad.data.account } : null,
    ),
    graduation: graduation
      ? block(graduation, {
          graduated: graduation.data.graduated,
          progress: graduation.data.progress,
          basis: graduation.data.progressBasis,
          destination: graduation.data.destination
            ? { pool: graduation.data.destination.pool, name: graduation.data.destination.name }
            : null,
        })
      : null,
    liquidity: block(report.liquidity, {
      pools: report.liquidity.data.pools.map((p) => ({
        pool: p.pool,
        type: p.programName ?? POOL_TYPE[p.kind] ?? 'Other pool',
        known: p.known,
        burned: p.burnedShare,
        locked: p.lockedShare,
        withdrawable: p.withdrawableShare,
        note: p.note,
      })),
    }),
    launch: block(report.launch, {
      creation: launch.creation
        ? {
            signature: launch.creation.signature,
            slot: launch.creation.slot,
            at: launch.creation.launchedAt,
            payer: launch.creation.payer,
          }
        : null,
      sameSlot: group(launch.sameSlot),
      payerGroup: group(launch.payerGroup),
    }),
    failed: (report.failedReads ?? []).map(({ read, note }) => ({ read, note })),
  };
}
