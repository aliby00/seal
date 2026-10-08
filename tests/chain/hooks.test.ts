import { describe, expect, it } from 'vitest';
import { isCompliant } from '../../src/lib/agent/guardrails';
import {
  ALL_HOOK_MASK,
  decodeHookPermissions,
  HOOK_FLAGS,
  readHook,
} from '../../src/lib/chain/hooks';

/**
 * Les cinq hooks ci-dessous ont été relevés sur la chaîne, pas inventés.
 * C'est volontaire : la dernière fois qu'un bug a traversé 136 tests verts,
 * c'était parce que les fixtures fournissaient directement la bonne valeur.
 */
const OBSERVED = {
  /** Celui-ci portait 28 des 97 marchés créés sur une fenêtre de 50 minutes. */
  reused28: '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544',
  both: '0x809397880b3a31c4e88cf6aba367a45509e320cc',
  afterOnly: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  beforeOnly: '0xb85129984abc5b09900d485fa00d7281984a2080',
  none: '0x0000000000000000000000000000000000000000',
} as const;

function addressWith(bits: number): string {
  return `0x${'0'.repeat(36)}${bits.toString(16).padStart(4, '0')}`;
}

describe('decodeHookPermissions — positions de bits', () => {
  it('place chaque drapeau sur le bit que Hooks.sol lui donne', () => {
    for (const [name, bit] of HOOK_FLAGS) {
      const decoded = decodeHookPermissions(addressWith(1 << bit));
      expect(decoded.flags, `${name} au bit ${bit}`).toEqual([name]);
    }
  });

  it("n'inspecte que les 14 bits bas de l'adresse", () => {
    // Les bits 14 et 15 sont allumés : ils ne portent aucune permission.
    const decoded = decodeHookPermissions(addressWith(0b1100_0000_0000_0000));
    expect(decoded.mask).toBe(0);
    expect(decoded.unhooked).toBe(true);
  });

  it('reconnaît un masque plein', () => {
    const decoded = decodeHookPermissions(addressWith(ALL_HOOK_MASK));
    expect(decoded.flags).toHaveLength(HOOK_FLAGS.length);
    expect(decoded.inconsistent).toEqual([]);
  });
});

describe('decodeHookPermissions — hooks réellement observés', () => {
  it('décode le hook réutilisé 28 fois', () => {
    const decoded = decodeHookPermissions(OBSERVED.reused28);
    expect(decoded.mask).toBe(0x2544);
    expect(decoded.flags).toEqual([
      'beforeInitialize',
      'afterAddLiquidity',
      'afterRemoveLiquidity',
      'afterSwap',
      'afterSwapReturnsDelta',
    ]);
  });

  it('décode les quatre autres sans incohérence', () => {
    for (const hook of Object.values(OBSERVED)) {
      expect(decodeHookPermissions(hook).inconsistent, hook).toEqual([]);
    }
  });

  it('voit un rulebook absent là où il est absent', () => {
    const decoded = decodeHookPermissions(OBSERVED.none);
    expect(decoded.unhooked).toBe(true);
    expect(decoded.flags).toEqual([]);
  });
});

describe('decodeHookPermissions — cohérence et saisie', () => {
  it('signale un ReturnsDelta orphelin au lieu de le présenter comme acquis', () => {
    // afterSwapReturnsDelta (bit 2) sans afterSwap (bit 6).
    const decoded = decodeHookPermissions(addressWith(1 << 2));
    expect(decoded.inconsistent).toEqual(['afterSwapReturnsDelta']);
  });

  it('ne signale rien quand le drapeau de base est là', () => {
    const decoded = decodeHookPermissions(addressWith((1 << 6) | (1 << 2)));
    expect(decoded.inconsistent).toEqual([]);
  });

  it('lève sur une adresse mal formée plutôt que de répondre « pas de rulebook »', () => {
    for (const bad of ['', '0x', 'pas-une-adresse', '0x4e3468', OBSERVED.none.slice(0, -1)]) {
      expect(() => decodeHookPermissions(bad), bad).toThrow(TypeError);
    }
  });

  it('accepte une adresse en majuscules et la normalise', () => {
    const decoded = decodeHookPermissions(OBSERVED.reused28.toUpperCase().replace('0X', '0x'));
    expect(decoded.hook).toBe(OBSERVED.reused28);
  });
});

describe('describeHookPermissions', () => {
  it('met le pouvoir de modifier une vente en premier', () => {
    const { capabilities } = readHook(OBSERVED.reused28);
    expect(capabilities[0]?.id).toBe('alters-swap-amounts');
  });

  it('justifie chaque phrase par les drapeaux qui la portent', () => {
    const { capabilities, flags } = readHook(OBSERVED.both);
    for (const capability of capabilities) {
      expect(capability.because.length).toBeGreaterThan(0);
      for (const flag of capability.because) expect(flags).toContain(flag);
    }
  });

  it('ne dit rien quand il n’y a pas de rulebook', () => {
    expect(readHook(OBSERVED.none).capabilities).toEqual([]);
  });

  it('ne formule jamais une intention, seulement une capacité', () => {
    // Un rulebook qui peut prélever ne prélève pas forcément. Aucune phrase ne
    // doit affirmer ce que le code fait.
    const forbidden = /\b(?:prélève|bloque|empêche|vole|arnaque|scam|rug)\b(?!r\b)/i;
    for (const hook of Object.values(OBSERVED)) {
      for (const { statement } of readHook(hook).capabilities) {
        expect(statement, statement).not.toMatch(forbidden);
      }
    }
  });

  it('produit des phrases qui passent les garde-fous du produit', () => {
    // Ces phrases finissent dans la réponse servie. Si l'une violait « jamais
    // de score, jamais de conseil », le garde-fou bloquerait toute la réponse
    // et l'agent paraîtrait cassé.
    for (const hook of Object.values(OBSERVED)) {
      for (const { statement } of readHook(hook).capabilities) {
        expect(isCompliant(statement), statement).toBe(true);
      }
    }
  });
});
