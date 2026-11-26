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
      'inhabituelle. À surveiller.';
    expect(isCompliant(output)).toBe(true);
  });
});

describe('verdict words', () => {
  // Negated or not, these words judge the token; SEAL never uses them.
  it.each([
    "Ce n'est pas le schéma classique du rug pull.",
    'Looks like a scam.',
    'A honeypot pattern.',
    'This token looks safe.',
    'Low risk overall.',
    'Seems legit.',
    'Une arnaque probable.',
    '★★★★☆',
  ])('rejette %j', (text) => {
    expect(findViolations(text).map((v) => v.kind)).toContain('verdict');
  });

  it.each([
    'The pool kept its liquidity.',
    'safeParse is a function name, not a word in a sentence.'.replace('safeParse', 'parse'),
    'The creator sold into the pool within a day.',
    'Liquidity was removed twice.',
  ])('accepte %j', (text) => {
    expect(isCompliant(text)).toBe(true);
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

describe('mots qui prêtent une intention', () => {
  it.each(['An insider wallet received 5%.', 'Insiders got 30% at launch.', 'A bundler took 12%.'])(
    'refuse « %s »',
    (text) => {
      expect(findViolations(text).map((v) => v.kind)).toContain('verdict');
    },
  );

  // Trader words for what SEAL measures, said with the measure (26/11/2026):
  // a description, not a verdict.
  it.each([
    'Bundled launch: 3 wallets other than the dev took 41.9% of the supply in the creation slot.',
    'Snipers: 7 wallets bought 43.8% in the first second; they hold none of it today.',
    'Serial launcher: the dev has at least 1,382 other launches.',
    'The dev bought 1.8% of the supply, then sold all of it within 4 minutes.',
  ])('laisse passer « %s »', (text) => {
    expect(findViolations(text)).toEqual([]);
  });
});

describe('comptes et dates ne sont pas des scores', () => {
  it.each([
    'Sales were checked on 3/10 launches.',
    'Collected on 16/10/2026.',
    'Only 4/5 wallets still hold tokens.',
  ])('laisse passer « %s »', (text) => {
    expect(findViolations(text)).toEqual([]);
  });
});

describe('links and claims of a guarantee', () => {
  // A name can push the model to write a link or a guarantee: neither is served.
  it.each([
    'Claim your airdrop at https://evil.example/claim before the pool opens.',
    'More on http://evil.example.',
    'Join at www.evil-airdrop.com today.',
    'The team posts on x.com/sealsupport every day.',
    'Claim it on evil-airdrop.xyz before the pool opens.',
    'Read more at t.me/somechannel.',
  ])('refuse le lien dans « %s »', (text) => {
    expect(findViolations(text).map((v) => v.kind)).toContain('link');
  });

  it.each([
    'This token is verified and audited by SEAL.',
    'The contract has been audited.',
    'A verified token with a trusted team.',
    'The creator is trusted.',
    'Liquidity is guaranteed by the developers.',
    'Certified by an independent firm.',
  ])('refuse la garantie dans « %s »', (text) => {
    expect(findViolations(text).map((v) => v.kind)).toContain('verdict');
  });

  it.each([
    'It launched on pump.fun and moved to PumpSwap.',
    'The creator sold 4.2 SOL worth within a day.',
    'Who holds the positions was not verified: the read stopped at 3 pools.',
    'The liquidity was not audited by anyone SEAL can read.',
    'Each address can be checked on the Solana Explorer.',
    'The largest holder is a Meteora DLMM pool, e.g. a program account.',
  ])('accepte « %s »', (text) => {
    expect(findViolations(text)).toEqual([]);
  });
});

describe('trader advice, now that the flags speak trader', () => {
  it.each([
    'Avoid this token.',
    'Ape in now.',
    'Buy now before it runs.',
    'Stay away from this coin.',
  ])('refuse « %s »', (text) => {
    expect(findViolations(text).map((v) => v.kind)).toContain('advice');
  });

  it.each([
    'Chart dead: mcap $2.0k after $38.5k traded in 24 h',
    'Dev sold everything: bought 21.5%, sold it all within 4 minutes',
    '16 buys and 3 sells in the last hour.',
  ])('laisse passer « %s »', (text) => {
    expect(findViolations(text)).toEqual([]);
  });
});
