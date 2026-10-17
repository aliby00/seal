/*
 * The overlay on a supported site. On a token page, a small "SEAL" pill sits
 * bottom-right and opens the In-short card; over a link to a token page, a
 * compact card appears after a short pause. Everything lives in one shadow
 * root on top of the page, which takes no pointer events except on the pill
 * and the cards: the page underneath keeps working as before.
 */
(function (root) {
  'use strict';
  const ns = root.SealExt;
  const api = root.browser && root.browser.runtime ? root.browser : root.chrome;
  if (!ns || !api || root.__sealOverlay) return;
  root.__sealOverlay = true;

  const { detect, card, config } = ns;
  const doc = root.document;
  const site = detect.siteOf(root.location.hostname);

  let host = null;
  let shadow = null;
  let layer = null;
  let pill = null;
  let panel = null;
  let hoverCard = null;
  let pageQuery = null;
  let pageState = null;
  let open = false;
  let enabled = false;
  let hoverTimer = 0;
  let hideTimer = 0;
  let hoverLink = null;
  let hoverKey = '';
  let lastHref = '';

  // ── data ──────────────────────────────────────────────────────────────
  const memo = new Map();
  /** At most one request in flight per token in this tab; the worker keeps the shared cache. */
  function glance(query) {
    const key = detect.keyOf(query);
    const known = memo.get(key);
    if (known && Date.now() - known.at < config.CACHE_TTL_MS) return known.ask;
    const ask = Promise.resolve()
      .then(() => api.runtime.sendMessage({ type: 'seal:glance', query }))
      .catch(() => undefined)
      .then((reply) => reply || { ok: false, status: 0, message: ns.client.MESSAGES.unreadable })
      .then((reply) => {
        // Failures are asked again next time; answers are kept as long as the worker keeps them.
        if (!reply.ok) memo.delete(key);
        return reply;
      });
    memo.set(key, { at: Date.now(), ask });
    return ask;
  }

  function stateOf(reply) {
    return reply.ok
      ? { status: 'ready', data: reply.data }
      : {
          status: 'error',
          message: reply.message,
          retry: reply.status !== 400 && reply.status !== 404,
        };
  }

  // ── shadow root ───────────────────────────────────────────────────────
  function ensureLayer() {
    if (layer) return;
    host = doc.createElement('seal-overlay');
    host.setAttribute('data-seal', 'overlay');
    // The host itself never takes space nor events.
    host.style.cssText =
      'all:initial;position:fixed;inset:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    let styled = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(ns.CSS);
      shadow.adoptedStyleSheets = [sheet];
      styled = true;
    } catch {
      // Older engines: a plain style element in the shadow root.
    }
    if (!styled) {
      const style = doc.createElement('style');
      style.textContent = ns.CSS;
      shadow.appendChild(style);
    }
    layer = doc.createElement('div');
    layer.className = 'layer';
    shadow.appendChild(layer);
    shadow.addEventListener('click', onShadowClick);
    (doc.body || doc.documentElement).appendChild(host);
  }

  function teardown() {
    closeHover(true);
    if (host) host.remove();
    host = shadow = layer = pill = panel = hoverCard = null;
    open = false;
  }

  // ── the pill and its card ─────────────────────────────────────────────
  function renderPill() {
    ensureLayer();
    if (!pill) {
      pill = doc.createElement('button');
      pill.type = 'button';
      pill.className = 'pill';
      pill.setAttribute('aria-controls', 'seal-panel');
      pill.setAttribute('data-action', 'toggle');
      layer.appendChild(pill);
    }
    pill.replaceChildren(
      card.mount(card.arch('mark'), doc),
      card.mount(
        card.h('span', { class: 'pill-label' }, 'SEAL', card.h('small', {}, 'In short')),
        doc,
      ),
    );
    const tone =
      pageState && pageState.status === 'ready' && pageState.data.glance.items[0]
        ? pageState.data.glance.items[0].tone
        : null;
    if (tone) {
      const dot = doc.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('data-tone', tone);
      dot.setAttribute('aria-hidden', 'true');
      pill.appendChild(dot);
    }
    pill.setAttribute('aria-expanded', open ? 'true' : 'false');
    pill.setAttribute(
      'aria-label',
      open ? 'Close the SEAL In short card' : 'Open the SEAL In short card for this token',
    );
  }

  function renderPanel() {
    if (panel) panel.remove();
    panel = null;
    if (!open || !layer) return;
    panel = card.mount(card.renderCard(pageState, { titleId: 'seal-panel-title' }), doc);
    panel.id = 'seal-panel';
    panel.classList.add('floating', 'anchored');
    layer.appendChild(panel);
  }

  function loadPage() {
    if (!pageQuery) return;
    const query = pageQuery;
    pageState = { status: 'loading' };
    renderPill();
    renderPanel();
    glance(query).then((reply) => {
      if (pageQuery !== query) return;
      pageState = stateOf(reply);
      renderPill();
      renderPanel();
    });
  }

  function setOpen(next, focusTarget) {
    open = next;
    renderPill();
    renderPanel();
    if (open && panel) {
      const first = panel.querySelector('.close');
      if (first && focusTarget !== 'none') first.focus({ preventScroll: true });
    } else if (!open && focusTarget === 'pill' && pill) {
      pill.focus({ preventScroll: true });
    }
  }

  function onShadowClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'toggle') setOpen(!open, 'none');
    else if (action === 'close') {
      if (hoverCard && hoverCard.contains(target)) closeHover(true);
      else setOpen(false, 'pill');
    } else if (action === 'retry') {
      if (hoverCard && hoverCard.contains(target) && hoverLink) {
        const query = detect.fromLink(hoverLink, root.location.href);
        if (query) showHover(hoverLink, query);
      } else loadPage();
    }
  }

  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (hoverCard) {
      closeHover(true);
      if (hoverLink && typeof hoverLink.focus === 'function')
        hoverLink.focus({ preventScroll: true });
    } else if (open) setOpen(false, 'pill');
  }

  // ── hover cards ───────────────────────────────────────────────────────
  function linkOf(target) {
    if (!(target instanceof Element)) return null;
    const anchor = target.closest('a[href]');
    if (!anchor || (host && host.contains(anchor))) return null;
    return anchor;
  }

  function place(element, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(320, root.innerWidth - 32);
    const left = Math.max(16, Math.min(rect.left, root.innerWidth - width - 16));
    element.style.left = `${left}px`;
    // Below the link when there is room, above otherwise.
    const below = root.innerHeight - rect.bottom;
    if (below >= 260 || below >= rect.top) {
      element.style.top = `${Math.round(rect.bottom + 8)}px`;
      element.style.maxHeight = `${Math.max(160, below - 24)}px`;
    } else {
      element.style.bottom = `${Math.round(root.innerHeight - rect.top + 8)}px`;
      element.style.maxHeight = `${Math.max(160, rect.top - 24)}px`;
    }
  }

  function drawHover(anchor, state) {
    ensureLayer();
    if (hoverCard) hoverCard.remove();
    hoverCard = card.mount(
      card.renderCard(state, { compact: true, titleId: 'seal-hover-title' }),
      doc,
    );
    hoverCard.classList.add('floating');
    hoverCard.setAttribute('data-seal', 'hover');
    place(hoverCard, anchor);
    hoverCard.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    hoverCard.addEventListener('mouseleave', scheduleHide);
    layer.appendChild(hoverCard);
  }

  function showHover(anchor, query) {
    const key = detect.keyOf(query);
    hoverLink = anchor;
    hoverKey = key;
    drawHover(anchor, { status: 'loading' });
    glance(query).then((reply) => {
      if (hoverKey !== key || !hoverCard) return;
      drawHover(anchor, stateOf(reply));
    });
  }

  function closeHover(now) {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    const close = () => {
      if (hoverCard) hoverCard.remove();
      hoverCard = null;
      hoverKey = '';
    };
    if (now) close();
    else hideTimer = setTimeout(close, config.HOVER_GRACE_MS);
  }

  function scheduleHide() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => closeHover(true), config.HOVER_GRACE_MS);
  }

  function onPointerOver(event) {
    if (!enabled) return;
    const anchor = linkOf(event.target);
    if (!anchor) return;
    const query = detect.fromLink(anchor, root.location.href);
    if (!query) return;
    // The page's own token already has its pill.
    if (pageQuery && detect.keyOf(query) === detect.keyOf(pageQuery)) return;
    clearTimeout(hideTimer);
    if (hoverCard && hoverKey === detect.keyOf(query)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showHover(anchor, query), config.HOVER_DELAY_MS);
  }

  function onPointerOut(event) {
    const anchor = linkOf(event.target);
    if (!anchor) return;
    const into = event.relatedTarget;
    if (into instanceof Node && anchor.contains(into)) return;
    clearTimeout(hoverTimer);
    if (hoverCard) scheduleHide();
  }

  function onDocumentKeydown(event) {
    if (event.key === 'Escape' && (hoverCard || open)) onKeydown(event);
  }

  // ── page changes (these sites navigate without reloading) ─────────────
  function refreshPage() {
    if (root.location.href === lastHref) return;
    lastHref = root.location.href;
    const query = enabled ? detect.fromUrl(root.location.href) : null;
    const same = query && pageQuery && detect.keyOf(query) === detect.keyOf(pageQuery);
    if (same) return;
    pageQuery = query;
    pageState = null;
    open = false;
    closeHover(true);
    if (!pageQuery) {
      if (pill) pill.remove();
      if (panel) panel.remove();
      pill = panel = null;
      return;
    }
    loadPage();
  }

  function apply(disabledSites) {
    const next = !(Array.isArray(disabledSites) && disabledSites.includes(site));
    if (next === enabled) return;
    enabled = next;
    lastHref = '';
    if (!enabled) {
      pageQuery = null;
      teardown();
    } else refreshPage();
  }

  doc.addEventListener('mouseover', onPointerOver, { passive: true, capture: true });
  doc.addEventListener('mouseout', onPointerOut, { passive: true, capture: true });
  doc.addEventListener('focusin', onPointerOver, { passive: true, capture: true });
  doc.addEventListener('focusout', onPointerOut, { passive: true, capture: true });
  doc.addEventListener('keydown', onDocumentKeydown, { capture: true });
  root.addEventListener('popstate', refreshPage);
  setInterval(refreshPage, 800);

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.disabledSites) apply(changes.disabledSites.newValue);
  });
  api.storage.sync
    .get('disabledSites')
    .then((found) => apply(found && found.disabledSites))
    .catch(() => apply([]));
})(globalThis);
