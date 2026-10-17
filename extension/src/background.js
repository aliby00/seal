/*
 * The extension's only network access. Content scripts and the popup ask it
 * for a glance by message; it asks sealauth.dev with the token address and
 * nothing else — no page URL, no cookie, no identifier.
 */
if (typeof importScripts === 'function') {
  // Chrome's service worker. Firefox lists the same files in `background.scripts`.
  importScripts('config.js', 'detect.js', 'client.js');
}

(function (root) {
  'use strict';
  const ns = root.SealExt;
  const api = root.browser && root.browser.runtime ? root.browser : root.chrome;

  /** The API base: sealauth.dev, or a local server set for development. */
  async function apiBase() {
    try {
      const { apiBase: custom } = await api.storage.local.get('apiBase');
      if (typeof custom === 'string' && ns.config.LOCAL_API.test(custom)) return custom;
    } catch {
      // No local setting readable: the public site.
    }
    return ns.config.API_BASE;
  }

  const store =
    api.storage && api.storage.session
      ? ns.client.sessionStore(api.storage.session)
      : ns.client.memoryStore();

  const client = ns.client.createClient({
    fetch: (url, init) => fetch(url, init),
    apiBase,
    store,
  });

  const ADDRESS = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'seal:glance') return false;
    // Only this extension's own pages and content scripts are answered.
    if (sender && sender.id && sender.id !== api.runtime.id) return false;
    const query = message.query || {};
    const kind = query.kind === 'pair' ? 'pair' : 'token';
    const address = String(query.address || '');
    if (!ADDRESS.test(address) || (kind === 'token' && address.length !== 42)) {
      sendResponse({ ok: false, status: 400, message: ns.client.MESSAGES.invalid });
      return false;
    }
    client
      .get({ kind, address })
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, status: 0, message: ns.client.MESSAGES.unreadable }));
    return true;
  });
})(globalThis);
