import React from 'react';
import { AbsoluteFill } from 'remotion';
import {
  Arch,
  DENSE,
  EndCard,
  Grain,
  LEAD,
  ORGANIC,
  RULE,
  Rise,
  SCAN,
  Scanlines,
  display,
  ease,
  easeOut,
  back,
  lerp,
  mono,
  useT,
  useV,
} from './lib3';

/** Les dix spécialistes et leur question. Mêmes noms que dans le code. */
const SPECIALISTS = [
  ['Code Reuse', 'seen this rulebook before?'],
  ['Wallet Age', 'did the creator exist before?'],
  ['Funding Trace', 'who paid for the wallet?'],
  ['Name Clone', 'whose name is it borrowing?'],
  ['Holder Spread', 'how many hands hold it?'],
  ['Creator History', 'what happened last time?'],
  ['Sell Path', 'can holders get out?'],
  ['Volume Reality', 'many traders, or a few?'],
  ['Liquidity Move', 'has liquidity left?'],
  ['Rule Change', 'can the rules be rewritten?'],
] as const;
const PICK = [3, 9, 0, 6];

/**
 * « Compose », 17 s. Dix spécialistes, quatre choisis, une ligne de contrôle
 * à soi. Aucun chiffre de classement : il n'en existe pas encore.
 */
export const Compose: React.FC = () => {
  const t = useT();
  const v = useV();
  const cols = v ? 2 : 5;
  const cw = v ? 470 : 340;
  const ch = 150;
  const gap = 18;
  const W = v ? 1080 : 1920;
  const gridW = cols * cw + (cols - 1) * gap;
  const gx = (W - gridW) / 2;
  const gy = v ? 360 : 300;

  const FLY = 6.4;
  const fly = lerp(t, FLY, FLY + 1.0, 0, 1, ease);
  const cardW = v ? 820 : 780;
  const cardX = (W - cardW) / 2;
  const cardY = v ? 700 : 290;
  const out = lerp(t, 13.6, 14.0, 0, 1);

  return (
    <AbsoluteFill style={{ background: SCAN, color: DENSE }}>
      <div
        style={{
          position: 'absolute',
          top: v ? 170 : 110,
          left: 0,
          right: 0,
          opacity: lerp(t, FLY - 0.4, FLY, 1, 0),
        }}
      >
        <Rise
          text="10 specialists. you pick."
          start={0.3}
          end={FLY}
          size={v ? 80 : 76}
          accent={['10']}
        />
      </div>

      {fly > 0 && (
        <div
          style={{
            position: 'absolute',
            left: cardX,
            top: cardY,
            width: cardW,
            height: v ? 560 : 510,
            background: '#F5F8F9',
            border: `1.5px solid ${RULE}`,
            borderRadius: 18,
            boxShadow: '0 30px 80px rgba(14,19,23,0.12)',
            opacity: fly * (1 - out),
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '28px 40px' }}>
            <Arch size={66} mask={0b10010000001100} />
            <div>
              <div
                style={{
                  fontFamily: display,
                  fontWeight: 800,
                  fontSize: v ? 38 : 34,
                  letterSpacing: '-0.02em',
                }}
              >
                impersonation watch
              </div>
              <div style={{ fontFamily: mono, fontSize: v ? 19 : 17, color: LEAD }}>
                4 specialists · leads on
              </div>
            </div>
          </div>
        </div>
      )}

      {SPECIALISTS.map(([name, q], i) => {
        const x0 = gx + (i % cols) * (cw + gap);
        const y0 = gy + Math.floor(i / cols) * (ch + gap);
        const appear = lerp(t, 0.9 + i * 0.09, 1.4 + i * 0.09, 0, 1, back);
        const k = PICK.indexOf(i);
        const picked = k >= 0;
        const sel = picked ? lerp(t, 3.4 + k * 0.6, 3.7 + k * 0.6, 0, 1, easeOut) : 0;
        const tx = cardX + 40;
        const ty = cardY + 150 + k * (v ? 92 : 82);
        const f = picked ? fly : 0;
        const row = f > 0.5;
        return (
          <div
            key={name}
            style={{
              position: 'absolute',
              left: x0 + (tx - x0) * f,
              top: y0 + (ty - y0) * f,
              width: cw + (cardW - 80 - cw) * f,
              height: ch + ((v ? 78 : 68) - ch) * f,
              opacity: appear * (picked ? 1 : 1 - lerp(t, FLY - 0.2, FLY + 0.4, 0, 1)) * (1 - out),
              transform: `scale(${0.92 + 0.08 * appear})`,
              background: sel > 0 ? `rgba(242,128,28,${0.1 * sel})` : '#F5F8F9',
              border: `2px solid ${sel > 0 ? ORGANIC : RULE}`,
              borderRadius: 12,
              padding: row ? '0 22px' : '18px 22px',
              display: 'flex',
              flexDirection: row ? 'row' : 'column',
              alignItems: row ? 'center' : 'flex-start',
              justifyContent: 'space-between',
            }}
          >
            <div
              style={{
                fontFamily: display,
                fontWeight: 800,
                fontSize: v ? 32 : 28,
                letterSpacing: '-0.01em',
                color: sel > 0.5 ? ORGANIC : DENSE,
              }}
            >
              {name}
            </div>
            <div style={{ fontFamily: mono, fontSize: v ? 20 : 18, color: LEAD }}>{q}</div>
          </div>
        );
      })}

      <div
        style={{ position: 'absolute', left: 0, right: 0, top: v ? 1340 : 870, opacity: 1 - out }}
      >
        <Rise
          text="no prompt. nothing to inject."
          start={FLY + 1.4}
          end={10.2}
          size={v ? 64 : 58}
          accent={['nothing']}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: v ? 1340 : 870,
          opacity: 1 - out,
          padding: '0 40px',
        }}
      >
        <Rise
          text="replayed on past markets. ranked by what it caught."
          start={10.3}
          end={13.6}
          size={v ? 58 : 54}
          accent={['caught.']}
        />
      </div>

      <Scanlines />
      <Grain />
      <EndCard start={14.0} line="build your agent · robinhood chain · soon" />
    </AbsoluteFill>
  );
};
