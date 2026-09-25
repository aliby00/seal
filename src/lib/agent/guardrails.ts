/**
 * Garde-fous de sortie de l'agent.
 *
 * Deux contraintes viennent directement du whitepaper et ne sont pas
 * négociables : SEAL ne produit jamais de score, et ne formule jamais
 * quelque chose qui se lit comme un conseil d'achat. Ce sont des
 * propriétés testables, pas des intentions — d'où ce module.
 */

export type Violation = {
  kind: 'score' | 'advice';
  matched: string;
};

/** Un score chiffré, sous ses formes usuelles : « 72/100 », « 8.5 / 10 », « note : 4/5 ». */
const SCORE_PATTERNS: RegExp[] = [
  /\b\d{1,3}(?:[.,]\d+)?\s*\/\s*(?:5|10|20|100)\b/g,
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
  return [...collect(text, SCORE_PATTERNS, 'score'), ...collect(text, ADVICE_PATTERNS, 'advice')];
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
