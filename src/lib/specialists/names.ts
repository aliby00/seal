/**
 * Comparaison de noms de token, et neutralisation du texte qu'ils portent.
 *
 * Le nom d'un token est le seul texte libre qu'un attaquant fait entrer dans
 * SEAL. Il sera donc toujours cité, jamais interprété : `quoteName` le borne,
 * retire les caractères de contrôle et l'entoure de guillemets.
 */

/** Ce que les marchés usurpent le plus : 5 des 6 marchés v4 listés le mois dernier. */
export const WATCHED_NAMES = ['robinhood', 'hood', 'robinhoodchain', 'robinhoodmarkets'] as const;

/** Les substitutions visuelles les plus courantes, chiffres et cyrillique compris. */
const HOMOGLYPHS: Record<string, string> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  $: 's',
  '@': 'a',
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ӏ: 'l',
};

/**
 * Forme canonique : minuscules, homoglyphes ramenés, tout le reste retiré.
 * `one` dit comment lire le chiffre 1, qui passe pour un « l » comme pour un
 * « i » : « R0B1NH00D » ne se reconnaît qu'en le lisant « i ».
 */
export function normalizeName(raw: string, one: 'l' | 'i' = 'l'): string {
  return [...raw.normalize('NFKC').toLowerCase()]
    .map((ch) => (ch === '1' ? one : (HOMOGLYPHS[ch] ?? ch)))
    .join('')
    .replace(/[^a-z]/g, '');
}

/** Texte adressé à un logiciel plutôt qu'à un humain. */
const ADDRESSED_TO_SOFTWARE =
  /\b(?:ignore|disregard|forget)\b.{0,40}\b(?:instructions?|previous|above|rules?|prompt)\b|\b(?:system\s*prompt|you\s+are\s+(?:an?\s+)?(?:ai|assistant|agent|model)|report\s+(?:this|it)(?:\s+\w+)?\s+as)\b/i;

export function addressesSoftware(raw: string): boolean {
  return ADDRESSED_TO_SOFTWARE.test(raw);
}

const MAX_QUOTED = 40;

export function quoteName(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '(unreadable)';
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, ' ').trim();
  const cut = clean.length > MAX_QUOTED ? `${clean.slice(0, MAX_QUOTED)}\u2026` : clean;
  return JSON.stringify(cut);
}

/**
 * Le nom imite-t-il une marque surveillée ?
 *
 * Les noms longs comptent par inclusion — « ROBINHOOD INU » compte. Les noms
 * courts comptent seulement comme mot entier : sinon « childhood » et
 * « neighborhood » seraient des usurpations de « hood ».
 */
export function imitatedName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Le plus long d'abord : « robinhoodchain » avant « hood ».
  const sorted = [...WATCHED_NAMES].sort((a, b) => b.length - a.length);
  for (const one of ['l', 'i'] as const) {
    const whole = normalizeName(raw, one);
    const words = raw
      .split(/[\s_\-./|]+/)
      .map((w) => normalizeName(w, one))
      .filter(Boolean);
    const hit = sorted.find((watched) =>
      watched.length >= 6 ? whole.includes(watched) : words.includes(watched),
    );
    if (hit) return hit;
  }
  return null;
}
