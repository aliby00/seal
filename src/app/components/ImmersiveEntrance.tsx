'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Scroll stays native; only decorative transforms follow its position. */
export function ImmersiveEntrance({
  children,
  environment,
}: {
  children: ReactNode;
  environment: string;
}) {
  const [engaged, setEngaged] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const journey = useRef<HTMLElement>(null);
  const copy = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;
    const section = journey.current;
    if (!element || !section) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    function paint() {
      frame = 0;
      if (!element || !section) return;
      const distance = section.offsetHeight - window.innerHeight;
      const p = reduced.matches
        ? 0
        : clamp(-section.getBoundingClientRect().top / Math.max(1, distance));
      element.style.setProperty('--camera-scale', String(1 + p * 1.1));
      element.style.setProperty('--scene-opacity', String(1 - clamp((p - 0.55) / 0.45)));
      element.style.setProperty('--copy-opacity', String(1 - clamp(p / 0.3)));
      element.style.setProperty('--copy-shift', `${-p * 70}px`);
      element.style.setProperty('--mist-opacity', String(Math.sin(p * Math.PI) * 0.65));
      element.style.setProperty('--mist-shift', `${(1 - p) * 28}%`);
      element.style.setProperty(
        '--app-opacity',
        String(reduced.matches ? 1 : clamp((p - 0.7) / 0.3)),
      );
      element.dataset.entered = String(p > 0.92);
      element.dataset.travelling = String(window.scrollY > 50);
      if (copy.current) copy.current.inert = !reduced.matches && p > 0.25;
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(paint);
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(section);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    reduced.addEventListener('change', schedule);
    paint();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      reduced.removeEventListener('change', schedule);
    };
  }, []);

  return (
    <div
      ref={root}
      className="immersive-root"
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
        Aller à l’analyse
      </a>
      <div className="world-background" aria-hidden="true" />
      <header className="world-nav">
        <a href="#entrance" className="world-brand" aria-label="SEAL, accueil">
          <span className="brand-glyph" aria-hidden="true">
            ✳
          </span>{' '}
          SEAL
        </a>
        <nav aria-label="Navigation principale">
          <a href="#method">La méthode</a>
          <a href="https://github.com/aliby00/seal">Le projet ↗</a>
        </nav>
        <a className="nav-enter" href="#analysis">
          Ouvrir SEAL <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main>
        <section
          ref={journey}
          id="entrance"
          className="scroll-journey"
          aria-labelledby="entrance-title"
        >
          <div className="journey-stage">
            <div className="mountain-scene" aria-hidden="true" />
            <div className="scene-shade" aria-hidden="true" />
            <div className="valley-mist" aria-hidden="true" />
            <div ref={copy} className="entrance-copy">
              <p className="scene-eyebrow">Lire les signaux. Comprendre les nuances.</p>
              <h1 id="entrance-title">
                Chaque token cache
                <br />
                <em>une autre histoire.</em>
              </h1>
              <p className="entrance-description">
                Une adresse de token pons. Trois sources publiques.
                <br />
                Une explication de ce qu’elles racontent ensemble.
              </p>
              <a href="#analysis" className="entrance-cta">
                Entrer dans SEAL <span aria-hidden="true">↗</span>
              </a>
            </div>
            <div className="journey-caption">
              <span>01 — LE CONTEXTE</span>
              <a href="#analysis">
                Défiler pour explorer <span aria-hidden="true">↓</span>
              </a>
              <span>PONS / ROBINHOOD CHAIN</span>
            </div>
          </div>
        </section>
        <section
          id="analysis"
          onFocusCapture={() => setEngaged(true)}
          style={engaged ? { opacity: 1 } : undefined}
          className="analysis-world"
          aria-labelledby="workspace-title"
          tabIndex={-1}
        >
          <div className="world-content">
            <div className="workspace-edition">
              <span className="workspace-location">
                SEAL <span aria-hidden="true">/</span> Espace de recherche
              </span>
              <span>
                {environment !== 'production'
                  ? `Environnement : ${environment}`
                  : 'Pons / Robinhood Chain'}
              </span>
            </div>
            {children}
          </div>
        </section>
      </main>
      <footer className="world-footer">
        <a className="world-brand" href="#entrance">
          SEAL
        </a>
        <p>Les faits. Le contexte. À vous de lire.</p>
        <a href="#analysis">Ouvrir l’analyse ↗</a>
      </footer>
    </div>
  );
}
