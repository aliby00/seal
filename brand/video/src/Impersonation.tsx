import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import {
  BG,
  DIM,
  EndCard,
  Grain,
  P,
  SAGE,
  Words,
  easeOut,
  inter,
  lerp,
  mono,
  useT,
  useVertical,
} from './lib';

/**
 * Film 2 — l'usurpation.
 * Six cartes, cinq portent le même nom. Aucun commentaire n'est nécessaire.
 */
const NAMES = ['ROBINHOOD', 'HOOD', 'ROBINHOOD', 'AUTRE', 'HOOD', 'ROBINHOOD'];
const FAKE = [0, 1, 2, 4, 5];

export const Impersonation: React.FC = () => {
  const t = useT();
  const { width, height } = useVideoConfig();
  const vertical = useVertical();

  const cols = vertical ? 2 : 3;
  const cw = vertical ? 450 : 432;
  const ch = vertical ? 290 : 262;
  const gap = vertical ? 34 : 42;
  const rows = Math.ceil(6 / cols);
  const ox = (width - (cols * cw + (cols - 1) * gap)) / 2;
  const oy = (height - (rows * ch + (rows - 1) * gap)) / 2 + (vertical ? 30 : 20);

  return (
    <AbsoluteFill style={{ background: BG }}>
      <Words
        parts={P('*6* marchés listés')}
        start={0.4}
        end={2.7}
        size={vertical ? 84 : 92}
        sub="SUR CETTE CHAÎNE"
      />

      {t >= 2.6 && t < 11.2 ? (
        <AbsoluteFill
          style={{ opacity: lerp(t, 2.6, 3.0, 0, 1) * (1 - lerp(t, 10.3, 11.2, 0, 1)) }}
        >
          {NAMES.map((name, i) => {
            const x = ox + (i % cols) * (cw + gap);
            const y = oy + Math.floor(i / cols) * (ch + gap);
            const appear = lerp(t, 3.0 + i * 0.22, 3.5 + i * 0.22, 0, 1, easeOut);
            const isFake = FAKE.includes(i);
            const flag = isFake
              ? lerp(t, 6.3 + FAKE.indexOf(i) * 0.3, 6.8 + FAKE.indexOf(i) * 0.3, 0, 1)
              : 0;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: x,
                  top: y,
                  width: cw,
                  height: ch,
                  borderRadius: 22,
                  background: '#0f1613',
                  border: `2px solid ${flag > 0.5 ? SAGE : 'rgba(48,77,60,0.9)'}`,
                  opacity: appear,
                  transform: `translateY(${(1 - appear) * 26}px) scale(${0.95 + 0.05 * appear})`,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  padding: vertical ? 32 : 30,
                  boxSizing: 'border-box',
                  boxShadow: flag > 0.5 ? `0 0 44px rgba(185,212,192,${0.2 * flag})` : 'none',
                }}
              >
                <div
                  style={{
                    fontFamily: inter,
                    fontWeight: 700,
                    fontSize: vertical ? 56 : 54,
                    letterSpacing: '-0.03em',
                    color: flag > 0.5 ? SAGE : 'rgba(240,243,237,0.42)',
                  }}
                >
                  {name}
                </div>
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: vertical ? 22 : 21,
                    color: DIM,
                    marginTop: 13,
                    letterSpacing: '0.1em',
                  }}
                >
                  0x{['7a1c', '4e34', 'b852', '09df', 'e5e7', '4eb1'][i]}…
                </div>
                {flag > 0.5 ? (
                  <div
                    style={{
                      marginTop: 16,
                      fontFamily: mono,
                      fontSize: vertical ? 19 : 18,
                      letterSpacing: '0.18em',
                      color: SAGE,
                      opacity: flag,
                    }}
                  >
                    USURPE LE NOM
                  </div>
                ) : null}
              </div>
            );
          })}
        </AbsoluteFill>
      ) : null}

      <Words
        parts={P('*5* sur *6* usurpent la plateforme')}
        start={8.3}
        end={10.6}
        size={vertical ? 60 : 68}
        top={vertical ? 1560 : 920}
      />
      <Words
        parts={P('Ce n’est pas un risque. C’est *l’état actuel.*')}
        start={11.0}
        end={13.4}
        size={vertical ? 64 : 74}
      />
      <EndCard start={13.7} line="On lit le code que personne ne lit." />
      <Grain />
    </AbsoluteFill>
  );
};
