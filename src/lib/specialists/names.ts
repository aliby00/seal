import { findViolations } from '../agent/guardrails';
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

/** Control, zero-width and bidi characters: they hide or reorder what a reader sees. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** Longest name or symbol shown in the report header. */
export const MAX_DISPLAYED = 64;

/**
 * A creator-chosen name as the report header shows it: invisible and bidi
 * characters removed (a right-to-left override can make "DOOH" read as
 * "HOOD"), cut to a length a header can hold, withheld when it reads as a
 * verdict. `null` when nothing is left to show.
 */
export function displayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || findViolations(clean).length > 0) return null;
  return clean.length > MAX_DISPLAYED ? `${clean.slice(0, MAX_DISPLAYED)}\u2026` : clean;
}

export function quoteName(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '(unreadable)';
  const clean = raw.replace(INVISIBLE, ' ').trim();
  const cut = clean.length > MAX_QUOTED ? `${clean.slice(0, MAX_QUOTED)}\u2026` : clean;
  // A name is chosen by the creator. Quoting "SAFE 100X" would publish a
  // verdict SEAL never makes — the name is withheld and that is said.
  if (findViolations(cut).length > 0) return '(name withheld: it reads as a verdict or advice)';
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

/**
 * Contract names that say how a contract is built, not what it is: shown raw
 * ("TransparentUpgradeableProxy", "MulticallHandler"), they read as jargon
 * or, worse, as a name the contract chose. Said in plain words instead.
 */
const TECHNICAL_NAMES: readonly [RegExp, string][] = [
  [/proxy/i, 'an upgradeable contract'],
  [/multicall|handler|executor|forwarder/i, 'a routing contract'],
];

/** A contract, said for a person: a plain phrase for a technical name, the name quoted otherwise. */
export function describeContract(name: string | null | undefined): string {
  if (!name) return 'an unnamed contract';
  const plain = TECHNICAL_NAMES.find(([pattern]) => pattern.test(name));
  return plain ? plain[1] : `a contract named ${quoteName(name)}`;
}

/** At or above this many transactions an address serves the public (funder-kind.ts). */
const HIGH_VOLUME = 50_000;

/**
 * What first funded a wallet, said without overstating: "a high-volume
 * service" only when the count is high, "a contract" otherwise — a contract
 * with 0 transactions sent is not "high-volume".
 */
export function describeService(
  name: string | null | undefined,
  txCount: number | null | undefined,
): string {
  if (txCount !== null && txCount !== undefined && txCount >= HIGH_VOLUME) {
    const what = name ? `${describeContract(name)}, ` : '';
    return `a high-volume service (${what}${txCount.toLocaleString('en-US')} transactions)`;
  }
  // Below the count, a service is a contract, or an address tagged as an exchange.
  return name ? describeContract(name) : 'a contract, or an address tagged as an exchange';
}
