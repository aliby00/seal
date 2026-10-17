/*
 * Finding Robinhood Chain tokens on a page: first in the page's own URL, then
 * in links that point to a token page. Only these shapes are recognised; a
 * bare 0x… string in text is never read, and a transaction hash (64 hex
 * characters) never passes for a token address (40).
 */
(function (root) {
  'use strict';
  const ns = (root.SealExt = root.SealExt || {});

  const HEX40 = '0x[0-9a-fA-F]{40}';
  const HEX64 = '0x[0-9a-fA-F]{64}';
  /** The address must end the path segment: no longer hex string hides behind it. */
  const END = '(?![0-9a-fA-F])(?:[/?#]|$)';

  /**
   * Per site, the path of a token page. DexScreener names a pair (a pool
   * address, or a v4 pool id of 64 hex characters), which the server
   * resolves to its token; the other sites name the token itself.
   */
  const RULES = [
    {
      hosts: ['dexscreener.com', 'www.dexscreener.com'],
      path: new RegExp(`^/robinhood/(${HEX64}|${HEX40})${END}`),
      kind: 'pair',
    },
    {
      hosts: ['robinhoodchain.blockscout.com'],
      path: new RegExp(`^/token/(${HEX40})${END}`),
      kind: 'token',
    },
    {
      hosts: ['ponsfamily.com', 'www.ponsfamily.com'],
      path: new RegExp(`^/launchpad/(${HEX40})${END}`),
      kind: 'token',
    },
  ];

  function ruleFor(hostname) {
    const host = String(hostname || '').toLowerCase();
    return RULES.find((rule) => rule.hosts.includes(host)) || null;
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
    if (!rule) return null;
    const match = rule.path.exec(url.pathname);
    if (!match) return null;
    const address = match[1].toLowerCase();
    // A 40-character DexScreener path may be the token itself: the server decides.
    return { kind: rule.kind, address };
  }

  /** A stable key for a detected token, for caches and for de-duplicating requests. */
  function keyOf(query) {
    return `${query.kind}:${query.address.toLowerCase()}`;
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

  ns.detect = { fromUrl, fromLink, keyOf, siteOf, isEditable, ruleFor };
})(globalThis);
