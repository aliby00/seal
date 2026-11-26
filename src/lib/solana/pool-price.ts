import { USDC_MINT, USDT_MINT } from '../market/solana';
import { PUMPSWAP_POOL_DISCRIMINATOR, decodePumpCurve, readAddress, readU64 } from './graduation';
import { startsWith } from './launchpads';
import {
  NATIVE_MINT,
  PUMP_FUN_PROGRAM,
  PUMP_SWAP_PROGRAM,
  isTokenProgram,
  pumpBondingCurveAddress,
} from './programs';
import { COMMITMENT, type Base64Data, type SolanaRpc } from './rpc';

/**
 * A token's price, market cap and liquidity read from its main pool on chain,
 * at one slot: the pool, its vaults, the mint and Pyth's SOL/USD in a single
 * getMultipleAccounts. DexScreener runs 10 to 60 s behind the chain; this is
 * what the pool says now.
 *
 * Read for the two kinds most tokens pasted trade in: pump.fun curves and
 * PumpSwap pools. Any other pool (Raydium, Meteora, Orca) keeps DexScreener's
 * figures, said as such on the page. Offsets come from pump.fun's IDLs and
 * were compared against real accounts on 26/11/2026
 * (tests/fixtures/solana/live-price/): the price each gives matched
 * DexScreener's within its lag.
 */

export type LivePoolKind = 'pump-curve' | 'pumpswap';

/** What one read of a pool says, at one slot. */
export type PoolPrice = {
  pool: string;
  kind: LivePoolKind;
  slot: number;
  /** The token's price in its quote asset, whole units. */
  priceQuote: number;
  quoteMint: string;
  /** The quote asset in dollars: 1 for USDC and USDT, Pyth's SOL/USD (or the hint) for SOL. */
  quoteUsd: number;
  priceUsd: number;
  /** Both sides of the pool in dollars; `null` for a curve. */
  liquidityUsd: number | null;
  /** The quote a curve holds, in dollars; `null` for a pool. */
  curveLiquidityUsd: number | null;
  /** The mint's supply in whole tokens, read in the same call. */
  supply: number;
};

// ── Pyth SOL/USD ────────────────────────────────────────────────────────────

/**
 * Pyth's sponsored SOL/USD price feed account (Pyth Solana receiver, shard 0),
 * updated every few seconds. `PriceUpdateV2`: discriminator, write authority
 * (8), verification level (40: 1 Full, or 0 Partial followed by a u8), then
 * the message: feed id, price (i64), conf (u64), exponent (i32), publish
 * time (i64). Read on 26/11/2026: level 1, feed id ef0d8b6f…, $70.99.
 */
export const PYTH_SOL_USD_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
export const PYTH_RECEIVER_PROGRAM = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
export const PYTH_SOL_USD_FEED_ID =
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** A Pyth price older than this is not used. */
export const PYTH_MAX_AGE_S = 60;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SOL in dollars from Pyth's account, `null` when it is not that feed or too old. */
export function decodePythSolUsd(
  owner: string,
  bytes: Uint8Array,
  nowS: number,
): { usd: number; publishTime: number } | null {
  if (owner !== PYTH_RECEIVER_PROGRAM || bytes.length < 42) return null;
  const level = bytes[40];
  const at = level === 1 ? 41 : level === 0 ? 42 : -1;
  if (at < 0 || bytes.length < at + 60) return null;
  if (hex(bytes.subarray(at, at + 32)) !== PYTH_SOL_USD_FEED_ID) return null;
  const v = view(bytes);
  const price = Number(v.getBigInt64(at + 32, true));
  const exponent = v.getInt32(at + 48, true);
  const publishTime = Number(v.getBigInt64(at + 52, true));
  const usd = price * 10 ** exponent;
  if (!(usd > 0) || nowS - publishTime > PYTH_MAX_AGE_S) return null;
  return { usd, publishTime };
}

// ── Pools ───────────────────────────────────────────────────────────────────

/** Quotes a price can be put in dollars from: SOL (through Pyth), USDC, USDT. */
const QUOTE_DECIMALS: Readonly<Record<string, number>> = {
  [NATIVE_MINT]: 9,
  [USDC_MINT]: 6,
  [USDT_MINT]: 6,
};

/** What a pool account says once and for all: its kind, sides and vaults. */
export type PoolShape = {
  kind: LivePoolKind;
  /** Whether the token is the pool's first mint (PumpSwap's base). */
  tokenFirst: boolean;
  quoteMint: string;
  /** Vaults read beside the pool, the token's first; `null` when the pool account gives the reserves. */
  vaults: readonly [string, string] | null;
};

