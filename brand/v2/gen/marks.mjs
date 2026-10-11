// Générateur des marques SEAL v2. Géométrie calculée, pas dessinée à la main :
// les 14 crans du sceau sont les 14 bits de permission d'un hook Uniswap v4.
import { mkdirSync, writeFileSync } from 'node:fs';

export const WAX = '#E5432A';
export const BONE = '#EEEBE3';
export const INK = '#0B0B0C';
export const ASH = '#6B6A66';
/** Ombre de la cire : le creux de l'empreinte. */
export const WAX_DEEP = '#A82A17';

const f = (n) => +n.toFixed(2);
const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

/** Bit 13 en haut, puis sens horaire jusqu'au bit 0 : on lit le masque comme une horloge. */
export function seal({
  mask = 0x3fff,
  size = 100,
  color = WAX,
  off = 'none',
  core = true,
  slot = true,
  bg,
} = {}) {
  const c = size / 2,
    R1 = size * 0.36,
    R2 = size * 0.48,
    w = size * 0.075;
  const ticks = [];
  for (let i = 0; i < 14; i++) {
    const bit = 13 - i;
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 14;
    const [x1, y1] = polar(c, c, R1, a),
      [x2, y2] = polar(c, c, R2, a);
    const on = (mask >> bit) & 1;
    if (!on && off === 'none') continue;
    ticks.push(
      `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${on ? color : off}" stroke-width="${f(w)}" stroke-linecap="round"/>`,
    );
  }
  const r = size * 0.27;
  const coreEl = core
    ? `<circle cx="${c}" cy="${c}" r="${f(r)}" fill="${color}"/>` +
      (slot
        ? `<rect x="${f(c - r * 0.62)}" y="${f(c - size * 0.022)}" width="${f(r * 1.24)}" height="${f(size * 0.044)}" rx="${f(size * 0.022)}" fill="${bg ?? INK}"/>`
        : '')
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ''}${ticks.join('')}${coreEl}</svg>`;
}

/**
 * Cachet de cire. Le bord a 14 lobes, un par bit de permission, bit 13 en
 * haut puis sens horaire. Lobe plein = bit allumé ; lobe aplati = bit éteint.
 * Avec tous les bits, c'est la marque ; avec le masque d'un vrai hook, c'est
 * le sceau de ce marché — chaque rulebook a sa forme.
 */
export function wax({
  mask = 0x3fff,
  size = 100,
  color = WAX,
  deep = WAX_DEEP,
  ring = true,
  mono = true,
  bg,
  offAmp = 0.25,
} = {}) {
  const c = size / 2,
    R = size * 0.42,
    A = size * 0.055;
  const pts = [];
  const N = 14 * 28,
    sector = (2 * Math.PI) / 14;
  for (let k = 0; k <= N; k++) {
    const t = (k / N) * 2 * Math.PI;
    const i = Math.floor(t / sector) % 14;
    const u = (t - i * sector) / sector;
    const bit = 13 - i;
    const amp = (mask >> bit) & 1 ? 1 : offAmp;
    const r = R + A * amp * Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.7);
    const a = -Math.PI / 2 - sector / 2 + t;
    pts.push(`${f(c + r * Math.cos(a))},${f(c + r * Math.sin(a))}`);
  }
  const body = `<path d="M${pts.join('L')}Z" fill="${color}"/>`;
  const ri = R * 0.74;
  const ringEl = ring
    ? `<circle cx="${c}" cy="${c}" r="${f(ri)}" fill="none" stroke="${deep}" stroke-width="${f(size * 0.028)}"/>`
    : '';
  // Monogramme : le S du wordmark, même géométrie, en creux.
  const sw = size * 0.38,
    sh = size * 0.34,
    st = size * 0.07,
    s2 = st / 2,
    rr = sh / 4;
  const ox = c - sw / 2,
    oy = c - sh / 2;
  const S = `M${f(ox + sw - s2)} ${f(oy + s2)} H${f(ox + rr + s2)} A${f(rr)} ${f(rr)} 0 0 0 ${f(ox + rr + s2)} ${f(oy + sh / 2)} H${f(ox + sw - rr - s2)} A${f(rr)} ${f(rr)} 0 0 1 ${f(ox + sw - rr - s2)} ${f(oy + sh - s2)} H${f(ox + s2)}`;
  const monoEl = mono
    ? `<path d="${S}" fill="none" stroke="${deep}" stroke-width="${f(st)}" stroke-linejoin="round"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ''}${body}${ringEl}${monoEl}</svg>`;
}

/**
 * Wordmark « SEAL » construit au trait, sur une grille : même épaisseur partout,
 * E en trois barres (comme des lignes de bits), A en arche.
 */
export function wordmark({ color = BONE, stroke = 7, h = 40, w = 46, gap = 18 } = {}) {
  const s = stroke / 2,
    r = h / 4;
  const S = `M${w - s} ${s} H${r + s} A${r} ${r} 0 0 0 ${r + s} ${h / 2} H${w - r - s} A${r} ${r} 0 0 1 ${w - r - s} ${h - s} H${s}`;
  const E = `M${w - s} ${s} H${s} M${w - s * 3} ${h / 2} H${s} M${w - s} ${h - s} H${s}`;
  const A = `M${s} ${h} V${h / 2} A${w / 2 - s} ${w / 2 - s} 0 0 1 ${w - s} ${h / 2} V${h} M${s} ${h * 0.62} H${w - s}`;
  const L = `M${s} 0 V${h - s} H${w - s}`;
  const letters = [S, E, A, L].map(
    (d, i) =>
      `<path transform="translate(${i * (w + gap)} 0)" d="${d}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="butt" stroke-linejoin="round"/>`,
  );
  const W = 4 * w + 3 * gap;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${W + 4} ${h + 4}">${letters.join('')}</svg>`,
    width: W + 4,
    height: h + 4,
    inner: letters.join(''),
  };
}

