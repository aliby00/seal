import React from 'react';
import { AbsoluteFill } from 'remotion';
import data from './markets.json';
import {
  ASH,
  BONE,
  EndCard,
  Grain,
  Grid,
  INK,
  Rise,
  Vignette,
  WAX,
  Wax,
  back,
  easeOut,
  lerp,
  maskLobes,
  mono,
  short,
  useT,
  useV,
} from './lib2';

type Row = { h: string; mask: number };
const NO_HOOK = '0x0000000000000000000000000000000000000000';
const HOOKS = (() => {
  const m = new Map<string, { h: string; mask: number; n: number }>();
  for (const r of data.rows as Row[]) {
    if (r.h === NO_HOOK) continue;
    const e = m.get(r.h) ?? { h: r.h, mask: r.mask, n: 0 };
    e.n += 1;
    m.set(r.h, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
})();
const TOTAL = data.count;
const WITH = (data.rows as Row[]).filter((r) => r.h !== NO_HOOK).length;

/**
 * « Shapes », 15 s. Les chiffres réels de la fenêtre, puis chaque rulebook
 * observé avec le sceau que dessinent ses permissions.
 */
export const Shapes: React.FC = () => {
  const t = useT();
  const v = useV();
  const cols = v ? 3 : 7;
  const cell = v ? 320 : 250;
  const gridIn = 6.6;

  return (
    <AbsoluteFill style={{ background: INK, color: BONE }}>
      <Grid opacity={0.6} />

      <AbsoluteFill
        style={{ alignItems: 'center', justifyContent: 'center', padding: v ? 70 : 160 }}
      >
        <Rise
          text={`${TOTAL} markets in 51 minutes.`}
          start={0.3}
          end={2.3}
          size={v ? 92 : 104}
          accent={[String(TOTAL)]}
        />
      </AbsoluteFill>
      <AbsoluteFill
        style={{ alignItems: 'center', justifyContent: 'center', padding: v ? 70 : 160 }}
      >
        <Rise
          text={`${TOTAL - WITH} had no rulebook.`}
          start={2.4}
          end={4.3}
          size={v ? 92 : 104}
          color={ASH}
        />
      </AbsoluteFill>
      <AbsoluteFill
        style={{ alignItems: 'center', justifyContent: 'center', padding: v ? 70 : 160 }}
      >
        <Rise
          text={`${WITH} did. ${HOOKS.length} rulebooks.`}
          start={4.4}
          end={6.4}
          size={v ? 92 : 104}
          accent={[String(WITH)]}
        />
      </AbsoluteFill>

      {t > gridIn - 0.1 && t < 13.3 && (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: v ? 60 : 44,
            opacity: lerp(t, 12.8, 13.3, 1, 0),
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
              rowGap: v ? 20 : 10,
            }}
          >
            {HOOKS.map((h, i) => {
              const s = gridIn + i * 0.14;
              const lobes = maskLobes(h.mask).map(
                (on, k) => on * lerp(t, s + 0.2 + k * 0.03, s + 0.6 + k * 0.03, 0, 1, back),
              );
              const p = lerp(t, s, s + 0.45, 0, 1, back);
              return (
                <div
                  key={h.h}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
                >
                  <Wax
                    size={cell * 0.7}
                    lobes={lobes}
                    body={p}
                    depth={10}
                    offAmp={0}
                    ring={lerp(t, s + 0.3, s + 0.8, 0, 1)}
                    mono={lerp(t, s + 0.4, s + 0.9, 0, 1)}
                  />
                  <div style={{ fontFamily: mono, fontSize: v ? 24 : 21, color: ASH, opacity: p }}>
                    {short(h.h)} <span style={{ color: h.n > 1 ? WAX : ASH }}>×{h.n}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: v ? 32 : 30,
              textAlign: 'center',
              opacity: lerp(t, 9.6, 10.1, 0, 1, easeOut),
              lineHeight: 1.4,
              padding: '0 40px',
            }}
          >
            each rulebook has a shape.{' '}
            <span style={{ color: WAX }}>it's written in its address.</span>
          </div>
        </AbsoluteFill>
      )}

      <Vignette />
      <Grain />
      <EndCard start={13.3} line="every rulebook, read · soon" />
    </AbsoluteFill>
  );
};