/** The two mints and vaults of a vault pool, at their offsets. */
function sides(
  kind: LivePoolKind,
  bytes: Uint8Array,
  mint: string,
  mints: readonly [number, number],
  vaults: readonly [number, number],
): PoolShape | null {
  const first = readAddress(bytes, mints[0]);
  const second = readAddress(bytes, mints[1]);
  const tokenFirst = first === mint;
  if (!tokenFirst && second !== mint) return null;
  const quoteMint = tokenFirst ? second : first;
  if (QUOTE_DECIMALS[quoteMint] === undefined) return null;
  const v = [readAddress(bytes, vaults[0]), readAddress(bytes, vaults[1])] as const;
  return { kind, tokenFirst, quoteMint, vaults: tokenFirst ? [v[0], v[1]] : [v[1], v[0]] };
}

/**
 * The shape of `pool` for `mint`, from its account: `null` when the program
 * is not one read here, the account is not a pool of that mint, or its quote
 * is not SOL, USDC or USDT.
 *
 * - pump.fun curve (`BondingCurve`, graduation.ts): reserves in the account;
 *   the account holds no mint, so it must be the mint's derived curve.
 * - PumpSwap `Pool` (idl/pump_amm.json): base 43, quote 75, base vault 139,
 *   quote vault 171 (checked: each vault holds its side's mint). Protocol
 *   and creator fees leave the pool at each swap: the vaults are the reserves.
 */
export function poolShape(
  pool: string,
  owner: string,
  bytes: Uint8Array,
  mint: string,
): PoolShape | null {
  switch (owner) {
    case PUMP_FUN_PROGRAM: {
      const curve = decodePumpCurve(bytes);
      if (!curve || curve.complete || pool !== pumpBondingCurveAddress(mint)) return null;
      const quoteMint = curve.quoteMint ?? NATIVE_MINT;
      if (QUOTE_DECIMALS[quoteMint] === undefined) return null;
      return { kind: 'pump-curve', tokenFirst: true, quoteMint, vaults: null };
    }
    case PUMP_SWAP_PROGRAM:
      if (bytes.length < 211 || !startsWith(bytes, PUMPSWAP_POOL_DISCRIMINATOR)) return null;
      return sides('pumpswap', bytes, mint, [43, 75], [139, 171]);
    default:
      return null;
  }
}

/** A token account's amount, `null` when it is not an account of `mint`. */
export function vaultAmount(owner: string, bytes: Uint8Array, mint: string): bigint | null {
  if (!isTokenProgram(owner) || bytes.length < 72) return null;
  if (readAddress(bytes, 0) !== mint) return null;
  return readU64(bytes, 64);
}

/** Raw reserves, token side first; a curve's real quote beside its virtual reserves. */
type Reserves = { token: bigint; quote: bigint; curveQuote?: bigint };

/** The reserves of a pool of this shape, from its account and its vault amounts. */
export function poolReserves(
  shape: PoolShape,
  bytes: Uint8Array,
  vaults: readonly [bigint, bigint] | null,
): Reserves | null {
  switch (shape.kind) {
    case 'pump-curve': {
      const curve = decodePumpCurve(bytes);
      if (!curve || curve.complete) return null;
      return {
        token: curve.virtualTokenReserves,
        quote: curve.virtualQuoteReserves,
        curveQuote: curve.realQuoteReserves,
      };
    }
    case 'pumpswap':
      return vaults ? { token: vaults[0], quote: vaults[1] } : null;
  }
}

