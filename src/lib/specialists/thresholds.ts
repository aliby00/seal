/**
 * Where a fact starts to deserve attention, shared by the ten questions and
 * the report's opening ("In short"), so a fact the summary puts first is
 * never one a question files as nothing notable. Each is a line drawn on a
 * measured quantity, never a score: nothing here is added up.
 */

/** Share of what circulates (pools, curves, locks and burn left out) held by the largest wallet. */
export const LARGEST_WALLET_SHARE = 0.2;

/** Share of the whole supply still in curves and pools above which holder shares say little. */
export const MOSTLY_SET_ASIDE = 0.9;

/** Share of the whole supply the creator holds today. */
export const CREATOR_HOLDS_SHARE = 0.05;

/** Share of the supply wallets got together at launch (creation slot, or paid by the creator). */
export const GROUP_SHARE = 0.05;

/** Below this share of the supply, a group at launch is dust: not said in the summary. */
export const GROUP_SHARE_MIN = 0.01;

/** The creator's other tokens: this many dead, and at least half of them, is a pattern. */
export const DEAD_LAUNCHES_MIN = 3;
/** The creator's other launches, every pump.fun curve naming it counted: this many is a pattern. */
export const SERIAL_LAUNCHES_MIN = 20;

/** Trades per wallet holding the token today, over a day, above which trading is mostly back and forth. */
export const TRADES_PER_HOLDER = 10;
/** Below this many trades in a day, the ratio above says nothing. */
export const TRADES_MIN = 100;

/** Round trips at launch (bought, then sold back in the window read) worth saying. */
export const ROUND_TRIPS_MIN = 3;

/** A wallet first funded this close to the creation is fresh. */
export const FRESH_WALLET_SECONDS = 86_400;
/** Funded within this before the creation: recent, said, not filed as attention. */
export const RECENT_WALLET_SECONDS = 7 * 86_400;

/** Share of a pool's liquidity its LP holders can withdraw, above which who holds it matters. */
export const WITHDRAWABLE_SHARE = 0.5;
/** Burned or locked for good, at least this share of every pool read: no pull is possible. */
export const LOCKED_FOR_GOOD = 0.95;

/** Below this, a listed market's liquidity is the first thing to know about it. */
export const THIN_LIQUIDITY_USD = 1_000;
/** Below this, there is no market left to speak of. */
export const EMPTY_MARKET_USD = 50;

/** Buys over a day with no sale at all, above which "no sale" is a fact worth saying. */
export const BUYS_WITHOUT_SALE = 10;
