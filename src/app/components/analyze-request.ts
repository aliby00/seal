/** A real pons launch whose creator history and holders can be read in full. */
export const EXAMPLE_TOKEN = '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b';

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const ADDRESS_HINT =
  'Enter an address starting with 0x, followed by 40 hexadecimal characters.';

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
