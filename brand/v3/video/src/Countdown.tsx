import React from 'react';
import { AbsoluteFill } from 'remotion';
import {
  Arch,
  Beam,
  DENSE,
  EndCard,
  Grain,
  LEAD,
  ORGANIC,
  SCAN,
  Scanlines,
  Tag,
  display,
  easeOut,
  lerp,
  mono,
  useT,
  useV,
} from './lib3';

/** Le rideau s'ouvre du centre vers les bords : à J-7 il est fermé, au jour J il est ouvert. */
const ORDER = Array.from({ length: 14 }, (_, i) => i).sort(
  (a, b) => Math.abs(a - 6.5) - Math.abs(b - 6.5) || a - b,
);
const opened = (days: number) => Math.round(14 * (1 - Math.min(7, Math.max(0, days)) / 7));

/**
 * Compte à rebours, 7,5 s. Le chiffre défile et se fige, le faisceau passe,
 * et le rideau de l'arche s'écarte d'autant de lanières qu'il reste de jours.
 */
export const Countdown: React.FC<{ days: number }> = ({ days }) => {
  const t = useT();
  const v = useV();
  const H = v ? 1920 : 1080;
  const roll = lerp(t, 0.5, 2.3, days + 9, days, easeOut);
  const n = Math.round(roll);
  const tick = 1 - Math.abs(roll - n) * 2;
  const locked = t > 2.3;
  const before = opened(days + 2);
  const after = opened(days);
  const part = lerp(t, 3.0, 4.2, 0, 1, easeOut);
  const drop = Array.from({ length: 14 }, (_, i) => {
    const rank = ORDER.indexOf(i);
    if (rank < before) return 0.12;
    if (rank < after) return 1 - part * 0.88;
    return lerp(t, 0.2 + i * 0.03, 0.6 + i * 0.03, 0, 1, easeOut);
  });
  const beamY = lerp(t, 2.3, 3.0, H * 0.15, H * 0.85);
  const live = days <= 0;

  return (
    <AbsoluteFill style={{ background: SCAN, color: DENSE }}>
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: v ? 'column' : 'row',
          gap: v ? 40 : 110,
        }}
      >
        <Arch size={v ? 560 : 560} drop={drop} frame={lerp(t, 0.05, 0.6, 0, 1)} />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: v ? 'center' : 'flex-start',
            minWidth: v ? undefined : 560,
          }}
        >
          <div
            style={{
              fontFamily: display,
              fontWeight: 800,
              fontSize: live && locked ? (v ? 230 : 220) : v ? 400 : 380,
              letterSpacing: '-0.04em',
              lineHeight: 0.9,
              color: locked ? ORGANIC : DENSE,
              fontVariantNumeric: 'tabular-nums',
              transform: `translateY(${locked ? 0 : (1 - tick) * -18}px)`,
              opacity: lerp(t, 0.3, 0.6, 0, 1),
            }}
          >
            {live && locked ? 'today.' : n}
          </div>
          <div
            style={{
              fontFamily: display,
              fontWeight: 800,
              fontSize: v ? 84 : 80,
              letterSpacing: '-0.03em',
              marginTop: 10,
              opacity: live ? 0 : lerp(t, 0.6, 1.0, 0, 1),
            }}
          >
            {n === 1 ? 'day' : 'days'}
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: v ? 34 : 32,
              color: LEAD,
              marginTop: 26,
              opacity: lerp(t, 3.2, 3.7, 0, 1, easeOut),
            }}
          >
            {live ? 'the scanner is open.' : 'until the scanner opens.'}
          </div>
        </div>
      </AbsoluteFill>

      {t > 2.3 && t < 3.1 && <Beam y={beamY} opacity={lerp(t, 2.8, 3.1, 1, 0)} />}

      <div
        style={{
          position: 'absolute',
          top: v ? 90 : 50,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <Tag style={{ opacity: lerp(t, 0.2, 0.6, 0, 1) }}>
          {live ? 'launch · robinhood chain' : `t-minus ${days} · robinhood chain`}
        </Tag>
      </div>
      <Scanlines />
      <Grain />
      <EndCard
        start={5.2}
        line={
          live ? 'every market, x-rayed · live now' : 'every market has a rulebook. we x-ray it.'
        }
      />
    </AbsoluteFill>
  );
};
