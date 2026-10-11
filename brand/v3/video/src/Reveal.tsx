import React from 'react';
import { AbsoluteFill } from 'remotion';
import {
  Arch,
  Beam,
  DENSE,
  Grain,
  LEAD,
  METAL,
  ORGANIC,
  SCAN,
  Scanlines,
  Tag,
  Wordmark,
  easeOut,
  lerp,
  mono,
  useT,
  useV,
} from './lib3';

/** Les 14 permissions, dans l'ordre du rideau : bit 13 à gauche. */
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
 * Révélation, 8 s. L'arche se trace, les 14 lanières tombent une par une avec
 * le nom de la permission qu'elles portent, le faisceau balaie, le nom s'assemble.
 */
export const Reveal: React.FC = () => {
  const t = useT();
  const v = useV();
  const T0 = 1.0,
    STEP = 0.15;
  const drop = FLAGS.map((_, i) => lerp(t, T0 + i * STEP, T0 + i * STEP + 0.4, 0, 1, easeOut));
  const current = Math.min(13, Math.max(0, Math.floor((t - T0) / STEP)));
  const scanAt = T0 + 14 * STEP + 0.3; // ≈ 3,4 s
  const lock = lerp(t, 4.3, 5.0, 0, 1);
  const size = v ? 440 : 400;
  const H = v ? 1920 : 1080;
  const beamY = lerp(t, scanAt, scanAt + 0.8, H * 0.18, H * 0.82);

  return (
    <AbsoluteFill style={{ background: SCAN }}>
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: v ? 'column' : 'row',
          gap: lock * (v ? 70 : 80),
        }}
      >
        <div
          style={{
            transform: `scale(${1 - lock * (v ? 0.28 : 0.35)})`,
            margin: lock * (v ? -50 : -60),
          }}
        >
          <Arch size={size} drop={drop} frame={lerp(t, 0.2, 1.0, 0, 1)} />
        </div>
        {lock > 0 && (
          <div style={{ width: lock * (v ? 620 : 720) }}>
            <Wordmark
              width={v ? 620 : 720}
              progress={lerp(t, 4.5, 5.6, 0, 1, (x) => x)}
              archColor={METAL}
            />
          </div>
        )}
      </AbsoluteFill>

      {t > scanAt && t < scanAt + 0.9 && (
        <Beam y={beamY} opacity={lerp(t, scanAt + 0.6, scanAt + 0.9, 1, 0)} />
      )}

      {t > T0 && t < scanAt && (
        <AbsoluteFill
          style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: v ? 400 : 120 }}
        >
          <Tag>bit {13 - current}</Tag>
          <div style={{ fontFamily: mono, fontSize: v ? 38 : 34, color: DENSE, marginTop: 10 }}>
            {FLAGS[current]}
          </div>
        </AbsoluteFill>
      )}
      {t >= scanAt && t < 4.2 && (
        <AbsoluteFill
          style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: v ? 400 : 120 }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: v ? 38 : 34,
              color: DENSE,
              opacity: lerp(t, scanAt, scanAt + 0.3, 0, 1),
            }}
          >
            14 permissions. one rulebook.
          </div>
        </AbsoluteFill>
      )}
      {t > 6.0 && (
        <AbsoluteFill
          style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: v ? 380 : 120 }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: v ? 36 : 34,
              color: DENSE,
              opacity: lerp(t, 6.0, 6.4, 0, 1, easeOut),
            }}
          >
            every market has a rulebook. <span style={{ color: ORGANIC }}>we x-ray it.</span>
          </div>
        </AbsoluteFill>
      )}
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
        <Tag color={LEAD} style={{ opacity: lerp(t, 0.2, 0.6, 0, 1) }}>
          robinhood chain · uniswap v4
        </Tag>
      </div>
      <Scanlines />
      <Grain />
    </AbsoluteFill>
  );
};
