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
      const chapters = Array.from(element.querySelectorAll<HTMLElement>('[data-weather]'));
      let night = 0,
        day = 0,
        rain = 0;
      chapters.forEach((chapter, index) => {
        const rect = chapter.getBoundingClientRect();
        const progress = clamp((window.innerHeight * 0.8 - rect.top) / (window.innerHeight * 0.65));
        if (index === 0) night = progress;
        if (index === 1) day = progress;
        if (index === 2) rain = progress;
        const travel = reduced.matches
          ? 0.35
          : clamp((window.innerHeight - rect.top) / (window.innerHeight + rect.height));
        chapter.style.setProperty('--tech-turn', `${travel * 180}deg`);
        chapter.style.setProperty('--tech-shift', `${travel * 45}px`);
        for (let ring = 0; ring < 3; ring++) {
          chapter.style.setProperty(
            `--orbit-${ring}`,
            String(Math.max(0.08, Math.abs(Math.cos(travel * Math.PI + (ring * Math.PI) / 3)))),
          );
        }
      });
      element.style.setProperty('--weather-night', String(night * (1 - day)));
      element.style.setProperty('--weather-day', String(day * (1 - rain)));
      element.style.setProperty('--weather-rain', String(rain));
      element.style.setProperty(
        '--weather-drift',
        `${reduced.matches ? 0 : window.scrollY * 0.035}px`,
      );
      element.style.setProperty(
        '--rain-travel',
        `${reduced.matches ? 0 : window.scrollY * 0.45}px`,
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
    resize.observe(element);
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
        Skip to analysis
      </a>
      <div className="world-background" aria-hidden="true">
        <div className="weather-night" />
        <div className="weather-day" />
        <div className="weather-rain" />
        <div className="weather-clouds" />
        <div className="rain-streaks" />
      </div>
      <nav className="corner-navigation" aria-label="Quick navigation">
        <a href="#entrance" aria-label="Back to top">
          ↑
        </a>
        <a href="#analysis">Analyze ↗</a>
      </nav>
      <header className="world-nav">
        <a href="#entrance" className="world-brand" aria-label="SEAL, home">
          <span className="brand-glyph" aria-hidden="true">
            ✳
          </span>{' '}
          SEAL
        </a>
        <nav aria-label="Main navigation">
          <a href="#method">How it works</a>
          <a href="https://github.com/aliby00/seal">About SEAL ↗</a>
        </nav>
        <a className="nav-enter" href="#analysis">
          Open SEAL <span aria-hidden="true">↗</span>
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
              <p className="scene-eyebrow">Read the signals. Understand the context.</p>
              <h1 id="entrance-title">
                Every token has
                <br />
                <em>another story.</em>
              </h1>
              <p className="entrance-description">
                One pons token address. Three public sources.
                <br />
                An explanation of what they reveal together.
              </p>
              <a href="#analysis" className="entrance-cta">
                Enter SEAL <span aria-hidden="true">↗</span>
              </a>
            </div>
            <div className="journey-caption">
              <span>01 — THE CONTEXT</span>
              <a href="#analysis">
                Scroll to explore <span aria-hidden="true">↓</span>
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
                SEAL <span aria-hidden="true">/</span> Research workspace
              </span>
              <span>
                {environment !== 'production'
                  ? `Environment: ${environment}`
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
        <p>The facts. The context. Your perspective.</p>
        <a href="#analysis">Open analysis ↗</a>
      </footer>
    </div>
  );
}
