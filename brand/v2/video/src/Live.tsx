import React from 'react';
import { AbsoluteFill } from 'remotion';
import data from './markets.json';
import {
  ASH,
  BONE,
  EndCard,
  Grain,
  INK,
  LINE,
  Label,
  Vignette,
  WAX,
  Wax,
  easeOut,
  lerp,
  maskLobes,
  mono,
  short,
  useT,
  useV,
} from './lib2';

type Row = { b: number; t: string; h: string; mask: number; n: string | null; s: string | null };
/** Le plus récent en haut : on remonte les 51 minutes jusqu'à HOOD. */
const ROWS = [...(data.rows as Row[])].reverse();
const HOOD = ROWS.findIndex((r) => r.n === 'HOOD');
const NO_HOOK = '0x0000000000000000000000000000000000000000';

/**
 * « Live », 17 s. Le flux réel des marchés v4 relevés le 11/10/2026, chacun
 * avec le sceau de son rulebook. Le flux ralentit et s'arrête sur « HOOD » ;
 * deux spécialistes rendent ce qu'ils ont lu. Tous les faits sont vérifiés.
 */
export const Live: React.FC = () => {
  const t = useT();
  const v = useV();
  const rowH = v ? 76 : 66;
  const visible = v ? 15 : 12;

  // Position dans le flux : rapide, puis freinage jusqu'à poser HOOD au centre.
  const STOP = 8.2;
  const startIdx = 0;
  const pos = lerp(
    t,
    0.4,
    STOP,
    startIdx,
    HOOD - Math.floor(visible / 2),
    (x) => 1 - Math.pow(1 - x, 3),
  );
  const first = Math.floor(pos);
  const frac = pos - first;
  const seen = ROWS.slice(0, Math.min(ROWS.length, Math.floor(pos) + visible));
  const read = seen.length;
  const hooked = seen.filter((r) => r.h !== NO_HOOK).length;

  const focus = lerp(t, STOP, STOP + 0.5, 0, 1, easeOut);
  const panel = lerp(t, STOP + 0.4, STOP + 1.0, 0, 1, easeOut);
  const out = lerp(t, 14.6, 15.0, 0, 1);

  const W = v ? 1080 : 1920;
  const listW = v ? 1000 : 1060;

  return (
    <AbsoluteFill style={{ background: INK, fontFamily: mono, color: BONE }}>
      {/* Barre de statut */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: v ? 92 : 64,
          borderBottom: `1px solid ${LINE}`,
          display: 'flex',
          alignItems: 'center',
          gap: v ? 24 : 36,
          padding: v ? '0 40px' : '0 48px',
          fontSize: v ? 24 : 24,
          opacity: 1 - out,
        }}
      >
        <Wax size={v ? 40 : 34} lobes={Array(14).fill(1)} />
        <span style={{ color: WAX }}>● live</span>
        <span style={{ color: ASH }}>robinhood chain</span>
        {!v && (
          <span style={{ color: ASH }}>
            poolmanager {short('0x8366a39cc670b4001a1121b8f6a443a643e40951')}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <span style={{ color: ASH }}>markets </span>
          {read}
          <span style={{ color: ASH }}>{v ? ' · rulebooks ' : '   with a rulebook '}</span>
          {hooked}
        </span>
      </div>

      {/* Flux */}
      <div
        style={{
          position: 'absolute',
          top: v ? 180 : 130,
          left: v ? (W - listW) / 2 : 70,
          width: listW,
          height: rowH * visible,
          overflow: 'hidden',
          opacity: 1 - out,
          maskImage: 'linear-gradient(transparent, black 12%, black 88%, transparent)',
        }}
      >
        {Array.from({ length: visible + 1 }, (_, k) => {
          const idx = first + k;
          const r = ROWS[idx];
          if (!r) return null;
          const isHood = idx === HOOD;
          const hooked = r.h !== NO_HOOK;
          const dim = focus * (isHood ? 0 : 0.75);
          return (
            <div
              key={idx}
              style={{
                position: 'absolute',
                top: (k - frac) * rowH,
                left: 0,
                right: 0,
                height: rowH,
                display: 'flex',
                alignItems: 'center',
                gap: v ? 18 : 26,
                fontSize: v ? 30 : 27,
                opacity: 1 - dim,
                background: isHood ? `rgba(229,67,42,${0.12 * focus})` : 'transparent',
                borderLeft: isHood ? `3px solid rgba(229,67,42,${focus})` : '3px solid transparent',
                paddingLeft: 14,
              }}
            >
              {!v && <span style={{ color: ASH, width: 190 }}>{r.b.toLocaleString('en-US')}</span>}
              <span style={{ width: v ? 44 : 40, display: 'flex' }}>
                {hooked ? (
                  <Wax
                    size={v ? 50 : 46}
                    lobes={maskLobes(r.mask)}
                    ring={0}
                    mono={0}
                    depth={9}
                    offAmp={0}
                  />
                ) : (
                  <span style={{ color: 'rgba(238,235,227,0.22)', fontSize: 30, lineHeight: 1 }}>
                    ○
                  </span>
                )}
              </span>
              <span
                style={{
                  width: v ? 400 : 380,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}
              >
                {r.n ?? '(unreadable)'}
              </span>
              <span style={{ color: hooked ? BONE : 'rgba(238,235,227,0.3)' }}>
                {hooked ? `rulebook ${short(r.h)}` : 'no rulebook'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Ce que les spécialistes ont lu sur HOOD */}
      {panel > 0 && (
        <div
          style={{
            position: 'absolute',
            ...(v
              ? { left: 40, right: 40, bottom: 150, top: undefined }
              : { right: 70, top: 130, width: 700 }),
            opacity: panel * (1 - out),
            transform: `translateY(${(1 - panel) * 30}px)`,
            display: 'flex',
            flexDirection: 'column',
            gap: v ? 26 : 22,
          }}
        >
          <Label>token {short(ROWS[HOOD]!.t)}</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <Wax size={v ? 120 : 110} lobes={maskLobes(ROWS[HOOD]!.mask)} depth={9} offAmp={0} />
            <div>
              <div style={{ fontSize: v ? 56 : 50, fontWeight: 700 }}>"HOOD"</div>
              <div style={{ color: ASH, fontSize: v ? 22 : 19 }}>
                rulebook {short(ROWS[HOOD]!.h)} · mask 0x{ROWS[HOOD]!.mask.toString(16)}
              </div>
            </div>
          </div>
          <Finding
            start={STOP + 1.1}
            title="name clone"
            text={'uses "hood". not part of the issued\nrobinhood token family.'}
          />
          <Finding
            start={STOP + 2.6}
            title="rule change"
            text={
              'the rulebook is an upgradeable proxy.\nit can be rewritten without changing address.'
            }
          />
          <Finding
            start={STOP + 4.2}
            title="sell path"
            text={
              'the rulebook may change the amount of a trade.\nwhat it does with that is not in its permissions.'
            }
            quiet
          />
        </div>
      )}

      <Vignette />
      <Grain />
      <EndCard start={15.0} line="reads every market · soon" />
    </AbsoluteFill>
  );
};

const Finding: React.FC<{ start: number; title: string; text: string; quiet?: boolean }> = ({
  start,
  title,
  text,
  quiet,
}) => {
  const t = useT();
  const v = useV();
  if (t < start) return null;
  const p = lerp(t, start, start + 0.4, 0, 1, easeOut);
  const chars = Math.floor((t - start - 0.25) * 70);
  return (
    <div
      style={{
        borderTop: `1px solid ${LINE}`,
        paddingTop: v ? 20 : 16,
        opacity: p,
      }}
    >
      <div
        style={{
          fontSize: v ? 22 : 20,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: quiet ? ASH : WAX,
          marginBottom: 8,
        }}
      >
        {quiet ? '◦' : '●'} {title}
      </div>
      <div style={{ fontSize: v ? 30 : 27, lineHeight: 1.35, whiteSpace: 'pre-wrap' }}>
        {text.slice(0, Math.max(0, chars))}
      </div>
    </div>
  );
};
