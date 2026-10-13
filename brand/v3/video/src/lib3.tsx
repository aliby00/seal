import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont as loadArchivo } from '@remotion/google-fonts/Archivo';
import { loadFont as loadMono } from '@remotion/google-fonts/MartianMono';

export const display = loadArchivo('normal', {
  weights: ['600', '800'],
  subsets: ['latin'],
}).fontFamily;
export const mono = loadMono('normal', { weights: ['400', '600'], subsets: ['latin'] }).fontFamily;

export const FPS = 60;
/** SEAL v3 — le contrôle aux rayons X. */
export const SCAN = '#E6ECEE';
export const SCAN_DEEP = '#D3DCDF';
export const DENSE = '#0E1317';
export const ORGANIC = '#F2801C';
export const ORGANIC_DENSE = '#B9500B';
export const METAL = '#1E4FD8';
export const MIXED = '#2F9A5B';
export const LEAD = '#5E6A73';
export const RULE = 'rgba(14,19,23,0.12)';

/** Vide tant que le vrai handle X n'est pas confirmé. */
export const HANDLE = '';

export const ease = Easing.bezier(0.65, 0, 0.35, 1);
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const back = Easing.bezier(0.34, 1.4, 0.64, 1);

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
export const short = (a: string, n = 4) => `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
export const bitOn = (mask: number, bit: number) => (mask >> bit) & 1;

/* ── L'arche et son rideau ──────────────────────────────────────────── */

/**
 * `drop[i]` : descente de la lanière i (bit 13 - i), de 0 à 1.
 * `frame` : tracé de l'arche, de 0 à 1.
 */
export const Arch: React.FC<{
  size: number;
  mask?: number;
  drop?: number[];
  frame?: number;
  frameColor?: string;
  stripColor?: string;
  strips?: number;
  style?: React.CSSProperties;
}> = ({
  size,
  mask = 0x3fff,
  drop,
  frame = 1,
  frameColor = METAL,
  stripColor = ORGANIC,
  strips = 14,
  style,
}) => {
  const W = 78,
    H = 86,
    x0 = 11,
    y0 = 7,
    t = 8,
    r = W / 2;
  const cx = 50,
    cy = y0 + r,
    ri = r - t;
  const ix0 = x0 + t + 3,
    ix1 = x0 + W - t - 3;
  const pitch = (ix1 - ix0) / strips;
  const sw = pitch * (strips === 14 ? 0.72 : 0.62);
  // Arche au trait (axe médian), pour pouvoir la tracer progressivement.
  const rm = r - t / 2;
  const d = `M${x0 + t / 2} ${y0 + H} V${cy} A${rm} ${rm} 0 0 1 ${x0 + W - t / 2} ${cy} V${y0 + H}`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
      {Array.from({ length: strips }, (_, i) => {
        const on = strips === 14 ? bitOn(mask, 13 - i) : 1;
        const x = ix0 + pitch * i + (pitch - sw) / 2;
        const dx = x + sw / 2 - cx;
        const top = cy - Math.sqrt(Math.max(0, ri * ri - dx * dx)) + 4;
        const full = (on ? y0 + H - 7 : cy + 4) - top;
        const p = drop ? (drop[i] ?? 0) : 1;
        if (p <= 0.001) return null;
        return (
          <rect
            key={i}
            x={x}
            y={top}
            width={sw}
            height={Math.max(sw, full * p)}
            rx={sw / 2}
            fill={stripColor}
          />
        );
      })}
      <path
        d={d}
        fill="none"
        stroke={frameColor}
        strokeWidth={t}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - frame}
      />
    </svg>
  );
};

/* ── Wordmark pochoir ───────────────────────────────────────────────── */

const WM = (() => {
  const h = 60,
    w = 50,
    t = 12,
    g = 4,
    mt = (h - t) / 2,
    ra = w / 2;
  const rect = (x: number, y: number, ww: number, hh: number) =>
    `M${x} ${y} h${ww} v${hh} h${-ww} Z`;
  return {
    h,
    w,
    gap: 16,
    letters: [
      [
        rect(0, 0, w, t),
        `M0 ${t + g} H${t} V${mt} H${w} V${mt + t} H0 Z`,
        `M${w - t} ${mt + t + g} H${w} V${h} H0 V${h - t} H${w - t} Z`,
      ],
      [
        rect(0, 0, t, h),
        rect(t + g, 0, w - t - g, t),
        rect(t + g, mt, w - t - g - 8, t),
        rect(t + g, h - t, w - t - g, t),
      ],
      [
        `M0 ${h} V${ra} A${ra} ${ra} 0 0 1 ${w} ${ra} V${h} H${w - t} V${ra} A${ra - t} ${ra - t} 0 0 0 ${t} ${ra} V${h} Z`,
        rect(t + g, 36, w - 2 * t - 2 * g, t - 2),
      ],
      [rect(0, 0, t, h - t - g), rect(0, h - t, w, t)],
    ],
  };
})();

/** Les pièces du pochoir glissent en place une par une. */
export const Wordmark: React.FC<{
  width: number;
  progress?: number;
  color?: string;
  archColor?: string;
}> = ({ width, progress = 1, color = DENSE, archColor }) => {
  const W = 4 * WM.w + 3 * WM.gap;
  const pieces = WM.letters.flatMap((parts, li) => parts.map((d, pi) => ({ d, li, pi })));
  return (
    <svg
      width={width}
      height={(width * (WM.h + 4)) / (W + 4)}
      viewBox={`-2 -2 ${W + 4} ${WM.h + 4}`}
      style={{ overflow: 'visible' }}
    >
      {pieces.map(({ d, li, pi }, k) => {
        const p = Math.min(1, Math.max(0, progress * (pieces.length + 3) - k));
        const e = 1 - Math.pow(1 - p, 3);
        return (
          <path
            key={k}
            d={d}
            transform={`translate(${li * (WM.w + WM.gap)} ${(1 - e) * (pi % 2 ? 14 : -14)})`}
            fill={li === 2 && pi === 0 && archColor ? archColor : color}
            opacity={e}
          />
        );
      })}
    </svg>
  );
};

/* ── L'image aux rayons X d'un marché ───────────────────────────────── */

type Obj = { bits: number[]; color: string; x: number; y: number; w: number; h: number; r: number };
/**
 * Chaque famille de permissions devient un objet dans le bagage. Orange : ce
 * qui touche aux échanges, donc à la sortie de celui qui détient. Bleu : la
 * liquidité. Vert : le reste. Un bagage vide, c'est un marché sans rulebook.
 */
const OBJECTS: Obj[] = [
  { bits: [7, 6], color: ORGANIC, x: 10, y: 14, w: 46, h: 30, r: 15 },
  { bits: [3, 2], color: ORGANIC_DENSE, x: 26, y: 22, w: 22, h: 22, r: 11 },
  { bits: [9, 8, 0], color: METAL, x: 54, y: 38, w: 36, h: 22, r: 4 },
  { bits: [11, 10, 1], color: METAL, x: 60, y: 14, w: 26, h: 14, r: 3 },
  { bits: [13, 12], color: MIXED, x: 12, y: 48, w: 16, h: 16, r: 8 },
  { bits: [5, 4], color: MIXED, x: 34, y: 50, w: 14, h: 10, r: 3 },
];

export const Xray: React.FC<{
  mask: number;
  width: number;
  /** Révélation du contenu, de 0 à 1. */
  reveal?: number;
  /** Bagage opaque (hors du scanner) plutôt que vu aux rayons X. */
  opaque?: boolean;
  style?: React.CSSProperties;
}> = ({ mask, width, reveal = 1, opaque = false, style }) => {
  const h = (width * 72) / 100;
  return (
    <svg width={width} height={h} viewBox="0 0 100 72" style={style}>
      <rect
        x={4}
        y={6}
        width={92}
        height={62}
        rx={9}
        fill={opaque ? '#9AA6AD' : 'rgba(255,255,255,0.35)'}
        stroke={opaque ? '#7E8B92' : LEAD}
        strokeWidth={opaque ? 0 : 1.2}
        strokeDasharray={mask === 0 && !opaque ? '3 2.5' : undefined}
      />
      <rect
        x={38}
        y={1}
        width={24}
        height={7}
        rx={3}
        fill="none"
        stroke={opaque ? '#7E8B92' : LEAD}
        strokeWidth={2}
      />
      {!opaque &&
        OBJECTS.map((o, i) => {
          const n = o.bits.filter((b) => bitOn(mask, b)).length;
          if (n === 0) return null;
          const k = Math.min(1, Math.max(0, reveal * 1.6 - i * 0.12));
          return (
            <rect
              key={i}
              x={o.x}
              y={o.y}
              width={o.w}
              height={o.h}
              rx={o.r}
              fill={o.color}
              opacity={(0.45 + 0.25 * n) * k}
              style={{ mixBlendMode: 'multiply' }}
            />
          );
        })}
    </svg>
  );
};

/* ── Fond ───────────────────────────────────────────────────────────── */

/** Lignes de balayage, très légères : on regarde un écran de contrôle. */
export const Scanlines: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      backgroundImage:
        'repeating-linear-gradient(0deg, rgba(14,19,23,0.035) 0 1px, transparent 1px 4px)',
    }}
  />
);

export const Grain: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity: 0.08, mixBlendMode: 'multiply' }}>
      <svg width="100%" height="100%">
        <filter id={`g3${f % 6}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" seed={f % 6} />
        </filter>
        <rect width="100%" height="100%" filter={`url(#g3${f % 6})`} />
      </svg>
    </AbsoluteFill>
  );
};

