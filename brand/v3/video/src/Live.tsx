import React from 'react';
import { AbsoluteFill } from 'remotion';
import data from './markets.json';
import {
  Arch,
  DENSE,
  EndCard,
  Grain,
  LEAD,
  METAL,
  ORGANIC,
  RULE,
  SCAN,
  SCAN_DEEP,
  Scanlines,
  Tag,
  Xray,
  display,
  easeOut,
  lerp,
  mono,
  short,
  useT,
  useV,
} from './lib3';

type Row = { b: number; t: string; h: string; mask: number; n: string | null; s: string | null };
/** Le plus récent d'abord : le tapis remonte les 51 minutes jusqu'à HOOD. */
const ROWS = [...(data.rows as Row[])].reverse();
const HOOD = ROWS.findIndex((r) => r.n === 'HOOD');
const NO_HOOK = '0x0000000000000000000000000000000000000000';

/**
 * « Live », 18 s. Les vrais marchés passent sur le tapis ; sous l'arche, on
 * les voit aux rayons X. Le tapis s'arrête sur « HOOD » et trois spécialistes
 * disent ce qu'ils lisent. Tout est vérifié sur la chaîne.
 */
export const Live: React.FC = () => {
  const t = useT();
  const v = useV();
  const W = v ? 1080 : 1920;
  const bag = v ? 330 : 250;
  const pitch = bag + (v ? 70 : 90);
  const beltY = v ? 330 : 190;
  const archSize = v ? 600 : 450;
  const win = bag + 40; // fenêtre du scanner

  const STOP = 8.0;
  const pos = lerp(t, 0.3, STOP, 0, HOOD, (x) => 1 - Math.pow(1 - x, 3.2));
  const center = W / 2;
  const first = Math.max(0, Math.floor(pos - W / pitch / 2 - 1));
  const last = Math.min(ROWS.length - 1, Math.ceil(pos + W / pitch / 2 + 1));
  const atCenter = ROWS[Math.round(pos)];
  const seen = Math.min(ROWS.length, Math.round(pos) + 1);
  const withRule = ROWS.slice(0, seen).filter((r) => r.h !== NO_HOOK).length;

  const halt = lerp(t, STOP, STOP + 0.4, 0, 1, easeOut);
  const out = lerp(t, 15.4, 15.8, 0, 1);
  const bagsY = beltY + archSize * 0.42;

  const bagAt = (i: number) => center + (i - pos) * -pitch - bag / 2; // les plus anciens arrivent par la gauche
  const bags = [];
  for (let i = first; i <= last; i++) bags.push(i);

  return (
    <AbsoluteFill style={{ background: SCAN, color: DENSE }}>
      {/* Barre d'état */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: v ? 90 : 70,
          borderBottom: `1.5px solid ${RULE}`,
          display: 'flex',
          alignItems: 'center',
          gap: 28,
          padding: v ? '0 40px' : '0 56px',
          fontFamily: mono,
          fontSize: v ? 20 : 19,
          opacity: 1 - out,
        }}
      >
        <Arch size={v ? 44 : 40} strips={5} />
        <span style={{ color: ORGANIC }}>● screening</span>
        {!v && (
          <span style={{ color: LEAD }}>
            robinhood chain · poolmanager {short('0x8366a39cc670b4001a1121b8f6a443a643e40951')}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <span style={{ color: LEAD }}>markets </span>
          {seen}
          <span style={{ color: LEAD }}> · with a rulebook </span>
          {withRule}
        </span>
      </div>

      <div style={{ position: 'absolute', inset: 0, opacity: 1 - out }}>
        {/* Tapis */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: bagsY + bag * 0.72 + 6,
            height: 18,
            background: SCAN_DEEP,
            borderTop: `2px solid ${RULE}`,
          }}
        />
        {/* Bagages opaques */}
        {bags.map((i) => (
          <div key={`o${i}`} style={{ position: 'absolute', left: bagAt(i), top: bagsY }}>
            <Xray mask={ROWS[i]!.mask} width={bag} opaque />
          </div>
        ))}
        {/* Fenêtre du scanner : les mêmes bagages, vus aux rayons X */}
        <div
          style={{
            position: 'absolute',
            left: center - win / 2,
            top: bagsY - 20,
            width: win,
            height: bag,
            overflow: 'hidden',
            background: SCAN,
          }}
        >
          {bags.map((i) => (
            <div
              key={`x${i}`}
              style={{ position: 'absolute', left: bagAt(i) - (center - win / 2), top: 20 }}
            >
              <Xray mask={ROWS[i]!.mask} width={bag} />
            </div>
          ))}
        </div>
        {/* Arche */}
        <div style={{ position: 'absolute', left: center - archSize / 2, top: beltY }}>
          <Arch size={archSize} strips={14} drop={Array(14).fill(0.0)} />
        </div>
        {/* Cadre d'opérateur sur HOOD */}
        {halt > 0 && (
          <div
            style={{
              position: 'absolute',
              left: center - win / 2 - 8,
              top: bagsY - 28,
              width: win + 16,
              height: bag * 0.72 + 56,
              border: `3px dashed ${ORGANIC}`,
              borderRadius: 10,
              opacity: halt,
              transform: `scale(${1.15 - 0.15 * halt})`,
            }}
          />
        )}
        {/* Nom sous l'arche */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: beltY + archSize + (v ? 18 : 6),
            textAlign: 'center',
            fontFamily: mono,
            fontSize: v ? 36 : 28,
          }}
        >
          <span style={{ fontWeight: 600 }}>{atCenter?.n ?? '(unreadable)'}</span>
          <span style={{ color: LEAD }}>
            {'  '}
            {atCenter && atCenter.h !== NO_HOOK
              ? `rulebook ${short(atCenter.h)}`
              : 'no rulebook · empty'}
          </span>
        </div>
      </div>

      {/* Ce que lisent les spécialistes */}
      {t > STOP + 0.5 && (
        <div
          style={{
            position: 'absolute',
            left: v ? 44 : 120,
            right: v ? 44 : 120,
            top: v ? beltY + archSize + 140 : beltY + archSize + 70,
            display: 'grid',
            gridTemplateColumns: v ? '1fr' : 'repeat(3, 1fr)',
            gap: v ? 44 : 48,
            opacity: 1 - out,
          }}
        >
          <Finding
            start={STOP + 0.6}
            title="name clone"
            color={ORGANIC}
            text={'uses "hood". not part of the issued robinhood token family.'}
          />
          <Finding
            start={STOP + 2.0}
            title="rule change"
            color={ORGANIC}
            text="the rulebook is an upgradeable proxy. it can be rewritten without changing address."
          />
          <Finding
            start={STOP + 3.6}
            title="sell path"
            color={METAL}
            text="the rulebook may change the amount of a trade. what it does with that is not in its permissions."
          />
        </div>
      )}

      <Scanlines />
      <Grain />
      <EndCard start={15.8} line="screens every market · soon" />
    </AbsoluteFill>
  );
};

const Finding: React.FC<{ start: number; title: string; text: string; color: string }> = ({
  start,
  title,
  text,
  color,
}) => {
  const t = useT();
  const v = useV();
  if (t < start) return null;
  const p = lerp(t, start, start + 0.35, 0, 1, easeOut);
  const chars = Math.floor((t - start - 0.2) * 75);
  return (
    <div
      style={{
        borderTop: `3px solid ${color}`,
        paddingTop: 16,
        opacity: p,
        transform: `translateY(${(1 - p) * 16}px)`,
      }}
    >
      <Tag color={color} style={{ fontSize: v ? 24 : 18, marginBottom: 10 }}>
        {title}
      </Tag>
      <div
        style={{
          fontFamily: display,
          fontWeight: 600,
          fontSize: v ? 42 : 30,
          lineHeight: 1.2,
          letterSpacing: '-0.01em',
        }}
      >
        {text.slice(0, Math.max(0, chars))}
      </div>
    </div>
  );
};
