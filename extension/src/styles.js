/*
 * The card's look, in the site's visual language: dark glass, one orange
 * light, amber for what deserves attention, mint for what reassures, sky for
 * context. Applied inside a shadow root, so the host page's CSS cannot reach it.
 */
(function (root) {
  'use strict';
  const ns = (root.SealExt = root.SealExt || {});

  ns.CSS = `
:host, .scope {
  --ink: #05080b;
  --glass: rgb(10 14 19 / 0.94);
  --line: rgb(255 255 255 / 0.1);
  --line-strong: rgb(255 255 255 / 0.2);
  --text: #eef2f4;
  --dim: #9aa6ae;
  --faint: #7d8992;
  --accent: #ff8a2a;
  --accent-hot: #ffb15e;
  --amber: #ffc857;
  --mint: #5fe3c4;
  --sky: #7fb6ff;
  --display: 'Space Grotesk', 'Segoe UI', system-ui, -apple-system, Arial, sans-serif;
  --body: Inter, 'Segoe UI', system-ui, -apple-system, Arial, sans-serif;
  --data: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  all: initial;
}
* { box-sizing: border-box; }
[data-tone='attention'] { --tone: var(--amber); }
[data-tone='neutral'] { --tone: var(--sky); }
[data-tone='reassuring'] { --tone: var(--mint); }

.layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483646;
  font-family: var(--body);
  color: var(--text);
}
.layer > * { pointer-events: auto; }

.pill {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px 0 10px;
  border: 1px solid rgb(255 138 42 / 0.45);
  border-radius: 999px;
  background: var(--glass);
  color: var(--text);
  font: 600 13px/1 var(--display);
  letter-spacing: 0.08em;
  cursor: pointer;
  box-shadow: 0 10px 34px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(0 0 0 / 0.4);
  backdrop-filter: blur(14px) saturate(1.3);
  transition: border-color 160ms ease, transform 160ms ease;
}
.pill:hover { border-color: var(--accent); transform: translateY(-1px); }
.pill:focus-visible, .card :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.pill .mark { width: 22px; height: 22px; }
.pill .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--tone, var(--faint));
  box-shadow: 0 0 10px var(--tone, transparent);
}
.pill-label { text-transform: uppercase; }
.pill-label small {
  margin-left: 6px;
  font: 500 11px/1 var(--body);
  letter-spacing: 0;
  text-transform: none;
  color: var(--dim);
}

.card {
  display: grid;
  gap: 12px;
  width: min(360px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 96px));
  overflow: auto;
  padding: 16px;
  border: 1px solid var(--line-strong);
  border-radius: 18px;
  background:
    radial-gradient(120% 90% at 0% 0%, rgb(255 138 42 / 0.1), transparent 55%),
    var(--glass);
  color: var(--text);
  font: 400 14px/1.45 var(--body);
  text-align: left;
  box-shadow: 0 18px 60px rgb(0 0 0 / 0.55);
  backdrop-filter: blur(18px) saturate(1.3);
  animation: rise 160ms ease-out;
}
.card[data-compact='true'] { width: min(320px, calc(100vw - 32px)); }
.floating { position: fixed; }
.anchored { right: 16px; bottom: 66px; }

.head { display: flex; align-items: center; gap: 10px; }
.mark { width: 26px; height: 26px; flex: none; }
.mark .strip { fill: var(--accent); }
.mark .frame { fill: var(--text); }
.titles { display: grid; gap: 3px; min-width: 0; flex: 1; }
.kicker {
  font: 500 10.5px/1 var(--data);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent-hot);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 15px/1.2 var(--display);
  letter-spacing: -0.01em;
}
.close, .retry {
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--dim);
  font: 500 16px/1 var(--body);
  cursor: pointer;
}
.close { width: 30px; height: 30px; flex: none; }
.close:hover, .retry:hover { color: var(--text); border-color: var(--accent); }
.retry { justify-self: start; padding: 8px 14px; font-size: 13px; }

.lead {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--tone) 32%, var(--line));
  border-radius: 14px;
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--tone) 14%, transparent), transparent 60%),
    rgb(0 0 0 / 0.22);
}
.lead-body { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.figure {
  font: 600 34px/1 var(--display);
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--tone);
  text-shadow: 0 0 24px color-mix(in srgb, var(--tone) 35%, transparent);
}
.headline {
  flex: 1 1 12rem;
  margin: 0;
  font: 500 15.5px/1.35 var(--display);
  letter-spacing: -0.01em;
}
.headline.solo { color: var(--dim); }
.detail { margin: 0; font-size: 12px; color: var(--dim); }
.tone {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-self: start;
  width: max-content;
  padding: 3px 10px 3px 6px;
  border-radius: 999px;
  font: 600 11px/1.2 var(--body);
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 14%, transparent);
}
.icon { width: 14px; height: 14px; flex: none; }

.list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.list li {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 6px 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--tone) 24%, var(--line));
  border-radius: 12px;
  background: rgb(0 0 0 / 0.18);
}
.list .tone { grid-column: 1 / -1; }
.list .figure { font-size: 20px; }
.list .text { font-size: 13px; line-height: 1.4; }

.unseen { margin: 0; font-size: 12.5px; color: var(--dim); }
.unseen strong { color: var(--text); font-weight: 600; }
.status { margin: 0; color: var(--dim); }
.cta {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border-radius: 999px;
  background: var(--accent);
  color: #160b02;
  font: 600 13px/1 var(--display);
  text-decoration: none;
}
.cta:hover { background: var(--accent-hot); }
.foot {
  margin: 0;
  font: 500 10.5px/1.3 var(--data);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
}
.shimmer { display: grid; gap: 8px; }
.shimmer span {
  display: block;
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, rgb(255 255 255 / 0.05), rgb(255 255 255 / 0.12), rgb(255 255 255 / 0.05));
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}
.shimmer span:nth-child(2) { width: 80%; }
.shimmer span:nth-child(3) { width: 55%; }

@keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes shimmer { to { background-position: -200% 0; } }

@media (prefers-reduced-motion: reduce) {
  .card, .shimmer span { animation: none; }
  .pill, .pill:hover { transition: none; transform: none; }
}
`;
})(globalThis);
