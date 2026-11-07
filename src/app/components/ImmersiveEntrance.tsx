'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode, type Ref } from 'react';
import { preload } from 'react-dom';
import { Arch, Wordmark } from './brand';
import { EntranceComposer } from './EntranceComposer';
import { LegalLinks } from './LegalPage';

/**
 * La porte : l'arche du logo, au loin dans la vallée, là où la caméra avance.
 * Au défilement, elle grandit, son rideau de 14 lanières s'écarte derrière
 * les piliers, puis on la traverse et l'on entre dans les nuages.
 */
function Gate({ ref }: { ref: Ref<SVGSVGElement> }) {
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
    <svg ref={ref} className="valley-gate" viewBox="0 0 100 120" focusable="false">
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

/** viewBox of the gate: the opening's inner arch, in gate units. */
const GATE = { cx: 50, cy: 46, ri: 29, floor: 106, origin: 66, height: 120 };

/**
 * Smallest scale at which the gate's opening fills the whole viewport, so the
 * camera is truly inside the gate (no pillar left on screen) before it fades.
 */
function coverScale(vw: number, vh: number, gateHeight: number, gateY: number) {
  const fits = (scale: number) => {
    const unit = GATE.height / (gateHeight * scale);
    const x = (vw / 2) * unit;
    if (x >= GATE.ri) return false;
    const top = GATE.origin - gateY * unit;
    const bottom = GATE.origin + (vh - gateY) * unit;
    return top > GATE.cy - Math.sqrt(GATE.ri ** 2 - x ** 2) && bottom < GATE.floor;
  };
  let low = 1;
  let high = 2;
  while (!fits(high) && high < 4096) high *= 2;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (fits(mid)) high = mid;
    else low = mid;
  }
  return high;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const range = (p: number, from: number, to: number) => clamp((p - from) / (to - from));
const smooth = (n: number) => n * n * (3 - 2 * n);

/** Keys that scroll the page: pressing one means the reader takes over. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
let stopScroll: (() => void) | null = null;

/**
 * Scrolls the page to an in-page target over a fixed time. Each step recomputes
 * where the target is and the last one lands exactly on it, however slow the
 * frames are: the browser's own smooth scroll can start late or stop short
 * under load. A timer backs up each animation frame, and the arrival is checked
 * once more after landing. Only a real intent to scroll (wheel, touch, a
 * scrolling key) hands the page back to the reader; a click elsewhere does
 * not, and a new link scroll simply replaces the running one.
 */
function scrollToTarget(target: HTMLElement, done: () => void) {
  stopScroll?.();
  const from = window.scrollY;
  const goal = () => {
    const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return Math.max(0, Math.min(max, target.getBoundingClientRect().top + window.scrollY - margin));
  };
  const duration = Math.min(1400, 600 + Math.abs(goal() - from) * 0.15);
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  let start = 0;
  let frame = 0;
  let backup = 0;
  function next() {
    frame = requestAnimationFrame(step);
    backup = window.setTimeout(() => step(performance.now()), 100);
  }
  function stop() {
    cancelAnimationFrame(frame);
    window.clearTimeout(backup);
    window.removeEventListener('wheel', stop, true);
    window.removeEventListener('touchstart', stop, true);
    window.removeEventListener('keydown', onKey, true);
    if (stopScroll === stop) stopScroll = null;
    done();
  }
  function onKey(event: KeyboardEvent) {
    if (SCROLL_KEYS.has(event.key)) stop();
  }
  function land() {
    const to = goal();
    if (Math.abs(window.scrollY - to) > 1) window.scrollTo({ top: to, behavior: 'instant' });
  }
  function step(now: number) {
    cancelAnimationFrame(frame);
    window.clearTimeout(backup);
    if (!start) start = now;
    const t = Math.min(1, (now - start) / duration);
    const to = goal();
    window.scrollTo({ top: t < 1 ? from + (to - from) * ease(t) : to, behavior: 'instant' });
    if (t < 1) return next();
    // Verify the arrival once layout has settled, then let go.
    frame = requestAnimationFrame(() => {
      land();
      stop();
    });
    backup = window.setTimeout(() => {
      land();
      stop();
    }, 150);
  }
  window.addEventListener('wheel', stop, { capture: true, passive: true });
  window.addEventListener('touchstart', stop, { capture: true, passive: true });
  window.addEventListener('keydown', onKey, true);
  stopScroll = stop;
  next();
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
  const gate = useRef<SVGSVGElement>(null);
  // While a link scrolls the page, the scene follows the scroll exactly: that
  // scroll is already eased, a second easing would only lag behind it.
  const following = useRef(false);
  // The photograph is the first thing seen: fetch it with the document.
  preload('/images/seal-mountain-mist.webp', { as: 'image', fetchPriority: 'high' });

  useEffect(() => {
    const element = root.current;
    const section = journey.current;
    if (!element || !section) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scene = element.querySelector<HTMLElement>('.world-background');
    const stage = section.querySelector<HTMLElement>('.journey-stage');
    // Each value is written on the smallest subtree that uses it, and only when
    // it changes, so a frame restyles the scene, never the whole workspace.
    const written = new Map<string, string>();
    function write(target: HTMLElement | null, name: string, value: string) {
      if (!target || written.get(name) === value) return;
      written.set(name, value);
      target.style.setProperty(name, value);
    }
    // Layout is read on resize only; every frame then writes, never reads.
    let top = 0;
    let distance = 1;
    let viewport = 1;
    let cover = 24;
    function measure() {
      if (!element || !section) return;
      viewport = window.innerHeight;
      top = section.getBoundingClientRect().top + window.scrollY;
      distance = Math.max(1, section.offsetHeight - viewport);
      const gateHeight = gate.current ? parseFloat(getComputedStyle(gate.current).height) : 0;
      const gateY = parseFloat(getComputedStyle(element).getPropertyValue('--gate-y'));
      cover = coverScale(
        window.innerWidth,
        viewport,
        gateHeight > 0 ? gateHeight : viewport * 0.16,
        Number.isFinite(gateY) ? (gateY / 100) * viewport : viewport * 0.67,
      );
    }

    // The scene eases toward the scroll position: a wheel notch becomes a short
    // glide instead of a jump, while the page itself keeps native scrolling.
    let frame = 0;
    let shown = -1;
    let previous = 0;
    function setFlag(name: string, value: string) {
      if (element!.dataset[name] !== value) element!.dataset[name] = value;
    }
    function render(y: number) {
      const still = reduced.matches;
      const p = still ? 0 : clamp((y - top) / distance);

      // 1. The copy lifts away first, quickly, so the valley is clear.
      const leave = range(p, 0, 0.18);
      write(stage, '--copy-opacity', (1 - smooth(leave)).toFixed(3));
      write(stage, '--copy-shift', `${(-leave * leave * 72).toFixed(2)}px`);

      // 2. The camera dollies into the valley at a steady pace, then settles.
      const camera = still ? 0 : clamp((y - top) / (distance + viewport * 0.5));
      write(scene, '--camera-scale', (3.2 ** (1 - (1 - camera) ** 1.7)).toFixed(4));

      // 3. The gate approaches like a real object (1 / distance), its curtain
      //    parts, and it stays solid until its opening fills the screen: no
      //    translucent pillar can ever streak across the clouds.
      const through = 0.42;
      const reach = cover * 1.35;
      const k = 1 - 1 / reach;
      const approach = range(p, 0, through);
      const inside = ((1 - 1 / cover) / k) * through;
      write(scene, '--gate-open', smooth(range(p, 0.03, 0.2)).toFixed(4));
      write(scene, '--gate-scale', (1 / (1 - approach * k)).toFixed(4));
      write(scene, '--gate-opacity', (1 - smooth(range(p, inside, inside + 0.05))).toFixed(4));

      // 4. A cloud bank closes in as the camera enters the gate, then thins out
      //    over the workspace.
      const fog =
        smooth(range(p, inside - 0.06, inside + 0.03)) * (1 - smooth(range(p, 0.54, 0.76)));
      const drift = range(p, inside - 0.12, 0.8);
      write(scene, '--mist-opacity', (fog * 0.95).toFixed(4));
      write(scene, '--mist-scale', (1 + drift * 1.3).toFixed(4));
      write(scene, '--mist-shift', `${((0.5 - drift) * 14).toFixed(3)}%`);
      write(scene, '--mist-spread', `${(drift * 18).toFixed(3)}%`);
      write(scene, '--reading-shade', (still ? 0.65 : smooth(range(p, 0.3, 0.74))).toFixed(3));

      // 5. The rail stays as a gauge until the workspace takes over.
      write(stage, '--journey', p.toFixed(4));
      write(stage, '--gauge', range(p, 0, 0.5).toFixed(4));
      write(stage, '--caption-opacity', (1 - smooth(range(p, 0.48, 0.6))).toFixed(4));

      setFlag('gate', p > inside + 0.05 ? 'passed' : 'ahead');
      // Layers that cannot be seen are not drawn at all: the cloud bank and
      // its endless wind cost a full-screen composite on every frame.
      setFlag('mist', fog > 0.001 ? 'on' : 'off');
      setFlag('entered', String(p > 0.6));
    }
    let scrolled = 0;
    function tick(now: number) {
      frame = 0;
      const target = window.scrollY;
      const dt = previous ? Math.min(250, Math.max(0, now - previous)) : 16;
      previous = now;
      const gap = target - shown;
      if (
        shown < 0 ||
        reduced.matches ||
        following.current ||
        // A jump (a link, the keyboard, a restored position) is shown at once.
        Math.abs(gap) > viewport ||
        // Close enough, or the scroll has stopped: land exactly on the target.
        Math.abs(gap) < 0.5 ||
        now - scrolled > 600
      ) {
        shown = target;
      } else {
        shown += gap * (1 - Math.exp(-dt / 110));
      }
      render(shown);
      setFlag('travelling', String(target > 50));
      const away = !reduced.matches && target - top > distance * 0.18;
      if (copy.current && copy.current.inert !== away) copy.current.inert = away;
      if (shown !== target) frame = requestAnimationFrame(tick);
      else previous = 0;
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(tick);
    }
    function onScroll() {
      scrolled = performance.now();
      schedule();
    }
    function resize() {
      measure();
      written.clear();
      shown = -1;
      schedule();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(section);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', resize);
    reduced.addEventListener('change', resize);
    measure();
    tick(performance.now());
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resize);
      reduced.removeEventListener('change', resize);
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
        // A link to a question opens its tile.
        if (target instanceof HTMLDetailsElement) target.open = true;
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          target.scrollIntoView({ behavior: 'instant', block: 'start' });
        } else {
          // Started first: replacing a running scroll releases the scene
          // before this one takes it.
          scrollToTarget(target, () => (following.current = false));
          following.current = true;
        }
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
          <Gate ref={gate} />
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
            Analyze
            <span className="cta-orb" aria-hidden="true">
              →
            </span>
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
              <p className="scene-eyebrow">
                <span>
                  Robinhood Chain <span aria-hidden="true">·</span> pons, Virtuals, Doppler, flap.sh
                </span>
              </p>
              <h1 id="entrance-title">
                Paste a token. <em>Read its story.</em>
              </h1>
              <p className="entrance-description">
                Who launched it, who holds it, how it really trades: read from public data and
                explained in plain words. No score, because a score hides what contradicts.
              </p>
              <EntranceComposer />
            </div>
            <div className="journey-caption">
              <span className="caption-chapter">
                <span className="caption-index">01</span>
                The context
              </span>
              <a href="#analysis" className="caption-cue">
                <span className="curtain-progress" aria-hidden="true">
                  {Array.from({ length: 14 }, (_, i) => (
                    <span key={i} style={{ '--i': i } as CSSProperties} />
                  ))}
                </span>
                Scroll to explore
                <span className="caption-arrow" aria-hidden="true">
                  ↓
                </span>
              </a>
              <span className="caption-network">Robinhood Chain</span>
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
                {environment !== 'production' ? `Environment: ${environment}` : 'Robinhood Chain'}
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
