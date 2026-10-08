import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import {
  BG,
  Counter,
  DIM,
  EndCard,
  Grain,
  MID,
  P,
  SAGE,
  Words,
  easeOut,
  lerp,
  mono,
  rnd,
  useT,
  useVertical,
} from './lib';

/**
 * Film 1 — la réutilisation de code.
 * Le chiffre est le sujet : 97 marchés en 50 minutes, 28 sur le même rulebook.
 * La grille se remplit, puis 28 cases se relient à un seul nœud. Rien d'autre.
 */
const TOTAL_MK = 97;
/** Les 28 « mêmes » : tirage déterministe, donc le rendu ne bouge jamais. */
const SAME = new Set(
  Array.from({ length: TOTAL_MK }, (_, i) => i)
    .sort((a, b) => rnd(`s${a}`) - rnd(`s${b}`))
    .slice(0, 28),
);

export const Reuse: React.FC = () => {
  const t = useT();
  const { width, height } = useVideoConfig();
  const vertical = useVertical();

  const cols = vertical ? 8 : 14;
  const rows = Math.ceil(TOTAL_MK / cols);
  const cell = vertical ? 76 : 76;
  const gap = vertical ? 14 : 15;
  const gw = cols * cell + (cols - 1) * gap;
  const gh = rows * cell + (rows - 1) * gap;
  const ox = (width - gw) / 2;
  const oy = vertical ? 330 : 248;
  const hub = { x: width / 2, y: oy + gh / 2 };

  const pos = (i: number) => ({
    x: ox + (i % cols) * (cell + gap),
    y: oy + Math.floor(i / cols) * (cell + gap),
  });

  // Repères : remplissage 3.0→6.4, marquage 7.0→9.0, liens 8.0→10.2, effacement 11.0→12.2
  const fade = lerp(t, 11.0, 12.2, 0, 1);

  return (
    <AbsoluteFill style={{ background: BG }}>
      <Words
        parts={P('*97* marchés créés')}
        start={0.4}
        end={2.9}
        size={vertical ? 84 : 92}
        sub="EN 50 MINUTES"
      />

      {t >= 2.7 && t < 13.4 ? (
        <AbsoluteFill style={{ opacity: lerp(t, 2.7, 3.1, 0, 1) }}>
          <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
            {/* Les liens vers le nœud central : seulement pour les 28. */}
            {Array.from({ length: TOTAL_MK }, (_, i) => {
              if (!SAME.has(i)) return null;
              const p = pos(i);
              const k = lerp(t, 8.0 + rnd(`l${i}`) * 1.4, 9.6 + rnd(`l${i}`) * 1.4, 0, 1, easeOut);
              if (k <= 0) return null;
              const x0 = p.x + cell / 2,
                y0 = p.y + cell / 2;
              return (
                <line
                  key={`l${i}`}
                  x1={x0}
                  y1={y0}
                  x2={x0 + (hub.x - x0) * k}
                  y2={y0 + (hub.y - y0) * k}
                  stroke={SAGE}
                  strokeWidth={1.6}
                  opacity={0.5 * (1 - fade)}
                />
              );
            })}
            {/* Les 97 cases. */}
            {Array.from({ length: TOTAL_MK }, (_, i) => {
              const p = pos(i);
              const appear = lerp(t, 3.0 + i * 0.035, 3.3 + i * 0.035, 0, 1, easeOut);
              if (appear <= 0) return null;
              const same = SAME.has(i);
              const mark = same
                ? lerp(t, 7.0 + rnd(`m${i}`) * 1.2, 7.5 + rnd(`m${i}`) * 1.2, 0, 1)
                : 0;
              const dim = same ? 0 : fade;
              return (
                <rect
                  key={i}
                  x={p.x}
                  y={p.y}
                  width={cell}
                  height={cell}
                  rx={cell * 0.22}
                  fill={same ? SAGE : MID}
                  opacity={appear * (same ? 0.3 + 0.7 * mark : 0.5) * (1 - dim)}
                  transform={`translate(${p.x + cell / 2} ${p.y + cell / 2}) scale(${0.6 + 0.4 * appear}) translate(${-p.x - cell / 2} ${-p.y - cell / 2})`}
                />
              );
            })}
            {/* Le nœud : le rulebook unique derrière les 28. */}
            {t > 9.2 ? (
              <g opacity={lerp(t, 9.2, 9.9, 0, 1)}>
                <circle
                  cx={hub.x}
                  cy={hub.y}
                  r={vertical ? 54 : 46}
                  fill={BG}
                  stroke={SAGE}
                  strokeWidth={3}
                />
                <text
                  x={hub.x}
                  y={hub.y + 7}
                  textAnchor="middle"
                  style={{
                    fontFamily: mono,
                    fontSize: vertical ? 21 : 18,
                    fill: SAGE,
                    letterSpacing: '0.04em',
                  }}
                >
                  0x4e34
                </text>
              </g>
            ) : null}
          </svg>

          {/* Compteurs */}
          <div
            style={{
              position: 'absolute',
              top: vertical ? 142 : 78,
              left: 0,
              right: 0,
              display: 'flex',
              justifyContent: 'center',
              gap: vertical ? 70 : 90,
              alignItems: 'baseline',
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <Counter to={97} start={3.0} dur={3.4} size={vertical ? 92 : 84} />
              <div
                style={{
                  fontFamily: mono,
                  fontSize: vertical ? 22 : 20,
                  letterSpacing: '0.2em',
                  color: DIM,
                  marginTop: 8,
                }}
              >
                MARCHÉS
              </div>
            </div>
            {t > 6.9 ? (
              <div style={{ textAlign: 'center', opacity: lerp(t, 6.9, 7.4, 0, 1) }}>
                <Counter to={28} start={7.0} dur={1.9} size={vertical ? 92 : 84} color={SAGE} />
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: vertical ? 22 : 20,
                    letterSpacing: '0.2em',
                    color: DIM,
                    marginTop: 8,
                  }}
                >
                  MÊME CODE
                </div>
              </div>
            ) : null}
          </div>
        </AbsoluteFill>
      ) : null}

      <Words
        parts={P('*28* tournent sur le même code')}
        start={9.9}
        end={12.3}
        size={vertical ? 64 : 72}
        top={vertical ? 1566 : 928}
      />
      <Words parts={P('Un seul *acteur.*')} start={12.6} end={14.6} size={vertical ? 86 : 94} />
      <EndCard start={14.9} line="Le portefeuille change. Le code, non." />
      <Grain />
    </AbsoluteFill>
  );
};
