import { findViolations } from '../agent/guardrails';

/**
 * Comparaison de noms de token, et neutralisation du texte qu'ils portent.
 *
 * Le nom d'un token est le seul texte libre qu'un attaquant fait entrer dans
 * SEAL. Il sera donc toujours cité, jamais interprété : `quoteName` le borne,
 * retire les caractères de contrôle et l'entoure de guillemets.
 */

/** A well-known Solana token: its mint, and the names another token would borrow from it. */
export type WatchedToken = {
  /** How it is named in a sentence: "USD Coin (USDC)". */
  label: string;
  mint: string;
  /**
   * Its names, normalised (`normalizeName`). One of six letters or more
   * counts when a name contains it; a shorter one only as a whole word or a
   * whole symbol, or "Raybot" would borrow Raydium's "RAY".
   */
  names: readonly string[];
};

/**
 * Tokens whose name and mint were read on mainnet (tests/fixtures/solana/
 * REFERENCE.json, 24/11/2026; USDC, USDT and wrapped SOL are also the quote
 * mints the market reader knows, a test holds them equal). Written out here:
 * the report screen imports this module, and the readers' modules do not
 * belong in a page. A token using one of these names under another mint
 * borrows it.
 */
export const WATCHED_TOKENS: readonly WatchedToken[] = [
  {
    label: 'USD Coin (USDC)',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    names: ['usdc', 'usdcoin'],
  },
  {
    label: 'Tether USD (USDT)',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    names: ['usdt', 'tether', 'tetherusd'],
  },
  {
    label: 'PayPal USD (PYUSD)',
    mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    names: ['pyusd', 'paypal', 'paypalusd'],
  },
  {
    label: 'Wrapped SOL',
    mint: 'So11111111111111111111111111111111111111112',
    names: ['wsol', 'wrappedsol'],
  },
  {
    label: 'Jupiter (JUP)',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    names: ['jup', 'jupiter'],
  },
  {
    label: 'Bonk (BONK)',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    names: ['bonk'],
  },
  {
    label: 'Raydium (RAY)',
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    names: ['ray', 'raydium'],
  },
];

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
 * « i » : « JUP1TER » ne se reconnaît qu'en le lisant « i ».
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
 * characters removed (a right-to-left override can make "PUJ" read as
 * "JUP"), cut to a length a header can hold, withheld when it reads as a
 * verdict. `null` when nothing is left to show.
 */
export function displayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || findViolations(clean).length > 0) return null;
  return clean.length > MAX_DISPLAYED ? `${clean.slice(0, MAX_DISPLAYED)}…` : clean;
}

export function quoteName(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '(unreadable)';
  const clean = raw.replace(INVISIBLE, ' ').trim();
  const cut = clean.length > MAX_QUOTED ? `${clean.slice(0, MAX_QUOTED)}…` : clean;
  // A name is chosen by the creator. Quoting "SAFE 100X" would publish a
  // verdict SEAL never makes — the name is withheld and that is said.
  if (findViolations(cut).length > 0) return '(name withheld: it reads as a verdict or advice)';
  return JSON.stringify(cut);
}

/**
 * The well-known token whose name `raw` borrows, if any.
 *
 * Long names count by inclusion — "JUPITER INU" counts. Short ones only as a
 * whole word: otherwise "Raybot" and "Bonkers" would borrow "RAY" and "BONK".
 */
export function imitatedName(raw: string | null | undefined): WatchedToken | null {
  if (!raw) return null;
  for (const one of ['l', 'i'] as const) {
    const whole = normalizeName(raw, one);
    const words = raw
      .split(/[\s_\-./|]+/)
      .map((w) => normalizeName(w, one))
      .filter(Boolean);
    // The longest name first: "paypalusd" before "paypal".
    for (const token of WATCHED_TOKENS) {
      const hit = [...token.names]
        .sort((a, b) => b.length - a.length)
        .some((name) => (name.length >= 6 ? whole.includes(name) : words.includes(name)));
      if (hit) return token;
    }
  }
  return null;
}

/**
 * Technical names that say how an account is built, not what it is: said
 * in plain words instead.
 */
const TECHNICAL_NAMES: readonly [RegExp, string][] = [
  [/proxy/i, 'an upgradeable program'],
  [/multicall|handler|executor|forwarder|router/i, 'a routing program'],
];

/** A program or account, said for a person: a plain phrase for a technical name, the name quoted otherwise. */
export function describeContract(name: string | null | undefined): string {
  if (!name) return 'an unnamed account';
  const plain = TECHNICAL_NAMES.find(([pattern]) => pattern.test(name));
  return plain ? plain[1] : `an account named ${quoteName(name)}`;
}

/** At or above this many transactions an address serves the public. */
const HIGH_VOLUME = 50_000;

/**
 * What first funded a wallet, said without overstating: "a high-volume
 * service" only when the count is high.
 */
export function describeService(
  name: string | null | undefined,
  txCount: number | null | undefined,
): string {
  if (txCount !== null && txCount !== undefined && txCount >= HIGH_VOLUME) {
    const what = name ? `${describeContract(name)}, ` : '';
    return `a high-volume service (${what}${txCount.toLocaleString('en-US')} transactions)`;
  }
  return name ? describeContract(name) : 'an account, or an address tagged as an exchange';
}
