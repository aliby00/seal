import { describe, expect, it } from 'vitest';
import {
  LookaheadError,
  SNAPSHOT_MAX_DELAY_BLOCKS,
  compileAgent,
  rank,
  replay,
  type ReplayCase,
} from '../../src/lib/specialists';
import { MARKETS } from './helpers';

/**
 * Rejeu sur des marchés réels, avec un seul spécialiste piloté par le
 * contexte (wallet-age) : on contrôle ce que l'agent voit, et l'issue.
 */
function cases(
  spec: { nonce: number; outcome: 'harmed' | 'unharmed' | undefined }[],
): ReplayCase[] {
  return spec.map(({ nonce, outcome }, i) => {
    const m = structuredClone(MARKETS[i]!);
    if (outcome) m.outcome = outcome;
    return {
      market: m,
      context: { token: m.token, creatorNonce: nonce },
      snapshotBlock: m.blockNumber,
    };
  });
}

const agent = compileAgent({ name: 'fresh wallets', specialists: ['wallet-age'] });

describe('replay', () => {
  it('compte attrapés, bruit et couverture sur des issues connues', () => {
    const line = replay(
      agent,
      cases([
        { nonce: 1, outcome: 'harmed' }, // attrapé
        { nonce: 2, outcome: 'harmed' }, // attrapé
        { nonce: 900, outcome: 'harmed' }, // manqué
        { nonce: 1, outcome: 'unharmed' }, // bruit
        { nonce: 900, outcome: 'unharmed' },
        { nonce: 1, outcome: undefined }, // issue inconnue : signalé, pas jugé
      ]),
    );
    expect(line).toMatchObject({
      markets: 6,
      judged: 5,
      harmed: 3,
      flagged: 4,
      caught: 2,
      noise: 1,
      covered: 6,
    });
  });

  it('compte comme non couvert un marché où un spécialiste n’a pas pu répondre', () => {
    const [c] = cases([{ nonce: 1, outcome: 'harmed' }]);
    const blind = { ...c!, context: { token: c!.market.token } };
    expect(replay(agent, [blind]).covered).toBe(0);
  });

  // Sans ce garde-fou, un agent « prévoit » un retrait qu'il lit déjà dans les données.
  it('refuse un contexte lu après le lancement : le rejeu verrait le futur', () => {
    const [c] = cases([{ nonce: 1, outcome: 'harmed' }]);
    const late = { ...c!, snapshotBlock: c!.market.blockNumber + SNAPSHOT_MAX_DELAY_BLOCKS + 1 };
    expect(() => replay(agent, [late])).toThrow(LookaheadError);
  });
});

describe('rank', () => {
  const line = (
    agentName: string,
    fingerprint: string,
    caught: number,
    noise: number,
    covered = 10,
  ) => ({
    agent: agentName,
    fingerprint,
    markets: 10,
    judged: 10,
    harmed: 5,
    flagged: caught + noise,
    caught,
    noise,
    covered,
  });

  it('classe sur ce qui a été attrapé, puis le moins de bruit', () => {
    const order = rank([line('a', '1', 3, 0), line('b', '2', 4, 5), line('c', '3', 4, 1)]);
    expect(order.map((l) => l.agent)).toEqual(['c', 'b', 'a']);
  });

  it('ne donne qu’une place à deux agents identiques', () => {
    expect(rank([line('a', 'same', 3, 0), line('copy', 'same', 3, 0)])).toHaveLength(1);
  });
});
