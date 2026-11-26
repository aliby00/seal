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

/** A Photon link names a pool too (…/lp/<pair>). */
const PHOTON_PAIR = /^(?:https?:\/\/)?photon-sol\.tinyastro\.io\/.*\blp\//i;

export const PAIR_HINT =
  'This link names a trading pair, not the token, and the pair could not be looked up: paste the token’s address, shown on DexScreener under the pair.';

/** What the field says of a value it refuses: an EVM address and a pair link get their own words. */
export function addressHint(value: string): string {
  const v = value.trim();
  if (DEXSCREENER_PAIR.test(v) || PHOTON_PAIR.test(v)) return PAIR_HINT;
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
  if (isTokenAddress(v) || DEXSCREENER_PAIR.test(v) || PHOTON_PAIR.test(v)) return v;
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
 * The pool a pasted pair link names: a DexScreener page
 * (dexscreener.com/solana/<pair>) or a Photon one (…/lp/<pair>). `null` for
 * anything else. A DexScreener link may also carry the token itself.
 */
export function pairFromInput(value: string): string | null {
  const v = value.trim();
  if (!/^(?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\//i.test(v)) return null;
  let url: URL;
  try {
    url = new URL(/^https?:/i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  if (host === 'dexscreener.com' && path[0]?.toLowerCase() === 'solana' && path[1])
    return isTokenAddress(path[1]) ? path[1] : null;
  if (/(^|\.)photon-sol\.tinyastro\.io$/.test(host)) {
    const at = path.indexOf('lp');
    const pair = at >= 0 ? path[at + 1] : undefined;
    return pair && isTokenAddress(pair) ? pair : null;
  }
  return null;
}

/** DexScreener's public pairs endpoint: it answers any origin, no key. */
const PAIRS_URL = 'https://api.dexscreener.com/latest/dex/pairs/solana/';

type PairsAnswer = {
  pair?: { baseToken?: { address?: string } } | null;
  pairs?: { baseToken?: { address?: string } }[] | null;
};

/**
 * The token address to analyse for what was pasted: a pair link resolves to
 * the token its pool trades (DexScreener's pairs list), or to the address
 * itself when DexScreener knows no such pair (a DexScreener link can carry
 * the token). `null` with a pair the lookup could not answer for: the field
 * then says it is a pair address. Anything else is `tokenFromInput`'s.
 */
export async function resolveInput(
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const pair = pairFromInput(value);
  if (!pair) return tokenFromInput(value);
  try {
    const response = await fetcher(`${PAIRS_URL}${encodeURIComponent(pair)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const answer = (await response.json()) as PairsAnswer;
    const base = answer.pair?.baseToken?.address ?? answer.pairs?.[0]?.baseToken?.address;
    if (base && isTokenAddress(base)) return base;
    // No pair at that address: on DexScreener the link may name the token itself.
    return answer.pair || answer.pairs?.length ? null : pair;
  } catch {
    return null;
  }
}

/**
 * Fired by any entry point outside the workspace form (the entrance): the
 * form owns the request, so there is only ever one analysis in flight.
 */
export const ANALYZE_EVENT = 'seal:analyze';

/**
 * Fired by the entrance just before it asks for an analysis: the scene plays
 * its passage through the gate while the request runs.
 */
export const PASSAGE_EVENT = 'seal:passage';

export function requestAnalysis(address: string) {
  window.dispatchEvent(new Event(PASSAGE_EVENT));
  window.dispatchEvent(new CustomEvent<string>(ANALYZE_EVENT, { detail: address }));
}

/**
 * The passage through the gate, while it plays. The request starts at once;
 * only its outcome waits until the light covers the screen (`released`), so
 * the report is drawn behind the light and never cuts the passage short.
 */
let passage: { released: Promise<void> } | null = null;

export function beginPassage() {
  let release: () => void = () => undefined;
  const current = { released: new Promise<void>((resolve) => (release = resolve)) };
  passage = current;
  return {
    release: () => release(),
    end() {
      release();
      if (passage === current) passage = null;
    },
  };
}

/** Resolves once the passage, if one plays, lets the outcome show. */
export function passageReleased(): Promise<void> {
  return passage?.released ?? Promise.resolve();
}

/** Whether the entrance is moving the page itself. */
export function inPassage(): boolean {
  return passage !== null;
}

/** The address a reading can be shared and reopened at. */
export function readingUrl(token: string, origin: string = window.location.origin) {
  return `${origin}/?token=${token}#analysis`;
}
