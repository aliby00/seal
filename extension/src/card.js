/*
 * The In-short card, described as a small tree of plain objects and then
 * built with DOM calls. No HTML string is ever parsed: every name, figure and
 * sentence from the server lands in a text node, so nothing in a token's name
 * can become markup on the page.
 */
(function (root) {
  'use strict';
  const ns = (root.SealExt = root.SealExt || {});

  /** The tone of a line, always said in words as well as colour (as on sealauth.dev). */
  const TONE = {
    attention: { label: 'Worth attention', icon: 'concern' },
    neutral: { label: 'Context', icon: 'observation' },
    reassuring: { label: 'Reassuring', icon: 'reassurance' },
  };

  const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'g']);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** `h('p', { class: 'x' }, 'text', h(...))`: a node of the tree. Falsy children are dropped. */
  function h(tag, attrs, ...children) {
    return {
      tag,
      attrs: attrs || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    };
  }

  function icon(kind) {
    const common = { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true' };
    if (kind === 'concern') {
      return h(
        'svg',
        { ...common, class: 'icon' },
        h('path', { d: 'M8 1.5 15 14H1z', fill: 'currentColor' }),
        h('path', {
          d: 'M8 6v3.6M8 11.4v.1',
          stroke: 'var(--ink)',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
        }),
      );
    }
    if (kind === 'reassurance') {
      return h(
        'svg',
        { ...common, class: 'icon' },
        h('circle', { cx: '8', cy: '8', r: '7', fill: 'currentColor' }),
        h('path', {
          d: 'm4.6 8.2 2.3 2.3 4.5-4.7',
          fill: 'none',
          stroke: 'var(--ink)',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      );
    }
    return h(
      'svg',
      { ...common, class: 'icon' },
      h('rect', {
        x: '1.5',
        y: '1.5',
        width: '13',
        height: '13',
        rx: '3',
        fill: 'currentColor',
        transform: 'rotate(45 8 8) scale(.82) translate(1.75 1.75)',
      }),
      h('circle', { cx: '8', cy: '8', r: '1.9', fill: 'var(--ink)' }),
    );
  }

  /** The SEAL arch, same geometry as the site's icon: a frame and its curtain of strips. */
  const STRIPS = [
    [22.56, 33.12, 52.88],
    [26.56, 28.16, 57.84],
    [30.56, 24.76, 61.24],
    [34.56, 22.34, 63.66],
    [38.56, 20.66, 65.34],
    [42.56, 19.59, 66.41],
    [46.56, 19.06, 66.94],
    [50.56, 19.06, 66.94],
    [54.56, 19.59, 66.41],
    [58.56, 20.66, 65.34],
    [62.56, 22.34, 63.66],
    [66.56, 24.76, 61.24],
    [70.56, 28.16, 57.84],
    [74.56, 33.12, 52.88],
  ];
  function arch(className) {
    return h(
      'svg',
      { viewBox: '0 0 100 100', class: className, 'aria-hidden': 'true' },
      STRIPS.map(([x, y, height]) =>
        h('rect', {
          x: String(x),
          y: String(y),
          width: '2.88',
          height: String(height),
          rx: '1.44',
          class: 'strip',
        }),
      ),
      h('path', {
        class: 'frame',
        d: 'M11 93 V46 A39 39 0 0 1 89 46 V93 H81 V46 A31 31 0 0 0 19 46 V93 Z',
      }),
    );
  }

  function tone(item) {
    const t = TONE[item.tone] || TONE.neutral;
    return h('span', { class: 'tone' }, icon(t.icon), t.label);
  }

  /** Only a web link is ever followed from the card. */
  function safeHref(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  function header(title, options) {
    return h(
      'header',
      { class: 'head' },
      arch('mark'),
      h(
        'div',
        { class: 'titles' },
        h('span', { class: 'kicker' }, 'SEAL · In short'),
        title ? h('span', { class: 'name', id: options.titleId }, title) : null,
      ),
      options.closable
        ? h(
            'button',
            { type: 'button', class: 'close', 'data-action': 'close', 'aria-label': 'Close' },
            '×',
          )
        : null,
    );
  }

  function titleOf(data) {
    const name = data.name || null;
    const symbol = data.symbol || null;
    if (name && symbol && name !== symbol) return `${name} · ${symbol}`;
    return name || symbol || shortAddress(data.token);
  }

  function shortAddress(address) {
    const a = String(address || '');
    return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
  }

  /**
   * The card for a state:
   *   { status: 'loading' } | { status: 'error', message } | { status: 'ready', data }
   * `compact` (the hover card) shows two lines under the lead instead of three.
   */
  function renderCard(state, options = {}) {
    const titleId = options.titleId || 'seal-card-title';
    const common = { closable: options.closable !== false, titleId };
    const label = { role: 'dialog', 'aria-labelledby': titleId, 'aria-modal': 'false' };

    if (!state || state.status === 'loading') {
      return h(
        'article',
        { class: 'card', 'data-state': 'loading', ...label, 'aria-busy': 'true' },
        header('Reading public data…', common),
        h('p', { class: 'status', role: 'status' }, 'SEAL is reading this token’s public data.'),
        h('div', { class: 'shimmer', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      );
    }
    if (state.status === 'error') {
      return h(
        'article',
        { class: 'card', 'data-state': 'error', ...label },
        header('Not available', common),
        h(
          'p',
          { class: 'status', role: 'alert' },
          state.message || 'SEAL could not read this token right now.',
        ),
        state.retry
          ? h('button', { type: 'button', class: 'retry', 'data-action': 'retry' }, 'Try again')
          : null,
      );
    }

    const data = state.data;
    const glance = data.glance || { headline: '', items: [], unseen: [] };
    const [lead, ...rest] = glance.items || [];
    const more = rest.slice(0, options.compact ? 2 : 3);
    const href = safeHref(data.url);

    return h(
      'article',
      {
        class: 'card',
        'data-state': 'ready',
        'data-compact': options.compact ? 'true' : 'false',
        ...label,
      },
      header(titleOf(data), common),
      lead
        ? h(
            'section',
            { class: 'lead', 'data-tone': lead.tone },
            tone(lead),
            h(
              'div',
              { class: 'lead-body' },
              h('strong', { class: 'figure' }, lead.figure),
              h('p', { class: 'headline' }, lead.title),
            ),
            options.compact ? null : h('p', { class: 'detail' }, lead.detail),
          )
        : h('p', { class: 'headline solo' }, glance.headline),
      more.length > 0
        ? h(
            'ul',
            { class: 'list' },
            more.map((item) =>
              h(
                'li',
                { 'data-tone': item.tone },
                tone(item),
                h('strong', { class: 'figure' }, item.figure),
                h('span', { class: 'text' }, item.title),
              ),
            ),
          )
        : null,
      glance.unseen && glance.unseen.length > 0
        ? h(
            'p',
            { class: 'unseen' },
            h('strong', {}, 'Not measured here:'),
            ` ${glance.unseen.join(', ')}. Missing data is not good news, nor bad news.`,
          )
        : null,
      href
        ? h(
            'a',
            { class: 'cta', href, target: '_blank', rel: 'noopener noreferrer' },
            'Full reading on SEAL ',
            h('span', { 'aria-hidden': 'true' }, '→'),
          )
        : null,
      h('p', { class: 'foot' }, 'Evidence and context. Never a score.'),
    );
  }

  /** Builds real DOM nodes from the tree, in `doc`. Attributes are set one by one, never parsed. */
  function mount(node, doc) {
    if (typeof node === 'string' || typeof node === 'number')
      return doc.createTextNode(String(node));
    const element = SVG_TAGS.has(node.tag)
      ? doc.createElementNS(SVG_NS, node.tag)
      : doc.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      // Event handlers and script URLs have no way in.
      if (/^on/i.test(name)) continue;
      if (name === 'href' && !safeHref(value)) continue;
      element.setAttribute(name, String(value));
    }
    for (const child of node.children) element.appendChild(mount(child, doc));
    return element;
  }

  /** The text a reader would hear, for tests and for checking the wording. */
  function textOf(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (node.attrs && node.attrs['aria-hidden'] === 'true') return '';
    return node.children.map(textOf).join(node.tag === 'li' ? ' ' : '');
  }

  /** Every node of the tree matching `test`, depth first. */
  function findAll(node, test, found = []) {
    if (typeof node !== 'object' || node === null) return found;
    if (test(node)) found.push(node);
    for (const child of node.children) findAll(child, test, found);
    return found;
  }

  ns.card = { h, renderCard, mount, textOf, findAll, arch, TONE, safeHref };
})(globalThis);
