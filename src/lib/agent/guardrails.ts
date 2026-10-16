/**
 * Garde-fous de sortie de l'agent.
 *
 * Deux contraintes viennent directement du whitepaper et ne sont pas
 * négociables : SEAL ne produit jamais de score, et ne formule jamais
 * quelque chose qui se lit comme un conseil d'achat. Ce sont des
 * propriétés testables, pas des intentions — d'où ce module.
 */

export type Violation = {
  kind: 'score' | 'advice' | 'verdict';
  matched: string;
};

/**
 * Un score chiffré, sous ses formes usuelles : « 72/100 », « 8.5 / 10 », « note : 4/5 ».
 * A count ("3/10 launches checked") or a date ("16/10/2026") is not a score.
 */
const SCORE_PATTERNS: RegExp[] = [
  /(?<![\d/.,])\b\d{1,3}(?:[.,]\d+)?\s*\/\s*(?:5|10|20|100)\b(?!\s*\/)(?!\s+(?:launch|token|wallet|holder|address|buy|buyer|sell|seller|sale|trade|transaction|transfer|day|month|block|minute|second|hour|specialist|question|check|source|pool|move|contract)(?:e?s)?\b)/g,
  /\b(?:score|note|rating|grade)\s*[:=]\s*\d/gi,
  /\b\d{1,3}\s*(?:points?|pts)\s*(?:sur|\/)\s*\d/gi,
];

/** Des formulations qui transforment une observation en recommandation. */
const ADVICE_PATTERNS: RegExp[] = [
  /\bsafe\s+to\s+(?:buy|invest|ape)\b/gi,
  /\b(?:not\s+)?(?:a\s+)?good\s+(?:buy|investment)\b/gi,
  /\b(?:you\s+)?should\s+(?:buy|sell|invest|avoid)\b/gi,
  /\b(?:i|we)\s+recommend\b/gi,
  /\b(?:bon|mauvais)\s+investissement\b/gi,
  /\b(?:tu\s+)?(?:devrais|devriez)\s+(?:acheter|vendre|investir)\b/gi,
  /\bje\s+(?:te\s+)?(?:recommande|conseille)\b/gi,
  /\b(?:sans\s+risque|aucun\s+risque|risque\s+z[ée]ro)\b/gi,
];

/**
 * Verdict words. SEAL describes what a market can do, never what it is: these
 * words judge, so they never appear — not even negated ("not a rug pull"
 * still plants the word). Checked on everything served, on-chain names
 * included, since a token can be named "SAFE 100X".
 */
const VERDICT_PATTERNS: RegExp[] = [
  /\b(?:scam\w*|rug(?:\s*-?\s*pull\w*|ged|s)?|honey\s*-?pots?|legit(?:imate)?|trustworth\w*)\b/gi,
  /\b(?:safe|safer|safest|risky|riskier|unsafe)\b/gi,
  /\b(?:low|high|no|zero|minimal)\s+risk\b/gi,
  /\b(?:arnaque\w*|escroquerie\w*|fiable)\b/gi,
  // Labels that assign an intent to a wallet: SEAL says "bought in the launch
  // block", the reader decides what that makes the buyer.
  /\b(?:snip(?:e|er|ers|ed|es|ing)|insiders?|bundl(?:e|es|ed|er|ers|ing))\b/gi,
  /[★☆⭐]/g,
];

function collect(text: string, patterns: RegExp[], kind: Violation['kind']): Violation[] {
  const found: Violation[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[0]) found.push({ kind, matched: match[0] });
    }
  }
  return found;
}

/** Retourne toutes les violations trouvées. Un tableau vide signifie que la sortie est conforme. */
export function findViolations(text: string): Violation[] {
  return [
    ...collect(text, SCORE_PATTERNS, 'score'),
    ...collect(text, ADVICE_PATTERNS, 'advice'),
    ...collect(text, VERDICT_PATTERNS, 'verdict'),
  ];
}

export function isCompliant(text: string): boolean {
  return findViolations(text).length === 0;
}

/** À utiliser côté serveur : on préfère échouer bruyamment que publier une sortie non conforme. */
export function assertCompliant(text: string): void {
  const violations = findViolations(text);
  if (violations.length > 0) {
    const detail = violations.map((v) => `${v.kind} → "${v.matched}"`).join(', ');
    throw new Error(`Sortie de l'agent non conforme : ${detail}`);
  }
}
