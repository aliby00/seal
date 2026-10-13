import React from 'react';
import { AbsoluteFill } from 'remotion';
import data from './markets.json';
import {
  Arch,
  Beam,
  DENSE,
  EndCard,
  Grain,
  LEAD,
  ORGANIC,
  Rise,
  SCAN,
  Scanlines,
  Tag,
  Xray,
  bitOn,
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

/** Les cartes texte, en coupes franches. `dark` : fond dense, texte écran. */
const BEATS = [
  { text: `${TOTAL} markets.`, start: 0.3, end: 1.3, accent: [String(TOTAL)], dark: false },
  { text: '51 minutes.', start: 1.3, end: 2.1, accent: ['51'], dark: true },
  { text: `${TOTAL - WITH} came through empty.`, start: 2.1, end: 3.1, accent: [], dark: false },
  { text: `${WITH} carried a rulebook.`, start: 3.1, end: 4.1, accent: [String(WITH)], dark: true },
  { text: 'can you read it?', start: 4.1, end: 5.1, accent: ['read'], dark: false },
];
const MONTAGE = [5.1, 9.0] as const;
const SLOT = 0.3;
const CUTS = [...BEATS.map((b) => b.start), MONTAGE[0], MONTAGE[1]];

/**
 * Hype, 14 s. Coupes franches sur les vrais chiffres, puis les rulebooks
 * défilent sous l'arche à toute vitesse, chacun aux rayons X. Puis le nom.
 */
export const Hype: React.FC = () => {
  const t = useT();
  const v = useV();
  const H = v ? 1920 : 1080;
  const beat = BEATS.find((b) => t >= b.start && t < b.end);
  const inMontage = t >= MONTAGE[0] && t < MONTAGE[1];
  const k = Math.floor((t - MONTAGE[0]) / SLOT);
  const hook = HOOKS[((k % HOOKS.length) + HOOKS.length) % HOOKS.length];
  const slot = (t - MONTAGE[0]) / SLOT - k;
  const flash = CUTS.reduce((a, c) => Math.max(a, t >= c ? 1 - (t - c) / 0.12 : 0), 0);
  const dark = beat?.dark ?? false;

  return (
    <AbsoluteFill style={{ background: dark ? DENSE : SCAN, color: DENSE }}>
      {beat && (
        <AbsoluteFill
          style={{ alignItems: 'center', justifyContent: 'center', padding: v ? 60 : 160 }}
        >
          <Rise
            text={beat.text}
            start={beat.start}
            end={beat.end + 0.25}
            size={v ? 120 : 150}
            color={dark ? SCAN : DENSE}
            accent={beat.accent}
          />
        </AbsoluteFill>
      )}

      {inMontage && (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: v ? 'column' : 'row',
            gap: v ? 50 : 100,
          }}
        >
          <Arch size={v ? 520 : 480} mask={hook.mask} />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: v ? 'center' : 'flex-start',
              gap: 18,
            }}
          >
            <Xray mask={hook.mask} width={v ? 560 : 520} reveal={Math.min(1, slot * 2.2)} />
            <div style={{ fontFamily: mono, fontSize: v ? 30 : 28, color: DENSE }}>
              {short(hook.h, 6)}
            </div>
            <div style={{ fontFamily: mono, fontSize: v ? 24 : 22, color: LEAD }}>
              {Array.from({ length: 14 }, (_, b) => bitOn(hook.mask, b)).filter(Boolean).length}{' '}
              permissions · <span style={{ color: ORGANIC }}>×{hook.n}</span>
            </div>
          </div>
          <Beam y={lerp(slot, 0, 1, H * 0.2, H * 0.8, (x) => x)} opacity={0.7} />
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
            <Tag>
              rulebook {String((k % HOOKS.length) + 1).padStart(2, '0')} / {HOOKS.length}
            </Tag>
          </div>
        </AbsoluteFill>
      )}

      <AbsoluteFill
        style={{ alignItems: 'center', justifyContent: 'center', padding: v ? 60 : 160 }}
      >
        <Rise
          text="we x-ray it."
          start={MONTAGE[1]}
          end={10.4}
          size={v ? 150 : 190}
          accent={['x-ray']}
        />
      </AbsoluteFill>

      <AbsoluteFill style={{ background: '#fff', opacity: flash * 0.55, pointerEvents: 'none' }} />
      <Scanlines />
      <Grain />
      <EndCard start={10.4} line="robinhood chain · soon" />
    </AbsoluteFill>
  );
};
