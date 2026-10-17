/*
 * The toolbar popup: paste an address to read its In short, and switch the
 * overlay off (or back on) for the site in the current tab.
 */
(function (root) {
  'use strict';
  const ns = root.SealExt;
  const api = root.browser && root.browser.runtime ? root.browser : root.chrome;
  const doc = root.document;
  const { card, detect } = ns;

  const form = doc.getElementById('lookup');
  const input = doc.getElementById('address');
  const result = doc.getElementById('result');
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(ns.CSS);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    // Without constructable sheets the popup keeps its own stylesheet only.
  }
  doc.getElementById('popup-mark').appendChild(card.mount(card.arch('mark'), doc));

  function show(state) {
    result.replaceChildren(
      card.mount(card.renderCard(state, { closable: false, titleId: 'popup-card-title' }), doc),
    );
  }

  let asked = '';
  async function read(query) {
    const key = detect.keyOf(query);
    asked = key;
    show({ status: 'loading' });
    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'seal:glance', query });
    } catch {
      reply = undefined;
    }
    if (asked !== key) return;
    reply = reply || { ok: false, status: 0, message: ns.client.MESSAGES.unreadable };
    show(
      reply.ok
        ? { status: 'ready', data: reply.data }
        : { status: 'error', message: reply.message, retry: false },
    );
  }

  function invalid(message) {
    input.setAttribute('aria-invalid', 'true');
    let note = doc.getElementById('address-error');
    if (!note) {
      note = doc.createElement('p');
      note.id = 'address-error';
      note.className = 'validation';
      note.setAttribute('role', 'alert');
      form.appendChild(note);
    }
    note.textContent = message;
    input.setAttribute('aria-describedby', 'address-error address-help');
    input.focus();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!ADDRESS.test(value)) {
      invalid('Enter an address starting with 0x, followed by 40 hexadecimal characters.');
      return;
    }
    input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', 'address-help');
    const note = doc.getElementById('address-error');
    if (note) note.remove();
    void read({ kind: 'token', address: value });
  });

  // ── the per-site switch ───────────────────────────────────────────────
  async function currentTab() {
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      return tab && tab.url ? new URL(tab.url) : null;
    } catch {
      return null;
    }
  }

  async function setupSite() {
    const url = await currentTab();
    const site = url ? detect.siteOf(url.hostname) : '';
    const known = ns.config.SITES.find((s) => s.host === site);
    if (!known) {
      doc.getElementById('site-none').hidden = false;
      return;
    }
    const toggle = doc.getElementById('site-enabled');
    doc.getElementById('site-name').textContent = known.label;
    doc.getElementById('site-toggle').hidden = false;
    const { disabledSites = [] } = await api.storage.sync.get('disabledSites');
    toggle.checked = !disabledSites.includes(site);
    toggle.addEventListener('change', async () => {
      const { disabledSites: current = [] } = await api.storage.sync.get('disabledSites');
      const next = new Set(current);
      if (toggle.checked) next.delete(site);
      else next.add(site);
      await api.storage.sync.set({ disabledSites: [...next] });
    });

    // On a token page, its In short is shown straight away.
    const query = detect.fromUrl(url.toString());
    if (query) {
      if (query.kind === 'token') input.value = query.address;
      void read(query);
    }
  }

  void setupSite();
})(globalThis);
