import type { IndexedMarket } from '../chain/pools';
import type { Checklist } from './compose';
import { isFlagged, runAgent } from './run';
import type { SpecialistContext } from './types';

/**
 * Le classement : rejouer un agent sur le passé et compter.
 *
 * Pour chaque marché déjà indexé dont on connaît la suite, on demande à
 * l'agent ce qu'il aurait dit au lancement, puis on compare à ce qui s'est
 * passé. Trois comptes, pas de note :
 *
 *   caught    marchés qui ont mal fini et que l'agent avait signalés
 *   noise     marchés signalés qui ont bien fini
 *   coverage  marchés où tous ses spécialistes ont pu répondre
 *
 * Un agent qui signale tout attrape tout — et son bruit le montre. Un agent
 * qui ne choisit que des spécialistes sans données a une couverture faible —
 * et ça se voit aussi. C'est ce qui rend le classement difficile à truquer
 * par omission.
 */

/**
 * Un contexte doit être un instantané pris au lancement, pas aujourd'hui :
 * sinon l'agent « prévoit » un retrait de liquidité qu'il lit déjà dans les
 * données. Tolérance : ~10 minutes de blocs à 0,1 s.
 */
export const SNAPSHOT_MAX_DELAY_BLOCKS = 6_000;

export type ReplayCase = {
  market: IndexedMarket;
  context: SpecialistContext;
  /** Bloc auquel le contexte a été lu. */
  snapshotBlock: number;
};

export type Scoreline = {
  agent: string;
  fingerprint: string;
  markets: number;
  /** Marchés à l'issue connue — les seuls qui comptent pour caught et noise. */
  judged: number;
  harmed: number;
  flagged: number;
  caught: number;
  noise: number;
  /** Marchés où aucun des spécialistes choisis n'a répondu `unknown`. */
  covered: number;
};

export class LookaheadError extends Error {
  constructor(market: string, snapshot: number, launch: number) {
    super(
      `market ${market}: context read at block ${snapshot}, more than ${SNAPSHOT_MAX_DELAY_BLOCKS} blocks after launch (${launch}) — the replay would see the future`,
    );
    this.name = 'LookaheadError';
  }
}

export function replay(checklist: Checklist, cases: readonly ReplayCase[]): Scoreline {
  const line: Scoreline = {
    agent: checklist.name,
    fingerprint: checklist.fingerprint,
    markets: cases.length,
    judged: 0,
    harmed: 0,
    flagged: 0,
    caught: 0,
    noise: 0,
    covered: 0,
  };

  // Rejouer sans suivre de pistes : seule la sélection de l'agent est jugée.
  const strict: Checklist = { ...checklist, followLeads: false };

  for (const { market, context, snapshotBlock } of cases) {
    if (snapshotBlock - market.blockNumber > SNAPSHOT_MAX_DELAY_BLOCKS) {
      throw new LookaheadError(market.id, snapshotBlock, market.blockNumber);
    }
    const { findings } = runAgent(strict, context);
    if (findings.every((f) => f.signal !== 'unknown')) line.covered += 1;

    const flagged = isFlagged(strict, findings);
    if (flagged) line.flagged += 1;

    if (market.outcome !== 'harmed' && market.outcome !== 'unharmed') continue;
    line.judged += 1;
    if (market.outcome === 'harmed') {
      line.harmed += 1;
      if (flagged) line.caught += 1;
    } else if (flagged) {
      line.noise += 1;
    }
  }
  return line;
}

/**
 * Ordre du classement : d'abord ce qui a été attrapé, puis le moins de bruit,
 * puis la couverture. Aucun chiffre composite : on trie sur des comptes que
 * chacun peut vérifier, dans un ordre annoncé.
 */
export function rank(lines: readonly Scoreline[]): Scoreline[] {
  const seen = new Set<string>();
  return [...lines]
    .sort((a, b) => b.caught - a.caught || a.noise - b.noise || b.covered - a.covered)
    .filter((l) => {
      // Deux agents identiques ne prennent pas deux places.
      if (seen.has(l.fingerprint)) return false;
      seen.add(l.fingerprint);
      return true;
    });
}
