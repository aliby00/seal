import { describe, expect, it } from 'vitest';
import { assertCompliant, findViolations, isCompliant } from '../../src/lib/agent/guardrails';

describe('garde-fous : aucun score numérique', () => {
  it.each(['Ce token obtient 72/100.', 'score: 8', 'Note : 4/5 sur la concentration.'])(
    'rejette %j',
    (text) => {
      expect(isCompliant(text)).toBe(false);
      expect(findViolations(text)[0]?.kind).toBe('score');
    },
  );

  it('laisse passer les chiffres factuels', () => {
    expect(isCompliant("40 % de l'offre est sur un seul wallet depuis la première heure.")).toBe(
      true,
    );
    expect(isCompliant('Le seuil de graduation est de 4,2 ETH.')).toBe(true);
  });
});

describe("garde-fous : aucun conseil d'achat", () => {
  it.each([
    'This looks safe to buy.',
    'I recommend this token.',
    'You should buy before graduation.',
    "C'est un bon investissement.",
    'Tu devrais acheter maintenant.',
    'Ce token est sans risque.',
  ])('rejette %j', (text) => {
    expect(isCompliant(text)).toBe(false);
    expect(findViolations(text)[0]?.kind).toBe('advice');
  });

  it('accepte une observation nuancée', () => {
    const output =
      'Ce créateur a lancé trois tokens. Deux ont gradué puis ont été abandonnés ' +
      'normalement, sans retrait de liquidité. Le troisième montre une concentration ' +
      "inhabituelle. Ce n'est pas le schéma classique du rug pull. À surveiller.";
    expect(isCompliant(output)).toBe(true);
  });
});

describe('assertCompliant', () => {
  it('ne lève rien sur une sortie conforme', () => {
    expect(() => assertCompliant('Les signaux ne racontent pas la même histoire.')).not.toThrow();
  });

  it('lève en nommant ce qui a été détecté', () => {
    expect(() => assertCompliant('Score : 9/10, safe to buy.')).toThrow(/non conforme/);
  });
});
