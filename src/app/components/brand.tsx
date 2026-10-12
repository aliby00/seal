import type { CSSProperties } from 'react';

/**
 * SEAL v3 — le contrôle. Même géométrie que brand/v3/gen/marks.mjs : l'arche
 * du scanner et son rideau de 14 lanières, une par bit de permission du hook
 * (bit 13 à gauche). Lanière longue = permission active.
 */
const f = (n: number) => +n.toFixed(2);
const bitOn = (mask: number, bit: number) => (mask >> bit) & 1;

export const PERMISSIONS = [
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
] as const;

export function Arch({
  mask = 0x3fff,
  strips = 14,
  className,
  style,
}: {
  mask?: number;
  strips?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const W = 78,
    H = 86,
    x0 = (100 - W) / 2,
    y0 = (100 - H) / 2,
    t = 8,
    r = W / 2;
  const outer = `M${x0} ${y0 + H} V${y0 + r} A${r} ${r} 0 0 1 ${x0 + W} ${y0 + r} V${y0 + H} H${x0 + W - t} V${y0 + r} A${r - t} ${r - t} 0 0 0 ${x0 + t} ${y0 + r} V${y0 + H} Z`;
  const ix0 = x0 + t + 3,
    ix1 = x0 + W - t - 3,
    cy = y0 + r,
    ri = r - t;
  const pitch = (ix1 - ix0) / strips,
    sw = pitch * (strips === 14 ? 0.72 : 0.62);
  return (
    <svg viewBox="0 0 100 100" className={className} style={style} aria-hidden="true">
      {Array.from({ length: strips }, (_, i) => {
        const on = strips === 14 ? bitOn(mask, 13 - i) : 1;
        const x = ix0 + pitch * i + (pitch - sw) / 2;
        const dx = x + sw / 2 - 50;
        const top = cy - Math.sqrt(Math.max(0, ri * ri - dx * dx)) + 4;
        const bottom = on ? y0 + H - 7 : cy + 4;
        return (
          <rect
            key={i}
            className="strip"
            style={{ '--i': i } as CSSProperties}
            x={f(x)}
            y={f(top)}
            width={f(sw)}
            height={f(bottom - top)}
            rx={f(sw / 2)}
          />
        );
      })}
      <path className="frame" d={outer} />
    </svg>
  );
}

/** Wordmark pochoir : chaque lettre en pièces, comme un marquage de cargaison. Le A est l'arche. */
export function Wordmark({ className }: { className?: string }) {
  const h = 60,
    w = 50,
    t = 12,
    g = 4,
    mt = (h - t) / 2,
    ra = w / 2,
    gap = 16;
  const letters = [
    <>
      <rect width={w} height={t} />
      <path d={`M0 ${t + g} H${t} V${mt} H${w} V${mt + t} H0 Z`} />
      <path d={`M${w - t} ${mt + t + g} H${w} V${h} H0 V${h - t} H${w - t} Z`} />
    </>,
    <>
      <rect width={t} height={h} />
      <rect x={t + g} width={w - t - g} height={t} />
      <rect x={t + g} y={30 - t / 2} width={w - t - g - 8} height={t} />
      <rect x={t + g} y={h - t} width={w - t - g} height={t} />
    </>,
    <>
      <path
        d={`M0 ${h} V${ra} A${ra} ${ra} 0 0 1 ${w} ${ra} V${h} H${w - t} V${ra} A${ra - t} ${ra - t} 0 0 0 ${t} ${ra} V${h} Z`}
      />
      <rect x={t + g} y={36} width={w - 2 * t - 2 * g} height={t - 2} />
    </>,
    <>
      <rect width={t} height={h - t - g} />
      <rect y={h - t} width={w} height={t} />
    </>,
  ];
  const W = 4 * w + 3 * gap;
  return (
    <svg viewBox={`-2 -2 ${W + 4} ${h + 4}`} className={className} aria-hidden="true">
      {letters.map((parts, i) => (
        <g key={i} transform={`translate(${i * (w + gap)} 0)`}>
          {parts}
        </g>
      ))}
    </svg>
  );
}

/**
 * L'image aux rayons X d'un marché. Chaque famille de permissions devient un
 * objet dans le bagage : orange pour les échanges, bleu pour la liquidité,
 * vert pour le reste. Un bagage vide, c'est un marché sans rulebook.
 */
const OBJECTS = [
  { bits: [7, 6], tone: 'organic', x: 10, y: 14, w: 46, h: 30, r: 15 },
  { bits: [3, 2], tone: 'organic-dense', x: 26, y: 22, w: 22, h: 22, r: 11 },
  { bits: [9, 8, 0], tone: 'metal', x: 54, y: 38, w: 36, h: 22, r: 4 },
  { bits: [11, 10, 1], tone: 'metal', x: 60, y: 14, w: 26, h: 14, r: 3 },
  { bits: [13, 12], tone: 'mixed', x: 12, y: 48, w: 16, h: 16, r: 8 },
  { bits: [5, 4], tone: 'mixed', x: 34, y: 50, w: 14, h: 10, r: 3 },
] as const;

export function Xray({ mask, opaque = false }: { mask: number; opaque?: boolean }) {
  return (
    <svg viewBox="0 0 100 72" className={opaque ? 'bag bag-opaque' : 'bag'} aria-hidden="true">
      <rect
        className="bag-shell"
        x={4}
        y={6}
        width={92}
        height={62}
        rx={9}
        strokeDasharray={mask === 0 && !opaque ? '3 2.5' : undefined}
      />
      <rect className="bag-handle" x={38} y={1} width={24} height={7} rx={3} />
      {!opaque &&
        OBJECTS.map((o, i) => {
          const n = o.bits.filter((b) => bitOn(mask, b)).length;
          if (n === 0) return null;
          return (
            <rect
              key={i}
              className={`obj obj-${o.tone}`}
              x={o.x}
              y={o.y}
              width={o.w}
              height={o.h}
              rx={o.r}
              opacity={0.45 + 0.25 * n}
            />
          );
        })}
    </svg>
  );
}
