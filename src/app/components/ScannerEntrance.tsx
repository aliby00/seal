'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Arch, PERMISSIONS, Wordmark, Xray } from './brand';

/**
 * Masques de permissions réels, dans l'ordre où ces marchés sont apparus sur
 * Robinhood Chain (blocs 86 100 036 – 86 131 118). 0 : pas de rulebook.
 */
const BELT = [0x20cc, 0, 0x2544, 0, 0xa80, 0x2aec, 0, 0x840, 0x1000, 0, 0xcc, 0x2acc];

function Track({ opaque = false }: { opaque?: boolean }) {
  return (
    <div className="belt-track" style={{ '--bags': BELT.length } as CSSProperties}>
      {[...BELT, ...BELT].map((mask, i) => (
        <div className="belt-slot" key={i}>
          <Xray mask={mask} opaque={opaque} />
        </div>
      ))}
    </div>
  );
}

/** Le scanner : les marchés passent sur le tapis, et sous l'arche on les voit aux rayons X. */
function Scanner() {
  return (
    <figure className="scanner" aria-hidden="true">
      <div className="scanner-stage">
        <div className="belt-lane">
          <Track opaque />
        </div>
        <Arch className="scanner-arch" />
        <div className="scanner-window">
          <div className="scanner-window-inner">
            <Track />
          </div>
          <div className="beam" />
        </div>
        <div className="belt" />
      </div>
    </figure>
  );
}

/** Le défilement reste natif ; les liens internes déplacent aussi le focus. */
export function ScannerEntrance({
  children,
  environment,
}: {
  children: ReactNode;
  environment: string;
}) {
  return (
    <div
      className="site"
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
        if (!anchor) return;
        const target = document.getElementById(anchor.hash.slice(1));
        if (!target) return;
        event.preventDefault();
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        target.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
          block: 'start',
        });
        window.history.replaceState(null, '', anchor.hash);
      }}
    >
      <a href="#analysis" className="skip-link">
        Skip to analysis
      </a>
      <header className="topbar">
        <a className="brand" href="#entrance" aria-label="SEAL">
          <Arch className="brand-mark" />
          <Wordmark className="brand-word" />
        </a>
        <span className="status">
          <span className="status-dot" aria-hidden="true" /> screening · Robinhood Chain
        </span>
        <nav aria-label="Sections">
          <a href="#method">Method</a>
          <a href="#limits">Limits</a>
          <a href="#analysis" className="nav-cta">
            Analyze
          </a>
        </nav>
      </header>
      <main>
        <section id="entrance" className="hero" aria-labelledby="entrance-title">
          <div className="hero-copy">
            <p className="eyebrow">X-ray for Robinhood Chain markets</p>
            <h1 id="entrance-title">
              See what a market <em>carries.</em>
            </h1>
            <p className="hero-description">
              A checkpoint doesn’t judge the traveller. It shows what’s in the bag. Paste a token:
              SEAL reads its creator, its holders and its market, and writes down what the public
              evidence shows.
            </p>
            <div className="hero-actions">
              <a href="#analysis" className="cta">
                Enter SEAL <span aria-hidden="true">↓</span>
              </a>
              <span className="hero-principle">Evidence and context. Never a score.</span>
            </div>
          </div>
          <Scanner />
        </section>
        <section className="curtain-key" aria-labelledby="curtain-title">
          <div className="curtain-key-head">
            <h2 id="curtain-title" className="eyebrow">
              The curtain · 14 permissions
            </h2>
            <p>
              Every Uniswap v4 market can carry a rulebook. Its permissions are written into its
              address: one strip each, long when it’s on.
            </p>
          </div>
          <ol className="curtain-list">
            {PERMISSIONS.map((name, i) => (
              <li key={name}>
                <span className="bit">{String(13 - i).padStart(2, '0')}</span>
                {name}
              </li>
            ))}
          </ol>
        </section>
        <section
          id="analysis"
          className="analysis-world"
          aria-labelledby="workspace-title"
          tabIndex={-1}
        >
          <div className="workspace-edition">
            <span>
              SEAL <span aria-hidden="true">/</span> Checkpoint
            </span>
            <span>
              {environment !== 'production'
                ? `Environment: ${environment}`
                : 'Pons / Robinhood Chain'}
            </span>
          </div>
          {children}
        </section>
      </main>
      <footer className="site-footer">
        <div className="footer-lockup" aria-hidden="true">
          <Arch className="brand-mark" />
          <Wordmark className="brand-word" />
        </div>
        <p>Shows what a market carries. Never says if it’s good.</p>
        <a href="#analysis">Open analysis ↑</a>
      </footer>
    </div>
  );
}
