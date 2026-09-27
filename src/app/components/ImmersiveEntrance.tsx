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
      // Keep advancing until the form enters the viewport, including the handoff.
      // One fixed photograph remains in place throughout the entire page.
      const cameraDistance = Math.max(distance + window.innerHeight * 0.5, 1);
      const camera = reduced.matches
        ? 0
        : clamp(-section.getBoundingClientRect().top / cameraDistance);
      const easedCamera = camera * camera * (3 - 2 * camera);
      element.style.setProperty('--camera-scale', String(1 + easedCamera * 4.5));
      element.style.setProperty('--reading-shade', String(reduced.matches ? 0.65 : clamp(p / 0.7)));
      element.style.setProperty('--copy-opacity', String(1 - clamp(p / 0.3)));
      element.style.setProperty('--copy-shift', `${-clamp(p / 0.3) * 45}px`);
      // Enter an opaque cloud bank, then emerge as the workspace arrives.
      const enterCloud = clamp((p - 0.15) / 0.3);
      const leaveCloud = clamp((p - 0.62) / 0.25);
      const smooth = (value: number) => value * value * (3 - 2 * value);
      element.style.setProperty(
        '--mist-opacity',
        String(smooth(enterCloud) * (1 - smooth(leaveCloud))),
      );
      element.style.setProperty('--mist-scale', String(0.8 + easedCamera * 4.2));
      element.style.setProperty('--mist-spread', `${easedCamera * 22}%`);
      element.style.setProperty('--mist-shift', `${(0.5 - camera) * 32}%`);
      element.dataset.entered = String(p > 0.92);
      element.dataset.travelling = String(window.scrollY > 50);
      if (copy.current) copy.current.inert = !reduced.matches && p > 0.3;
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
        Skip to analysis
      </a>
      <div className="world-background" aria-hidden="true">
        <div className="mountain-scene" />
        <div className="scene-shade" />
        <div className="ambient-clouds" />
        <div className="valley-mist">
          <div className="cloud-current" />
        </div>
      </div>
      <main>
        <section
          ref={journey}
          id="entrance"
          className="scroll-journey"
          aria-labelledby="entrance-title"
        >
          <div className="journey-stage">
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
