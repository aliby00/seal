import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  random,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

export const inter = loadInter('normal', {
  weights: ['500', '600', '700'],
  subsets: ['latin'],
}).fontFamily;
export const mono = loadMono('normal', { weights: ['400', '700'], subsets: ['latin'] }).fontFamily;

export const FPS = 60;
/** SEAL v2 — cire, os, encre. */
export const INK = '#0B0B0C';
export const WAX = '#E5432A';
export const WAX_DEEP = '#A82A17';
export const BONE = '#EEEBE3';
export const ASH = 'rgba(238,235,227,0.42)';
export const LINE = 'rgba(238,235,227,0.10)';

/**
 * Handle X affiché en fin de film. Vide tant que le vrai n'est pas confirmé :
 * mieux vaut aucun handle qu'un handle qui envoie chez quelqu'un d'autre.
 */
export const HANDLE = '';

export const ease = Easing.bezier(0.65, 0, 0.35, 1);
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const back = Easing.bezier(0.34, 1.56, 0.64, 1);

export const lerp = (t: number, a: number, b: number, from: number, to: number, e = ease) =>
  interpolate(t, [a, b], [from, to], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: e,
  });

export const useT = () => useCurrentFrame() / FPS;
export const useV = () => {
  const { width, height } = useVideoConfig();
  return height > width;
};

/* ── Le sceau ─────────────────────────────────────────────────────────── */

const SECTOR = (2 * Math.PI) / 14;

/** Contour du cachet. `lobes[i]` = hauteur du lobe i (bit 13 - i), de 0 à 1. */
export function waxPath(c: number, R: number, A: number, lobes: number[], offAmp = 0.25) {
  const N = 14 * 24;
  let d = '';
  for (let k = 0; k <= N; k++) {
    const t = (k / N) * 2 * Math.PI;
    const i = Math.floor(t / SECTOR) % 14;
    const u = (t - i * SECTOR) / SECTOR;
    const amp = offAmp + (1 - offAmp) * (lobes[i] ?? 0);
    const r = R + A * amp * Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.7);
    const a = -Math.PI / 2 - SECTOR / 2 + t;
    d += `${k === 0 ? 'M' : 'L'}${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`;
  }
  return d + 'Z';
}

export const maskLobes = (mask: number) =>
  Array.from({ length: 14 }, (_, i) => ((mask >> (13 - i)) & 1 ? 1 : 0));

export const Wax: React.FC<{
  size: number;
  lobes: number[];
  /** Apparition globale du corps de cire (échelle). */
  body?: number;
  ring?: number;
  mono?: number;
  color?: string;
  deep?: string;
  /** Hauteur des lobes. Plus haut pour les sceaux de données : la forme doit se lire. */
  depth?: number;
  /** Hauteur d'un lobe éteint, en part d'un lobe allumé. */
  offAmp?: number;
  style?: React.CSSProperties;
}> = ({
  size,
  lobes,
  body = 1,
  ring = 1,
  mono = 1,
  color = WAX,
  deep = WAX_DEEP,
  depth = 5.5,
  offAmp = 0.25,
  style,
}) => {
  const c = 50;
  const R = (47.5 - depth) * body;
  const sw = 38,
    sh = 34,
    st = 7,
    s2 = st / 2,
    rr = sh / 4,
    ox = c - sw / 2,
    oy = c - sh / 2;
  const S = `M${ox + sw - s2} ${oy + s2} H${ox + rr + s2} A${rr} ${rr} 0 0 0 ${ox + rr + s2} ${oy + sh / 2} H${ox + sw - rr - s2} A${rr} ${rr} 0 0 1 ${ox + sw - rr - s2} ${oy + sh - s2} H${ox + s2}`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
      {body > 0.001 && <path d={waxPath(c, R, depth * body, lobes, offAmp)} fill={color} />}
      {ring > 0 && (
        <circle
          cx={c}
          cy={c}
          r={31}
          fill="none"
          stroke={deep}
          strokeWidth={2.8}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - ring}
          transform="rotate(-90 50 50)"
        />
      )}
      {mono > 0 && (
        <path
          d={S}
          fill="none"
          stroke={deep}
          strokeWidth={st}
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - mono}
        />
      )}
    </svg>
  );
};

/* ── Le wordmark, au trait ────────────────────────────────────────────── */

const WM = (() => {
  const stroke = 7,
    h = 40,
    w = 46,
    gap = 18,
    s = stroke / 2,
    r = h / 4;
  return {
    stroke,
    h,
    w,
    gap,
    letters: [
      `M${w - s} ${s} H${r + s} A${r} ${r} 0 0 0 ${r + s} ${h / 2} H${w - r - s} A${r} ${r} 0 0 1 ${w - r - s} ${h - s} H${s}`,
      `M${w - s} ${s} H${s} M${w - s * 3} ${h / 2} H${s} M${w - s} ${h - s} H${s}`,
      `M${s} ${h} V${h / 2} A${w / 2 - s} ${w / 2 - s} 0 0 1 ${w - s} ${h / 2} V${h} M${s} ${h * 0.62} H${w - s}`,
      `M${s} 0 V${h - s} H${w - s}`,
    ],
  };
})();

export const Wordmark: React.FC<{ width: number; progress?: number; color?: string }> = ({
  width,
  progress = 1,
  color = BONE,
}) => {
  const W = 4 * WM.w + 3 * WM.gap;
  return (
    <svg
      width={width}
      height={(width * (WM.h + 4)) / (W + 4)}
      viewBox={`-2 -2 ${W + 4} ${WM.h + 4}`}
    >
      {WM.letters.map((d, i) => {
        const p = Math.min(1, Math.max(0, progress * 4 - i * 0.75));
        return (
          <path
            key={i}
            transform={`translate(${i * (WM.w + WM.gap)} 0)`}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={WM.stroke}
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - p}
          />
        );
      })}
    </svg>
  );
};

