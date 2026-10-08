import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  random,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadSerif } from '@remotion/google-fonts/InstrumentSerif';

export const inter = loadInter('normal', { weights: ['500', '600', '700'] }).fontFamily;
export const mono = loadMono('normal', { weights: ['400', '500'] }).fontFamily;
export const serif = loadSerif('italic').fontFamily;

export const FPS = 60;
export const BG = '#090c0b';
export const SAGE = '#b9d4c0';
export const CREAM = '#f0f3ed';
export const MID = '#304d3c';
export const DIM = 'rgba(240,243,237,0.34)';

export const ease = Easing.bezier(0.65, 0, 0.35, 1);
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

/** Interpolation bornée, en secondes — tous les repères du film sont écrits en secondes. */
export const lerp = (t: number, a: number, b: number, from: number, to: number, e = ease) =>
  interpolate(t, [a, b], [from, to], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: e,
  });

export const useT = () => useCurrentFrame() / FPS;

/** Vrai en 9:16 — sert à remonter le texte et à grossir les corps. */
export const useVertical = () => {
  const { width, height } = useVideoConfig();
  return height > width;
};

/* ── Texte mot par mot : flou → net, léger glissé ───────────────────────── */
type Part = { w: string; em?: boolean };
export const P = (s: string): Part[] =>
  s
    .split(/(\*[^*]+\*)/)
    .filter(Boolean)
    .flatMap((c) =>
      c.startsWith('*')
        ? c
            .slice(1, -1)
            .split(' ')
            .map((w) => ({ w, em: true }))
        : c
            .trim()
            .split(' ')
            .filter(Boolean)
            .map((w) => ({ w })),
    );

export const Words: React.FC<{
  parts: Part[];
  start: number;
  end: number;
  size: number;
  top?: number | 'center';
  sub?: string;
}> = ({ parts, start, end, size, top = 'center', sub }) => {
  const t = useT();
  const { fps } = useVideoConfig();
  if (t < start - 0.1 || t > end + 0.1) return null;
  const out = lerp(t, end - 0.3, end, 0, 1, Easing.in(Easing.cubic));
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        flexDirection: 'column',
        justifyContent: top === 'center' ? 'center' : 'flex-start',
        paddingTop: top === 'center' ? 0 : top,
        paddingLeft: 70,
        paddingRight: 70,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: `${size * 0.14}px ${size * 0.26}px`,
          fontFamily: inter,
          fontWeight: 600,
          fontSize: size,
          color: CREAM,
          letterSpacing: '-0.035em',
          lineHeight: 1.12,
          textAlign: 'center',
          filter: `blur(${out * 10}px)`,
          opacity: 1 - out,
        }}
      >
        {parts.map((p, i) => {
          const s = spring({
            frame: (t - start - i * 0.07) * fps,
            fps,
            config: { damping: 200, mass: 0.7 },
          });
          return (
            <span
              key={i}
              style={{
                display: 'inline-block',
                opacity: s,
                filter: `blur(${(1 - s) * 13}px)`,
                transform: `translateY(${(1 - s) * 24}px)`,
                ...(p.em
                  ? { fontFamily: serif, fontWeight: 400, fontSize: size * 1.1, color: SAGE }
                  : {}),
              }}
            >
              {p.w}
            </span>
          );
        })}
      </div>
      {sub
        ? (() => {
            const s = spring({ frame: (t - start - 0.4) * fps, fps, config: { damping: 200 } });
            return (
              <div
                style={{
                  marginTop: 18,
                  fontFamily: mono,
                  fontSize: size * 0.3,
                  letterSpacing: '0.14em',
                  color: DIM,
                  opacity: s * (1 - out),
                }}
              >
                {sub}
              </div>
            );
          })()
        : null}
    </AbsoluteFill>
  );
};

/* ── Compteur qui s'incrémente ──────────────────────────────────────────── */
export const Counter: React.FC<{
  to: number;
  start: number;
  dur: number;
  size: number;
  color?: string;
}> = ({ to, start, dur, size, color = CREAM }) => {
  const t = useT();
  const n = Math.round(lerp(t, start, start + dur, 0, to, easeOut));
  return (
    <span
      style={{
        fontFamily: mono,
        fontWeight: 500,
        fontSize: size,
        color,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {n}
    </span>
  );
};

/* ── La marque, dessinée (le tampon) ────────────────────────────────────── */
export const Mark: React.FC<{ size: number; draw?: number }> = ({ size, draw = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 128 128">
    <rect x="14" y="14" width="100" height="100" rx="14" fill={SAGE} opacity={draw} />
    <rect
      x="25"
      y="25"
      width="78"
      height="78"
      rx="7"
      fill="none"
      stroke={BG}
      strokeWidth="4.5"
      strokeDasharray="312"
      strokeDashoffset={312 * (1 - draw)}
    />
    <path
      d="M 78 48 A 13.5 13.5 0 1 0 64 62 A 13.5 13.5 0 1 1 50 76"
      fill="none"
      stroke={BG}
      strokeWidth="10"
      strokeLinecap="round"
      strokeDasharray="120"
      strokeDashoffset={120 * (1 - draw)}
    />
  </svg>
);

/* ── Grain et vignette, pour que le noir ne soit pas plat ───────────────── */
export const Grain: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse at 50% 45%, rgba(185,212,192,0.07), transparent 62%)',
          pointerEvents: 'none',
        }}
      />
      <AbsoluteFill style={{ opacity: 0.055, mixBlendMode: 'screen', pointerEvents: 'none' }}>
        <svg width="100%" height="100%">
          <filter id="gr">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={f % 24} />
          </filter>
          <rect width="100%" height="100%" filter="url(#gr)" />
        </svg>
      </AbsoluteFill>
    </>
  );
};

/* ── Carton final commun aux trois films ────────────────────────────────── */
export const EndCard: React.FC<{ start: number; line: string }> = ({ start, line }) => {
  const t = useT();
  const { fps } = useVideoConfig();
  const vertical = useVertical();
  const s = spring({ frame: (t - start) * fps, fps, config: { damping: 200, mass: 1.1 } });
  const draw = lerp(t, start + 0.1, start + 0.95, 0, 1, easeOut);
  if (t < start - 0.1) return null;
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        opacity: s,
        transform: `translateY(${(1 - s) * 20}px)`,
      }}
    >
      <Mark size={vertical ? 196 : 168} draw={draw} />
      <div
        style={{
          marginTop: 34,
          fontFamily: inter,
          fontWeight: 700,
          fontSize: vertical ? 124 : 108,
          letterSpacing: '-0.045em',
          color: CREAM,
        }}
      >
        SEAL
      </div>
      <div
        style={{
          marginTop: 20,
          fontFamily: inter,
          fontWeight: 600,
          fontSize: vertical ? 48 : 44,
          letterSpacing: '-0.02em',
          color: SAGE,
          textAlign: 'center',
          maxWidth: vertical ? 880 : 1180,
          lineHeight: 1.25,
          paddingLeft: 50,
          paddingRight: 50,
        }}
      >
        {line}
      </div>
      <div
        style={{
          marginTop: vertical ? 58 : 50,
          fontFamily: mono,
          fontSize: vertical ? 28 : 25,
          letterSpacing: '0.26em',
          color: DIM,
        }}
      >
        @SEAL_ONCHAIN
      </div>
    </AbsoluteFill>
  );
};

/** Bruit déterministe, pour que chaque rendu soit identique. */
export const rnd = (seed: string) => random(seed);