export function lockup({ fg = BONE, mark = WAX, bg = INK, mask } = {}) {
  const wm = wordmark({ color: fg });
  const m = wax({ mask, size: 100, color: mark });
  const markInner = m.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const H = 100,
    scale = 0.5,
    wx = 116;
  const W = wx + wm.width * scale + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(W)} ${H}">${bg ? `<rect width="${f(W)}" height="${H}" fill="${bg}"/>` : ''}<g>${markInner}</g><g transform="translate(${wx} ${(H - wm.height * scale) / 2}) scale(${scale})">${wm.inner}</g></svg>`;
}

if (process.argv[2]) {
  const out = process.argv[2];
  mkdirSync(out, { recursive: true });
  const w = (n, s) => writeFileSync(`${out}/${n}.svg`, s);
  w('mark', wax());
  w('mark-flat', wax({ ring: false }));
  w('mark-bone', wax({ color: BONE, deep: '#BDB8AC' }));
  // Petites tailles : pas d'anneau, creux plus sombre pour que le S survive à 16 px.
  w('mark-small', wax({ ring: false, deep: '#6E1A0D' }));
  w('seal-hook-0x2544', wax({ mask: 0x2544 }));
  w('seal-hook-0x00cc', wax({ mask: 0x00cc }));
  w('wordmark-bone', wordmark().svg);
  w('wordmark-ink', wordmark({ color: INK }).svg);
  w('lockup-dark', lockup());
  w('lockup-light', lockup({ fg: INK, bg: BONE, mark: WAX }));
  w(
    'avatar',
    wax({ bg: INK })
      .replace('viewBox="0 0 100 100"', 'viewBox="-12 -12 124 124"')
      .replace('<rect width="100" height="100"', '<rect x="-12" y="-12" width="124" height="124"'),
  );
  console.log('ok');
}