/* ── Fond ─────────────────────────────────────────────────────────────── */

export const Grain: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity: 0.07, mixBlendMode: 'overlay' }}>
      <svg width="100%" height="100%">
        <filter id={`g${f % 6}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" seed={f % 6} />
        </filter>
        <rect width="100%" height="100%" filter={`url(#g${f % 6})`} />
      </svg>
    </AbsoluteFill>
  );
};

export const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      background: 'radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.55) 100%)',
      pointerEvents: 'none',
    }}
  />
);

/** Grille fine : le papier millimétré de quelqu'un qui lit du code. */
export const Grid: React.FC<{ opacity?: number }> = ({ opacity = 1 }) => (
  <AbsoluteFill
    style={{
      opacity,
      backgroundImage: `linear-gradient(${LINE} 1px, transparent 1px), linear-gradient(90deg, ${LINE} 1px, transparent 1px)`,
      backgroundSize: '64px 64px',
      maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)',
    }}
  />
);

/* ── Texte ────────────────────────────────────────────────────────────── */

/** Ligne qui se tape caractère par caractère, curseur compris. */
export const Typed: React.FC<{
  text: string;
  start: number;
  cps?: number;
  style?: React.CSSProperties;
  cursor?: boolean;
}> = ({ text, start, cps = 38, style, cursor = true }) => {
  const t = useT();
  const n = Math.max(0, Math.floor((t - start) * cps));
  if (t < start) return null;
  const done = n >= text.length;
  const blink = Math.floor(t * 2.4) % 2 === 0;
  return (
    <span style={{ fontFamily: mono, whiteSpace: 'pre', ...style }}>
      {text.slice(0, n)}
      {cursor && (!done || blink) ? <span style={{ color: WAX }}>▍</span> : null}
    </span>
  );
};

/** Titre qui monte et se défloute, mot par mot. */
export const Rise: React.FC<{
  text: string;
  start: number;
  end: number;
  size: number;
  color?: string;
  accent?: string[];
  weight?: number;
  align?: 'center' | 'left';
}> = ({ text, start, end, size, color = BONE, accent = [], weight = 600, align = 'center' }) => {
  const t = useT();
  if (t < start - 0.05 || t > end + 0.05) return null;
  const words = text.split(' ');
  const out = lerp(t, end - 0.35, end, 0, 1, Easing.in(Easing.cubic));
  return (
    <div
      style={{
        fontFamily: inter,
        fontWeight: weight,
        fontSize: size,
        letterSpacing: '-0.035em',
        lineHeight: 1.04,
        color,
        textAlign: align,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        gap: `0 ${size * 0.26}px`,
        opacity: 1 - out,
        filter: `blur(${out * 10}px)`,
      }}
    >
      {words.map((w, i) => {
        const p = lerp(t, start + i * 0.07, start + i * 0.07 + 0.55, 0, 1, easeOut);
        const isAccent = accent.includes(w.replace(/[.,]/g, ''));
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: p,
              transform: `translateY(${(1 - p) * size * 0.35}px)`,
              filter: `blur(${(1 - p) * 8}px)`,
              color: isAccent ? WAX : undefined,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

export const Label: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style,
}) => (
  <div
    style={{
      fontFamily: mono,
      fontSize: 18,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: ASH,
      ...style,
    }}
  >
    {children}
  </div>
);

/* ── Fin ──────────────────────────────────────────────────────────────── */

export const EndCard: React.FC<{ start: number; line: string }> = ({ start, line }) => {
  const t = useT();
  const v = useV();
  if (t < start) return null;
  const k = t - start;
  const stamp = lerp(k, 0, 0.45, 0, 1, back);
  const lobes = Array.from({ length: 14 }, (_, i) =>
    lerp(k, 0.15 + i * 0.025, 0.45 + i * 0.025, 0, 1, easeOut),
  );
  const shake = k > 0.3 && k < 0.5 ? (random(Math.floor(k * 60)) - 0.5) * 8 : 0;
  const size = v ? 300 : 260;
  return (
    <AbsoluteFill
      style={{
        background: INK,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: v ? 56 : 44,
        opacity: lerp(k, 0, 0.12, 0, 1),
        transform: `translate(${shake}px, ${shake * 0.6}px)`,
      }}
    >
      <Grid opacity={0.5} />
      <div style={{ transform: `scale(${0.6 + 0.4 * stamp})` }}>
        <Wax
          size={size}
          lobes={lobes}
          body={stamp}
          ring={lerp(k, 0.45, 0.9, 0, 1)}
          mono={lerp(k, 0.55, 1.05, 0, 1)}
        />
      </div>
      <Wordmark width={v ? 620 : 560} progress={lerp(k, 0.6, 1.5, 0, 1, ease)} />
      <div
        style={{
          fontFamily: mono,
          fontSize: v ? 30 : 26,
          color: ASH,
          letterSpacing: '0.04em',
          opacity: lerp(k, 1.4, 1.9, 0, 1),
        }}
      >
        {line}
      </div>
      {HANDLE && (
        <div
          style={{ fontFamily: mono, fontSize: 24, color: BONE, opacity: lerp(k, 1.8, 2.2, 0, 1) }}
        >
          {HANDLE}
        </div>
      )}
    </AbsoluteFill>
  );
};

export const short = (a: string, n = 4) => `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