/** The price and liquidity a pool's reserves give, in its quote and in dollars. */
export function priceOf(
  reserves: Reserves,
  tokenDecimals: number,
  quoteDecimals: number,
  quoteUsd: number,
): Pick<PoolPrice, 'priceQuote' | 'priceUsd' | 'liquidityUsd' | 'curveLiquidityUsd'> | null {
  const scale = 10 ** (tokenDecimals - quoteDecimals);
  const priceQuote =
    reserves.token > 0n ? (Number(reserves.quote) / Number(reserves.token)) * scale : 0;
  if (!(priceQuote > 0) || !Number.isFinite(priceQuote)) return null;
  const priceUsd = priceQuote * quoteUsd;
  const quoteSide = (raw: bigint) => (Number(raw) / 10 ** quoteDecimals) * quoteUsd;
  if (reserves.curveQuote !== undefined) {
    return {
      priceQuote,
      priceUsd,
      liquidityUsd: null,
      curveLiquidityUsd: round2(quoteSide(reserves.curveQuote)),
    };
  }
  const tokenSide = (Number(reserves.token) / 10 ** tokenDecimals) * priceUsd;
  return {
    priceQuote,
    priceUsd,
    liquidityUsd: round2(quoteSide(reserves.quote) + tokenSide),
    curveLiquidityUsd: null,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// ── Reading ─────────────────────────────────────────────────────────────────

type RawAccount = { owner: string; data: Base64Data } | null;
type MultipleAnswer = { context: { slot: number }; value: RawAccount[] };

/** Shapes never change: kept per pool, so a refresh is one call. */
const shapes = new Map<string, PoolShape>();
const MAX_SHAPES = 2_000;

export function forgetPoolShapes(): void {
  shapes.clear();
}

function bytesOf(account: RawAccount): Uint8Array | null {
  if (!account || !Array.isArray(account.data) || account.data[1] !== 'base64') return null;
  return Uint8Array.from(Buffer.from(account.data[0], 'base64'));
}

/** The params of the one call a read makes: base64, `confirmed`, as the rest of the client asks. */
export function poolReadParams(addresses: readonly string[]): unknown[] {
  return [addresses, { encoding: 'base64', commitment: COMMITMENT }];
}

export type ReadPoolPriceOptions = {
  /** SOL in dollars when Pyth's account cannot be used (DexScreener's pair: priceUsd / priceNative). */
  solUsdHint?: number | null;
  now?: () => Date;
};

/**
 * The price of `mint` in `pool` now: one getMultipleAccounts (two the first
 * time a vault pool is seen). `null` when the pool is not of a kind read here
 * (the caller keeps DexScreener's figures); throws when the node fails.
 */
export async function readPoolPrice(
  rpc: SolanaRpc,
  mint: string,
  pool: string,
  options: ReadPoolPriceOptions = {},
): Promise<PoolPrice | null> {
  const now = (options.now ?? (() => new Date()))();
  const read = (extra: readonly string[]) =>
    rpc.call<MultipleAnswer>(
      'getMultipleAccounts',
      poolReadParams([pool, mint, PYTH_SOL_USD_ACCOUNT, ...extra]),
    );
  let shape = shapes.get(pool);
  let answer = await read(shape?.vaults ?? []);
  if (!Array.isArray(answer?.value) || typeof answer.context?.slot !== 'number') return null;
  if (!shape) {
    const account = answer.value[0] ?? null;
    const bytes = bytesOf(account);
    const found = account && bytes ? poolShape(pool, account.owner, bytes, mint) : null;
    if (!found) return null;
    if (shapes.size >= MAX_SHAPES) shapes.clear();
    shapes.set(pool, found);
    shape = found;
    if (found.vaults) answer = await read(found.vaults);
    if (!Array.isArray(answer?.value)) return null;
  }
  const [poolAccount, mintAccount, pythAccount, tokenVault, quoteVault] = answer.value;
  const poolBytes = bytesOf(poolAccount ?? null);
  const mintBytes = bytesOf(mintAccount ?? null);
  if (!poolAccount || !poolBytes || !mintAccount || !mintBytes) return null;
  if (!isTokenProgram(mintAccount.owner) || mintBytes.length < 82) return null;
  const tokenDecimals = mintBytes[44] ?? 0;
  const supply = Number(readU64(mintBytes, 36)) / 10 ** tokenDecimals;

  let vaults: [bigint, bigint] | null = null;
  if (shape.vaults) {
    const t = tokenVault ? bytesOf(tokenVault) : null;
    const q = quoteVault ? bytesOf(quoteVault) : null;
    const tokenAmount = tokenVault && t ? vaultAmount(tokenVault.owner, t, mint) : null;
    const quoteAmount = quoteVault && q ? vaultAmount(quoteVault.owner, q, shape.quoteMint) : null;
    if (tokenAmount === null || quoteAmount === null) {
      shapes.delete(pool);
      return null;
    }
    vaults = [tokenAmount, quoteAmount];
  }
  const reserves = poolReserves(shape, poolBytes, vaults);
  if (!reserves) return null;

  let quoteUsd = 1;
  if (shape.quoteMint === NATIVE_MINT) {
    const pythBytes = pythAccount ? bytesOf(pythAccount) : null;
    const pyth =
      pythAccount && pythBytes
        ? decodePythSolUsd(pythAccount.owner, pythBytes, Math.floor(now.getTime() / 1000))
        : null;
    const usd = pyth?.usd ?? options.solUsdHint ?? null;
    if (!usd || !(usd > 0)) return null;
    quoteUsd = usd;
  }
  const price = priceOf(reserves, tokenDecimals, QUOTE_DECIMALS[shape.quoteMint] ?? 9, quoteUsd);
  if (!price) return null;
  return {
    pool,
    kind: shape.kind,
    slot: answer.context.slot,
    quoteMint: shape.quoteMint,
    quoteUsd,
    supply,
    ...price,
  };
}
