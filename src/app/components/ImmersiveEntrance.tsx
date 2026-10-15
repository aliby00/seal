'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Arch, Wordmark } from './brand';
import { LegalLinks } from './LegalPage';

/**
 * La porte : l'arche du logo, au loin dans la vallée, là où la caméra avance.
 * Au défilement, elle grandit, son rideau de 14 lanières s'écarte derrière
 * les piliers, puis on la traverse et l'on entre dans les nuages.
 */
function Gate() {
  // viewBox 100 × 120 : une porte, plus haute que large.
  const x0 = 14,
    W = 72,
    t = 7,
    y0 = 10,
    base = 112,
    r = W / 2,
    ri = r - t,
    cy = y0 + r;
  const frame = `M${x0} ${base} V${cy} A${r} ${r} 0 0 1 ${x0 + W} ${cy} V${base} H${x0 + W - t} V${cy} A${ri} ${ri} 0 0 0 ${x0 + t} ${cy} V${base} Z`;
  const opening = `M${x0 + t} ${base} V${cy} A${ri} ${ri} 0 0 1 ${x0 + W - t} ${cy} V${base} Z`;
  const rim = `M${x0 + t} ${base} V${cy} A${ri} ${ri} 0 0 1 ${x0 + W - t} ${cy} V${base}`;
  const pitch = (2 * ri - 3) / 14;
  return (
    <svg className="valley-gate" viewBox="0 0 100 120" focusable="false">
      <defs>
        <clipPath id="gate-opening">
          <path d={opening} />
        </clipPath>
        <linearGradient id="gate-light" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#f6f1e6" stopOpacity="0.95" />
          <stop offset="0.45" stopColor="#dfe4df" stopOpacity="0.7" />
          <stop offset="1" stopColor="#b9c6c8" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id="gate-stone" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#141a18" />
          <stop offset="0.12" stopColor="#36413e" />
          <stop offset="0.5" stopColor="#252e2b" />
          <stop offset="0.88" stopColor="#36413e" />
          <stop offset="1" stopColor="#101614" />
        </linearGradient>
        <linearGradient id="gate-strip" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb873" />
          <stop offset="0.6" stopColor="#f2801c" />
          <stop offset="1" stopColor="#f2801c" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <path d={opening} fill="url(#gate-light)" />
      <g clipPath="url(#gate-opening)">
        {Array.from({ length: 14 }, (_, i) => {
          const x = x0 + t + 1.5 + pitch * i + pitch * 0.32;
          const dx = x + pitch * 0.18 - 50;
          const top = cy - Math.sqrt(Math.max(0, ri * ri - dx * dx)) + 1.5;
          return (
            <rect
              key={i}
              className="gate-strip"
              style={{ '--side': i < 7 ? -1 : 1 } as CSSProperties}
              x={x}
              y={top}
              width={pitch * 0.36}
              height={base - 4 - top}
              rx={pitch * 0.18}
              fill="url(#gate-strip)"
            />
          );
        })}
      </g>
      <path d={frame} fill="url(#gate-stone)" />
      <path className="gate-rim" d={rim} />
      {/* Clé de voûte et socles. */}
      <path
        d={`M${50 - 4} ${y0 - 1.5} H${50 + 4} L${50 + 3} ${y0 + t + 1} H${50 - 3} Z`}
        fill="#3e4946"
      />
      <rect x={x0 - 2} y={base - 4} width={t + 4} height={5} rx={0.8} fill="#2c3532" />
      <rect x={x0 + W - t - 2} y={base - 4} width={t + 4} height={5} rx={0.8} fill="#2c3532" />
    </svg>
  );
}

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
      element.style.setProperty('--journey', String(p));
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
      // The gate waits far down the valley, where the camera heads. It grows with
      // the camera, its curtain parts, then the camera passes through into the cloud.
      const open = smooth(clamp((p - 0.06) / 0.22));
      const through = clamp((p - 0.14) / 0.36);
      element.style.setProperty('--gate-open', String(open));
      element.style.setProperty('--gate-scale', String(1 + through * through * 8));
      element.style.setProperty('--gate-opacity', String(1 - smooth(clamp((p - 0.4) / 0.16))));
      element.dataset.gate = p > 0.56 ? 'passed' : 'ahead';
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
        <div className="mountain-scene">
          <svg
            className="valley-water"
            viewBox="0 0 1536 1024"
            preserveAspectRatio="xMidYMid slice"
            focusable="false"
          >
            <g className="water-flow">
              <path d="M754 652 Q786 674 768 684 T793 719 Q775 730 811 738 T796 763 Q770 775 797 785 L813 797 L805 817" />
              <path d="M1327 520 Q1316 550 1318 573 T1303 627 Q1292 649 1288 673 T1268 720 L1255 753" />
              <path d="M790 796 L795 817 M811 799 L814 825" />
            </g>
          </svg>
        </div>
        <div className="scene-shade" />
        <div className="ambient-clouds" />
        <div className="gate-anchor">
          <div className="gate-halo" />
          <Gate />
          <div className="gate-fog" />
        </div>
        <div className="valley-mist">
          <div className="cloud-current" />
        </div>
      </div>
      <header className="world-nav">
        <a className="world-brand" href="#entrance" aria-label="SEAL">
          <Arch className="brand-arch" strips={5} />
          <Wordmark className="brand-word" />
        </a>
        <nav aria-label="Sections">
          <a href="#method">Method</a>
          <a href="#analysis" className="nav-enter">
            Analyze <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
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
                <span className="curtain-progress" aria-hidden="true">
                  {Array.from({ length: 14 }, (_, i) => (
                    <span key={i} style={{ '--i': i } as CSSProperties} />
                  ))}
                </span>
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
        <span className="world-brand" aria-hidden="true">
          <Arch className="brand-arch" strips={5} />
          <Wordmark className="brand-word" />
        </span>
        <p>The facts. The context. Your perspective.</p>
        <LegalLinks />
        <a href="#analysis">Open analysis ↗</a>
      </footer>
    </div>
  );
}
