// SEAL v3 — « le contrôle ». Un marché passe au scanner : on voit ce qu'il
// contient, on ne dit pas s'il est bon. Géométrie calculée, pas dessinée.
import { mkdirSync, writeFileSync } from 'node:fs';

export const SCAN = '#E6ECEE'; // écran du scanner
export const DENSE = '#0E1317'; // matière dense, texte
export const ORGANIC = '#F2801C'; // orange : ce qui touche aux échanges
export const METAL = '#1E4FD8'; // bleu : ce qui touche à la liquidité
export const MIXED = '#2F9A5B'; // vert : le reste
export const LEAD = '#5E6A73';

const f = (n) => +n.toFixed(2);

/**
 * L'arche du scanner et son rideau de 14 lanières, une par bit de permission
 * (bit 13 à gauche). Lanière longue = bit allumé, courte = éteint. Tous les
 * bits : la marque. Le masque d'un vrai hook : le rideau de ce marché.
 */
export function arch({
  mask = 0x3fff,
  size = 100,
  frame = METAL,
  strip = ORGANIC,
  bg,
  strips = 14,
} = {}) {
  const W = 78,
    H = 86,
    x0 = (100 - W) / 2,
    y0 = (100 - H) / 2,
    t = 8,
    r = W / 2;
  const outer = `M${x0} ${y0 + H} V${y0 + r} A${r} ${r} 0 0 1 ${x0 + W} ${y0 + r} V${y0 + H} H${x0 + W - t} V${y0 + r} A${r - t} ${r - t} 0 0 0 ${x0 + t} ${y0 + r} V${y0 + H} Z`;
  const ix0 = x0 + t + 3,
    ix1 = x0 + W - t - 3,
    cx = 50,
    cy = y0 + r,
    ri = r - t;
  const pitch = (ix1 - ix0) / strips,
    sw = pitch * (strips === 14 ? 0.72 : 0.62);
  const bars = [];
  for (let i = 0; i < strips; i++) {
    const bit = strips === 14 ? 13 - i : null;
    const on = bit === null ? 1 : (mask >> bit) & 1;
    const x = ix0 + pitch * i + (pitch - sw) / 2,
      xm = x + sw / 2;
    const dx = xm - cx;
    const top = cy - Math.sqrt(Math.max(0, ri * ri - dx * dx)) + 4;
    const bottom = on ? y0 + H - 7 : cy + 4;
    bars.push(
      `<rect x="${f(x)}" y="${f(top)}" width="${f(sw)}" height="${f(bottom - top)}" rx="${f(sw / 2)}" fill="${strip}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${bg ? `<rect width="100" height="100" fill="${bg}"/>` : ''}${bars.join('')}<path d="${outer}" fill="${frame}"/></svg>`;
}

/** Wordmark pochoir : chaque lettre en pièces séparées, comme un marquage de cargaison. Le A est l'arche. */
export function wordmark({ color = DENSE, accent } = {}) {
  const h = 60,
    w = 50,
    t = 12,
    g = 4;
  const R = (x, y, ww, hh) => `<rect x="${x}" y="${y}" width="${ww}" height="${hh}"/>`;
  const P = (d) => `<path d="${d}"/>`;
  const mt = (h - t) / 2; // haut de la barre du milieu
  // S en trois pièces : barre haute | montant gauche + milieu | montant droit + barre basse.
  const S = [
    R(0, 0, w, t),
    P(`M0 ${t + g} H${t} V${mt} H${w} V${mt + t} H0 Z`),
    P(`M${w - t} ${mt + t + g} H${w} V${h} H0 V${h - t} H${w - t} Z`),
  ];
  const E = [
    R(0, 0, t, h),
    R(t + g, 0, w - t - g, t),
    R(t + g, 30 - t / 2, w - t - g - 8, t),
    R(t + g, h - t, w - t - g, t),
  ];
  const ra = w / 2;
  const A = [
    `<path d="M0 ${h} V${ra} A${ra} ${ra} 0 0 1 ${w} ${ra} V${h} H${w - t} V${ra} A${ra - t} ${ra - t} 0 0 0 ${t} ${ra} V${h} Z"${accent ? ` fill="${accent}"` : ''}/>`,
    R(t + g, 36, w - 2 * t - 2 * g, t - 2),
  ];
  const L = [R(0, 0, t, h - t - g), R(0, h - t, w, t)];
  const gap = 16;
  const letters = [S, E, A, L].map(
    (parts, i) => `<g transform="translate(${i * (w + gap)} 0)">${parts.join('')}</g>`,
  );
  const W = 4 * w + 3 * gap;
  return {
    inner: `<g fill="${color}">${letters.join('')}</g>`,
    width: W,
    height: h,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${W + 4} ${h + 4}"><g fill="${color}">${letters.join('')}</g></svg>`,
  };
}

export function lockup({ fg = DENSE, bg, frame = METAL, strip = ORGANIC } = {}) {
  const wm = wordmark({ color: fg });
  const m = arch({ frame, strip })
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');
  const s = 0.62,
    wx = 112,
    W = f(wx + wm.width * s + 8);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 100">${bg ? `<rect width="${W}" height="100" fill="${bg}"/>` : ''}${m}<g transform="translate(${wx} ${f(50 - (wm.height * s) / 2)}) scale(${s})">${wm.inner}</g></svg>`;
}

if (process.argv[2]) {
  const out = process.argv[2];
  mkdirSync(out, { recursive: true });
  const w = (n, s) => writeFileSync(`${out}/${n}.svg`, s);
  w('mark', arch());
  w('mark-on-scan', arch({ bg: SCAN }));
  w('mark-mono-dense', arch({ frame: DENSE, strip: DENSE }));
  w('mark-on-dense', arch({ bg: DENSE, frame: SCAN, strip: ORGANIC }));
  w('mark-small', arch({ strips: 5 }));
  w('rulebook-0x2544', arch({ mask: 0x2544, bg: SCAN }));
  w('rulebook-0x20cc', arch({ mask: 0x20cc, bg: SCAN }));
  w('wordmark', wordmark().svg);
  w('wordmark-scan', wordmark({ color: SCAN }).svg);
  w('lockup', lockup({ bg: SCAN }));
  w('lockup-dense', lockup({ fg: SCAN, bg: DENSE, frame: SCAN }));
  w(
    'avatar',
    arch({ bg: SCAN })
      .replace('viewBox="0 0 100 100"', 'viewBox="-14 -14 128 128"')
      .replace('<rect width="100" height="100"', '<rect x="-14" y="-14" width="128" height="128"'),
  );
  console.log('ok');
}
