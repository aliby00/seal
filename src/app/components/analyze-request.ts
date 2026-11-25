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
