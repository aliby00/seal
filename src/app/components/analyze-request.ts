import { base58 } from '@scure/base';

/**
 * Three reference tokens read on mainnet (tests/fixtures/solana/REFERENCE.json),
 * each showing a different part of a reading: a pump.fun launch whose creator
 * bought at launch and sold, a pump.fun token that graduated to PumpSwap, and
 * a Token-2022 mint whose extensions keep powers over its holders.
 */
export const EXAMPLES: readonly { token: string; name: string; shows: string }[] = [
  {
    token: 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump',
    name: 'The Poor Bull',
    shows: 'pump.fun launch',
  },
  {
    token: 'B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump',
    name: 'FIONA',
    shows: 'graduated to PumpSwap',
  },
  {
    token: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    name: 'PYUSD',
    shows: 'Token-2022 extensions',
  },
];

/** The first example, for the single "read an example" button. */
export const EXAMPLE_TOKEN = EXAMPLES[0]!.token;

/** Base58 (Bitcoin alphabet: no 0, O, I or l), 32 to 44 characters. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A Solana address: base58 that decodes to exactly 32 bytes. Case is kept and
 * matters. Says nothing of whether a token lives there: the server reads that.
 */
export function isTokenAddress(value: string): boolean {
  if (!BASE58.test(value)) return false;
  try {
    return base58.decode(value).length === 32;
  } catch {
    return false;
  }
}

export const ADDRESS_HINT =
  'Enter a Solana token address: 32 to 44 letters and digits, as the explorer shows it.';

/** An Ethereum-style address: what SEAL read before it moved to Solana. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const EVM_HINT =
  'SEAL now reads Solana tokens. This looks like an EVM address (0x…): paste the token’s Solana address instead.';

/** A DexScreener link names a trading pair, not the token. */
const DEXSCREENER_PAIR =
  /^(?:https?:\/\/)?(?:www\.)?dexscreener\.com\/solana\/[1-9A-HJ-NP-Za-km-z]{32,44}/i;

export const PAIR_HINT =
  'This DexScreener link names a trading pair, not the token: paste the token’s address, shown on DexScreener under the pair.';

/** What the field says of a value it refuses: an EVM address and a pair link get their own words. */
export function addressHint(value: string): string {
  const v = value.trim();
  if (DEXSCREENER_PAIR.test(v)) return PAIR_HINT;
  return EVM_ADDRESS.test(v) ? EVM_HINT : ADDRESS_HINT;
}

/**
 * The token address in what was pasted: the address itself, or the one a
 * pump.fun, Solscan, Birdeye, GMGN or Solana Explorer link carries. Traders
 * coming from X copy the link more often than the mint (audit, 26/11/2026).
 * A DexScreener link names a pair, not a token: it is left as it is, and the
 * field says why.
 */
export function tokenFromInput(value: string): string {
  const v = value.trim();
  if (isTokenAddress(v) || DEXSCREENER_PAIR.test(v)) return v;
  if (!/^(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}\//i.test(v)) return v;
  let path: string;
  try {
    path = new URL(/^https?:/i.test(v) ? v : `https://${v}`).pathname;
  } catch {
    return v;
  }
  // The last segment of the path that is an address; GMGN may prefix it ("sol/token/abc_<mint>").
  const segments = path
    .split('/')
    .flatMap((s) => s.split('_'))
    .reverse();
  return segments.find((s) => isTokenAddress(s)) ?? v;
}

/**
 * Fired by any entry point outside the workspace form (the entrance): the
 * form owns the request, so there is only ever one analysis in flight.
 */
export const ANALYZE_EVENT = 'seal:analyze';

export function requestAnalysis(address: string) {
  window.dispatchEvent(new CustomEvent<string>(ANALYZE_EVENT, { detail: address }));
}

/** The address a reading can be shared and reopened at. */
export function readingUrl(token: string, origin: string = window.location.origin) {
  return `${origin}/?token=${token}#analysis`;
}
