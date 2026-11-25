/*
 * Finding Solana tokens on a page: first in the page's own URL, then in links
 * that point to a token page. Only these shapes are recognised; a bare
 * address in text is never read, and a transaction signature (64 bytes)
 * never passes for an address (32 bytes).
 *
 * Solana addresses are base58 and case-sensitive: an address is kept exactly
 * as the page writes it, never lower-cased.
 */
(function (root) {
  'use strict';
  const ns = (root.SealExt = root.SealExt || {});

  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
  /** 32 bytes take 32 to 44 base58 characters. */
  const ADDRESS = `(${BASE58}{32,44})`;
  /** The address must end the path segment: no longer base58 string hides behind it. */
  const END = `(?!${BASE58})(?:[/?#]|$)`;

  /** How many bytes a base58 string decodes to; -1 for a character outside the alphabet. */
  function decodedLength(value) {
    const bytes = [];
    for (const char of value) {
      let carry = ALPHABET.indexOf(char);
      if (carry < 0) return -1;
      for (let i = 0; i < bytes.length; i += 1) {
        carry += bytes[i] * 58;
        bytes[i] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    // Each leading "1" is a zero byte.
    let zeros = 0;
    while (zeros < value.length && value[zeros] === '1') zeros += 1;
    return zeros + bytes.length;
  }

  /** A Solana address: base58 of exactly 32 bytes. Says nothing of what lives there. */
  function isAddress(value) {
    return (
      typeof value === 'string' &&
      new RegExp(`^${BASE58}{32,44}$`).test(value) &&
      decodedLength(value) === 32
    );
  }

  /**
   * Per site, the path of a token page. DexScreener names a pair (a pool
   * account), which the server resolves to its token; the other sites name
   * the token itself. The Solana Explorer's address page shows any account:
   * the server answers "nothing found" for one that is not a token.
   */
  const RULES = [
    {
      hosts: ['dexscreener.com', 'www.dexscreener.com'],
      path: new RegExp(`^/solana/${ADDRESS}${END}`),
      kind: 'pair',
    },
    {
      hosts: ['solscan.io', 'www.solscan.io'],
      path: new RegExp(`^/token/${ADDRESS}${END}`),
      kind: 'token',
    },
    {
      hosts: ['explorer.solana.com'],
      path: new RegExp(`^/address/${ADDRESS}${END}`),
      kind: 'token',
    },
    {
      hosts: ['pump.fun', 'www.pump.fun'],
      path: new RegExp(`^/coin/${ADDRESS}${END}`),
      kind: 'token',
    },
  ];

  function ruleFor(hostname) {
    const host = String(hostname || '').toLowerCase();
    return RULES.find((rule) => rule.hosts.includes(host)) || null;
  }

  /** The explorers can show devnet or testnet: only mainnet tokens are read. */
  function onMainnet(url) {
    const cluster = url.searchParams.get('cluster');
    return !cluster || cluster === 'mainnet' || cluster === 'mainnet-beta';
  }

  /** `{ kind: 'token' | 'pair', address }` for a token page URL, else `null`. */
  function fromUrl(href, base) {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const rule = ruleFor(url.hostname);
    if (!rule || !onMainnet(url)) return null;
    const match = rule.path.exec(url.pathname);
    if (!match || !isAddress(match[1])) return null;
    // A DexScreener path may be the token itself: the server decides.
    return { kind: rule.kind, address: match[1] };
  }

  /** A stable key for a detected token, for caches and for de-duplicating requests. Case kept. */
  function keyOf(query) {
    return `${query.kind}:${query.address}`;
  }

  /** The site's host as the per-site switch stores it (without `www.`). */
  function siteOf(hostname) {
    return String(hostname || '')
      .toLowerCase()
      .replace(/^www\./, '');
  }

  /** True for an element the overlay must leave alone: fields and editable text. */
  function isEditable(element) {
    for (let node = element; node; node = node.parentElement) {
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (node.isContentEditable) return true;
    }
    return false;
  }

  /** The token a link points to, when it is a link to a token page. */
  function fromLink(anchor, base) {
    if (!anchor || typeof anchor.getAttribute !== 'function') return null;
    const href = anchor.getAttribute('href');
    if (!href || isEditable(anchor)) return null;
    return fromUrl(href, base);
  }

  ns.detect = { fromUrl, fromLink, keyOf, siteOf, isEditable, ruleFor, isAddress };
})(globalThis);
