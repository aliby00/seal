import React from 'react';
import { AbsoluteFill, random } from 'remotion';
import {
  ASH,
  BONE,
  Grain,
  Grid,
  INK,
  Label,
  Vignette,
  WAX,
  Wax,
  Wordmark,
  back,
  easeOut,
  lerp,
  mono,
  useT,
  useV,
} from './lib2';

/** Les 14 permissions, dans l'ordre où le sceau les lit : bit 13 en haut, sens horaire. */
const FLAGS = [
  'beforeInitialize',
  'afterInitialize',
  'beforeAddLiquidity',
  'afterAddLiquidity',
  'beforeRemoveLiquidity',
  'afterRemoveLiquidity',
  'beforeSwap',
  'afterSwap',
  'beforeDonate',
  'afterDonate',
  'beforeSwapReturnsDelta',
  'afterSwapReturnsDelta',
  'afterAddLiquidityReturnsDelta',
  'afterRemoveLiquidityReturnsDelta',
];

/**
 * Révélation du logo, 9 s. Chaque lobe apparaît avec le nom de la permission
 * qu'il représente, puis la cire s'écrase, puis le nom se trace.
 */
export const Reveal: React.FC = () => {
  const t = useT();
  const v = useV();
  const T0 = 0.5,
    STEP = 0.16;
  const lobes = FLAGS.map((_, i) => lerp(t, T0 + i * STEP, T0 + i * STEP + 0.35, 0, 1, back));
  const current = Math.min(13, Math.max(0, Math.floor((t - T0) / STEP)));
  const stampAt = T0 + 14 * STEP + 0.25; // ≈ 3,0 s
  const body = lerp(t, stampAt, stampAt + 0.28, 0, 1, back);
  const shake =
    t > stampAt + 0.18 && t < stampAt + 0.42 ? (random(Math.floor(t * 60)) - 0.5) * 14 : 0;
  const lock = lerp(t, 4.4, 5.2, 0, 1);
  const size = v ? 420 : 380;

  return (
    <AbsoluteFill style={{ background: INK }}>
      <Grid opacity={lerp(t, 0, 1, 0, 0.8)} />
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          transform: `translate(${shake}px, ${shake * 0.5}px)`,
          flexDirection: v ? 'column' : 'row',
          gap: lerp(t, 4.4, 5.2, 0, v ? 70 : 90),
        }}
      >
        <div
          style={{
            position: 'relative',
            transform: `scale(${1 - lock * (v ? 0.25 : 0.3)})`,
          }}
        >
          {/* Avant l'empreinte : les lobes seuls, en contour. */}
          <svg
            width={size}
            height={size}
            viewBox="0 0 100 100"
            style={{ position: 'absolute', opacity: 1 - body }}
          >
            {lobes.map((p, i) => {
              const a = -Math.PI / 2 + (i * 2 * Math.PI) / 14;
              const r = 44;
              return (
                <circle
                  key={i}
                  cx={50 + r * Math.cos(a)}
                  cy={50 + r * Math.sin(a)}
                  r={5.6 * p}
                  fill={i === current && t < stampAt ? WAX : 'none'}
                  stroke={WAX}
                  strokeWidth={0.8}
                />
              );
            })}
          </svg>
          <Wax
            size={size}
            lobes={lobes}
            body={body}
            ring={lerp(t, stampAt + 0.3, stampAt + 0.8, 0, 1)}
            mono={lerp(t, stampAt + 0.45, stampAt + 1.0, 0, 1)}
          />
        </div>
        {lock > 0 && (
          <div style={{ opacity: lock, width: lock * (v ? 640 : 760), overflow: 'visible' }}>
            <Wordmark width={v ? 640 : 760} progress={lerp(t, 4.6, 5.8, 0, 1)} />
          </div>
        )}
      </AbsoluteFill>

      {/* Nom de la permission en cours, sous le sceau. */}
      {t > T0 && t < stampAt && (
        <AbsoluteFill
          style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: v ? 420 : 150 }}
        >
          <Label style={{ fontSize: v ? 22 : 20 }}>bit {13 - current}</Label>
          <div style={{ fontFamily: mono, fontSize: v ? 40 : 36, color: BONE, marginTop: 10 }}>
            {FLAGS[current]}
          </div>
        </AbsoluteFill>
      )}

      {t > stampAt + 0.2 && t < 4.3 && (
        <AbsoluteFill
          style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: v ? 420 : 150 }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: v ? 40 : 38,
              color: BONE,
              opacity: lerp(t, stampAt + 0.2, stampAt + 0.6, 0, 1),
            }}
          >
            14 permissions. one rulebook.
          </div>
        </AbsoluteFill>
      )}

      {t > 6.0 && (
        <AbsoluteFill
          style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: v ? 380 : 140 }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: v ? 40 : 38,
              color: BONE,
              opacity: lerp(t, 6.0, 6.5, 0, 1, easeOut),
              letterSpacing: '0.02em',
            }}
          >
            every market has a rulebook. <span style={{ color: WAX }}>we read it.</span>
          </div>
        </AbsoluteFill>
      )}

      <Vignette />
      <Grain />
    </AbsoluteFill>
  );
};