/** Faisceau horizontal, à la hauteur `y` en pixels. */
export const Beam: React.FC<{ y: number; opacity?: number }> = ({ y, opacity = 1 }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      right: 0,
      top: y - 40,
      height: 80,
      opacity,
      background: `linear-gradient(transparent, rgba(242,128,28,0.10) 42%, ${ORGANIC} 50%, rgba(242,128,28,0.10) 58%, transparent)`,
      pointerEvents: 'none',
    }}
  />
);

/* ── Texte ──────────────────────────────────────────────────────────── */

export const Rise: React.FC<{
  text: string;
  start: number;
  end: number;
  size: number;
  color?: string;
  accent?: string[];
  accentColor?: string;
}> = ({ text, start, end, size, color = DENSE, accent = [], accentColor = ORGANIC }) => {
  const t = useT();
  if (t < start - 0.05 || t > end + 0.05) return null;
  const out = lerp(t, end - 0.3, end, 0, 1, Easing.in(Easing.cubic));
  return (
    <div
      style={{
        fontFamily: display,
        fontWeight: 800,
        fontSize: size,
        letterSpacing: '-0.03em',
        lineHeight: 1.02,
        color,
        textAlign: 'center',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: `0 ${size * 0.24}px`,
        opacity: 1 - out,
        transform: `translateY(${-out * 20}px)`,
      }}
    >
      {text.split(' ').map((w, i) => {
        const p = lerp(t, start + i * 0.06, start + i * 0.06 + 0.45, 0, 1, easeOut);
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              clipPath: `inset(0 0 ${(1 - p) * 100}% 0)`,
              transform: `translateY(${(1 - p) * size * 0.4}px)`,
              color: accent.includes(w.replace(/[.,]/g, '')) ? accentColor : undefined,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

export const Tag: React.FC<{
  children: React.ReactNode;
  color?: string;
  style?: React.CSSProperties;
}> = ({ children, color = LEAD, style }) => (
  <div
    style={{
      fontFamily: mono,
      fontSize: 18,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color,
      ...style,
    }}
  >
    {children}
  </div>
);

/* ── Fin ────────────────────────────────────────────────────────────── */

export const EndCard: React.FC<{ start: number; line: string }> = ({ start, line }) => {
  const t = useT();
  const v = useV();
  if (t < start) return null;
  const k = t - start;
  const drop = Array.from({ length: 14 }, (_, i) =>
    lerp(k, 0.35 + i * 0.03, 0.75 + i * 0.03, 0, 1, easeOut),
  );
  const size = v ? 300 : 250;
  return (
    <AbsoluteFill
      style={{
        background: SCAN,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: v ? 54 : 40,
        clipPath: `inset(0 0 ${(1 - lerp(k, 0, 0.35, 0, 1, ease)) * 100}% 0)`,
      }}
    >
      <Arch size={size} drop={drop} frame={lerp(k, 0.05, 0.55, 0, 1)} />
      <Wordmark
        width={v ? 560 : 500}
        progress={lerp(k, 0.7, 1.6, 0, 1, (x) => x)}
        archColor={METAL}
      />
      <div
        style={{
          fontFamily: mono,
          fontSize: v ? 28 : 24,
          color: LEAD,
          opacity: lerp(k, 1.5, 1.9, 0, 1),
        }}
      >
        {line}
      </div>
      {HANDLE && (
        <div
          style={{ fontFamily: mono, fontSize: 24, color: DENSE, opacity: lerp(k, 1.8, 2.2, 0, 1) }}
        >
          {HANDLE}
        </div>
      )}
      <Scanlines />
    </AbsoluteFill>
  );
};
