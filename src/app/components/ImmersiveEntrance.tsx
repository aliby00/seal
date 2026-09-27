'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Scroll stays native; only decorative transforms follow its position. */
export function ImmersiveEntrance({
  children,
  environment,
}: {
  children: ReactNode;
  environment: string;
}) {
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
      const scale = Math.pow(60, p);
      const width = element.clientWidth;
      const height = section.firstElementChild?.clientHeight ?? window.innerHeight;
      // Align the opening to the doorway in the 1536 × 1024 landscape,
      // including the different object-cover crop on a portrait viewport.
      const cover = Math.max(width / 1536, height / 1024);
      const center = height / 2 + 16 * cover;
      element.style.setProperty('--camera-scale', String(scale));
      element.style.setProperty('--gate-center', `${center}px`);
      element.style.setProperty('--scene-opacity', String(1 - clamp((p - 0.94) / 0.06)));
      element.style.setProperty('--copy-opacity', String(1 - clamp(p / 0.22)));
      element.style.setProperty('--copy-shift', `${-p * 100}px`);
      element.style.setProperty(
        '--portal-x',
        `${Math.max(0, 50 - ((16 * cover * scale) / width) * 100)}%`,
      );
      element.style.setProperty(
        '--portal-top',
        `${Math.max(0, ((center - 52 * cover * scale) / height) * 100)}%`,
      );
      element.style.setProperty(
        '--portal-bottom',
        `${Math.max(0, ((height - center - 52 * cover * scale) / height) * 100)}%`,
      );
      element.style.setProperty('--portal-opacity', String(clamp((p - 0.16) / 0.12)));
      element.style.setProperty(
        '--app-opacity',
        String(reduced.matches ? 1 : clamp((p - 0.93) / 0.065)),
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
    <div ref={root} className="immersive-root">
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
            <div className="portal-world" aria-hidden="true" />
            <div ref={copy} className="entrance-copy">
              <p className="scene-eyebrow">Au-delà des apparences</p>
              <h1 id="entrance-title">
                Chaque token cache
                <br />
                <em>une autre histoire.</em>
              </h1>
              <p className="entrance-description">
                Traversez les données.
                <br />
                Découvrez ce qu’elles racontent ensemble.
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
          className="analysis-world"
          aria-labelledby="workspace-title"
          tabIndex={-1}
        >
          <div className="world-content">
            <div className="workspace-edition">
              <span>02 — LA LECTURE</span>
              <span>
                {environment !== 'production'
                  ? `Environnement : ${environment}`
                  : 'Pons / Robinhood Chain'}
              </span>
            </div>
            <div className="workspace-intro">
              <p className="scene-eyebrow">L’intelligence, entre les lignes.</p>
              <h2 id="workspace-title">
                Les mêmes données.
                <br />
                <span>Une autre lecture.</span>
              </h2>
              <p>
                Le créateur. Les détenteurs. Le marché.
                <br />
                SEAL relie les signaux et explique leurs contradictions.
                <br />
                Une analyse en prose. Jamais une note.
              </p>
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
