/*
 * SEAL extension — shared settings.
 *
 * Every file of the extension is a plain script that adds to one namespace,
 * `SealExt`, so the same code runs in the content script, the service worker
 * and the popup without a build step or a module loader.
 */
(function (root) {
  'use strict';
  const ns = (root.SealExt = root.SealExt || {});

  ns.config = Object.freeze({
    /** Where the glances come from. Overridable for local development only. */
    API_BASE: 'https://sealauth.dev',
    /** An override is accepted only when it points at this machine. */
    LOCAL_API: /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/,
    /** A glance is kept five minutes per token. */
    CACHE_TTL_MS: 5 * 60_000,
    /** After a 429 without Retry-After, nothing is asked for a minute. */
    BACKOFF_MS: 60_000,
    /** The hover card waits this long, so moving the pointer across a list asks nothing. */
    HOVER_DELAY_MS: 400,
    /** Time to move from the link to the card before it closes. */
    HOVER_GRACE_MS: 250,
    /** A request that takes longer is reported as failed. */
    REQUEST_TIMEOUT_MS: 45_000,
    /** The sites the overlay runs on, as the toolbar popup names them. */
    SITES: Object.freeze([
      { host: 'dexscreener.com', label: 'DexScreener (Robinhood Chain)' },
      { host: 'robinhoodchain.blockscout.com', label: 'Blockscout (Robinhood Chain)' },
      { host: 'ponsfamily.com', label: 'pons launchpad' },
    ]),
  });
})(globalThis);
