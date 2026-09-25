import { describe, expect, it } from 'vitest';
import { combineCompleteness, isEmpty } from '../../src/lib/contracts/completeness';

describe('combineCompleteness', () => {
  it('est full seulement si tout est full', () => {
    expect(combineCompleteness(['full', 'full', 'full'])).toBe('full');
  });

  it("retombe sur partial dès qu'une source est partielle", () => {
    expect(combineCompleteness(['full', 'partial', 'full'])).toBe('partial');
  });

  it('retombe sur partial, pas unavailable, si une seule source manque', () => {
    // Une analyse avec deux sources sur trois reste une analyse : l'agent doit
    // pouvoir raisonner dessus en le signalant, pas refuser de répondre.
    expect(combineCompleteness(['full', 'unavailable', 'full'])).toBe('partial');
  });

  it('traite une liste vide comme unavailable', () => {
    expect(combineCompleteness([])).toBe('unavailable');
  });
});

describe('isEmpty', () => {
  it('ne vaut que si toutes les sources ont échoué', () => {
    expect(isEmpty(['unavailable', 'unavailable'])).toBe(true);
    expect(isEmpty(['unavailable', 'partial'])).toBe(false);
    expect(isEmpty([])).toBe(false);
  });
});
