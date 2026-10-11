import React from 'react';
import { AbsoluteFill } from 'remotion';
import {
  ASH,
  BONE,
  EndCard,
  Grain,
  Grid,
  INK,
  LINE,
  Rise,
  Vignette,
  WAX,
  Wax,
  back,
  ease,
  easeOut,
  lerp,
  mono,
  useT,
  useV,
} from './lib2';

/** Les dix spécialistes, avec la question que chacun pose. Mêmes libellés que le code. */
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

/** Ceux que l'agent de démonstration choisit. */
const PICK = [3, 9, 0, 6];

/**
 * « Compose », 16 s. Dix spécialistes, on en choisit quatre, ils deviennent
 * un agent. Pas de prompt : rien à injecter. Aucun chiffre de classement
 * n'est montré — il n'en existe pas encore.
 */
export const Compose: React.FC = () => {
  const t = useT();
  const v = useV();
  const cols = v ? 2 : 5;
  const cw = v ? 470 : 340;
  const ch = v ? 150 : 150;
  const gap = 18;
  const gridW = cols * cw + (cols - 1) * gap;
  const gridH = Math.ceil(10 / cols) * ch + (Math.ceil(10 / cols) - 1) * gap;
  const W = v ? 1080 : 1920;
  const H = v ? 1920 : 1080;
  const gx = (W - gridW) / 2;
  const gy = v ? 360 : 300;

  const FLY = 6.4;
  const fly = lerp(t, FLY, FLY + 1.0, 0, 1, ease);
  const cardW = v ? 820 : 760;
  const cardX = (W - cardW) / 2;
  const cardY = v ? 700 : 300;
  const out = lerp(t, 13.6, 14.0, 0, 1);

  return (
    <AbsoluteFill style={{ background: INK, color: BONE }}>
      <Grid opacity={0.5} />

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
          size={v ? 76 : 72}
          accent={['10']}
        />
      </div>

      {/* La carte de l'agent */}
      {fly > 0 && (
        <div
          style={{
            position: 'absolute',
            left: cardX,
            top: cardY,
            width: cardW,
            height: v ? 560 : 500,
            border: `1.5px solid ${LINE}`,
            borderRadius: 22,
            background: '#141415',
            boxShadow: '0 40px 120px rgba(0,0,0,0.6)',
            opacity: fly * (1 - out),
            fontFamily: mono,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '30px 40px' }}>
            <Wax size={64} lobes={Array(14).fill(1)} />
            <div>
              <div style={{ fontSize: v ? 36 : 32, fontWeight: 700 }}>impersonation watch</div>
              <div style={{ fontSize: v ? 20 : 18, color: ASH }}>4 specialists · leads on</div>
            </div>
          </div>
        </div>
      )}

      {SPECIALISTS.map(([name, q], i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x0 = gx + col * (cw + gap);
        const y0 = gy + row * (ch + gap);
        const appear = lerp(t, 0.9 + i * 0.09, 1.4 + i * 0.09, 0, 1, back);
        const pickIdx = PICK.indexOf(i);
        const picked = pickIdx >= 0;
        const sel = picked ? lerp(t, 3.4 + pickIdx * 0.6, 3.7 + pickIdx * 0.6, 0, 1, easeOut) : 0;
        // Les choisis volent dans la carte de l'agent ; les autres s'effacent.
        const tx = cardX + 40;
        const ty = cardY + 150 + pickIdx * (v ? 92 : 80);
        const x = picked ? x0 + (tx - x0) * fly : x0;
        const y = picked ? y0 + (ty - y0) * fly : y0;
        const w = picked ? cw + (cardW - 80 - cw) * fly : cw;
        const h = picked ? ch + ((v ? 78 : 66) - ch) * fly : ch;
        const fade = picked ? 1 : 1 - lerp(t, FLY - 0.2, FLY + 0.4, 0, 1);
        return (
          <div
            key={name}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: w,
              height: h,
              opacity: appear * fade * (1 - out),
              transform: `scale(${0.9 + 0.1 * appear})`,
              border: `1.5px solid ${sel > 0 ? `rgba(229,67,42,${0.3 + 0.7 * sel})` : LINE}`,
              background: `rgba(229,67,42,${0.08 * sel})`,
              borderRadius: 14,
              padding: fly > 0.5 && picked ? '0 22px' : '20px 22px',
              display: 'flex',
              flexDirection: fly > 0.5 && picked ? 'row' : 'column',
              alignItems: fly > 0.5 && picked ? 'center' : 'flex-start',
              justifyContent: fly > 0.5 && picked ? 'space-between' : 'space-between',
              fontFamily: mono,
            }}
          >
            <div style={{ fontSize: v ? 32 : 28, fontWeight: 700, color: sel > 0.5 ? WAX : BONE }}>
              {name}
            </div>
            <div style={{ fontSize: v ? 24 : 22, color: ASH }}>{q}</div>
          </div>
        );
      })}

      <div
        style={{ position: 'absolute', left: 0, right: 0, top: v ? 1340 : 860, opacity: 1 - out }}
      >
        <Rise
          text="no prompt. nothing to inject."
          start={FLY + 1.4}
          end={10.2}
          size={v ? 64 : 56}
          accent={['nothing']}
        />
      </div>
      <div
        style={{ position: 'absolute', left: 0, right: 0, top: v ? 1340 : 860, opacity: 1 - out }}
      >
        <Rise
          text="replayed on past markets. ranked by what it caught."
          start={10.3}
          end={13.6}
          size={v ? 56 : 52}
          accent={['caught.']}
        />
      </div>

      <Vignette />
      <Grain />
      <EndCard start={14.0} line="build your agent · robinhood chain · soon" />
    </AbsoluteFill>
  );
};
