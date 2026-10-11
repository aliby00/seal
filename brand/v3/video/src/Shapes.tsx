import React from 'react';
import { AbsoluteFill } from 'remotion';
import data from './markets.json';
import {
  DENSE,
  EndCard,
  Grain,
  LEAD,
  ORGANIC,
  Rise,
  SCAN,
  Scanlines,
  Xray,
  easeOut,
  lerp,
  mono,
  short,
  useT,
  useV,
} from './lib3';

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
 * « Shapes », 16 s. Les chiffres réels, puis l'image aux rayons X de chacun
 * des rulebooks observés : chacun laisse une image différente.
 */
export const Shapes: React.FC = () => {
  const t = useT();
  const v = useV();
  const cols = v ? 3 : 5;
  const cell = v ? 300 : 300;
  const gridIn = 6.6;

  return (
    <AbsoluteFill style={{ background: SCAN, color: DENSE }}>
      <AbsoluteFill
        style={{ alignItems: 'center', justifyContent: 'center', padding: v ? 60 : 160 }}
      >
        <Rise
          text={`${TOTAL} markets in 51 minutes.`}
          start={0.3}
          end={2.3}
          size={v ? 96 : 112}
          accent={[String(TOTAL)]}
        />
      </AbsoluteFill>
      <AbsoluteFill
        style={{ alignItems: 'center', justifyContent: 'center', padding: v ? 60 : 160 }}
      >
        <Rise
          text={`${TOTAL - WITH} came through empty.`}
          start={2.4}
          end={4.3}
          size={v ? 96 : 112}
          color={LEAD}
        />
      </AbsoluteFill>
      <AbsoluteFill
        style={{ alignItems: 'center', justifyContent: 'center', padding: v ? 60 : 160 }}
      >
        <Rise
          text={`${WITH} carried a rulebook. ${HOOKS.length} different ones.`}
          start={4.4}
          end={6.4}
          size={v ? 88 : 104}
          accent={[String(WITH)]}
        />
      </AbsoluteFill>

      {t > gridIn - 0.1 && t < 13.4 && (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: v ? 50 : 36,
            opacity: lerp(t, 12.9, 13.4, 1, 0),
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
              gap: v ? '18px 6px' : '6px 20px',
            }}
          >
            {HOOKS.map((h, i) => {
              const s = gridIn + i * 0.13;
              const p = lerp(t, s, s + 0.4, 0, 1, easeOut);
              return (
                <div
                  key={h.h}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    opacity: p,
                    transform: `translateY(${(1 - p) * 20}px)`,
                  }}
                >
                  <Xray
                    mask={h.mask}
                    width={cell * 0.78}
                    reveal={lerp(t, s + 0.2, s + 0.9, 0, 1)}
                  />
                  <div style={{ fontFamily: mono, fontSize: v ? 20 : 18, color: LEAD }}>
                    {short(h.h)} <span style={{ color: h.n > 1 ? ORGANIC : LEAD }}>×{h.n}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: v ? 30 : 30,
              textAlign: 'center',
              opacity: lerp(t, 9.8, 10.3, 0, 1, easeOut),
              padding: '0 40px',
              lineHeight: 1.4,
            }}
          >
            each rulebook leaves a different image.{' '}
            <span style={{ color: ORGANIC }}>it's written in its address.</span>
          </div>
        </AbsoluteFill>
      )}
      <Scanlines />
      <Grain />
      <EndCard start={13.4} line="every rulebook, x-rayed · soon" />
    </AbsoluteFill>
  );
};
