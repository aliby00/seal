import React from 'react';
import { AbsoluteFill } from 'remotion';
import { BG, EndCard, Grain, P, Words } from './lib';

/**
 * Film 3 — le teaser de lancement.
 * Pas de données, pas de capture : quatre phrases et la marque.
 * C'est le film qu'on épingle.
 */
export const Teaser: React.FC = () => (
  <AbsoluteFill style={{ background: BG }}>
    <Words
      parts={P('Celui qui lance un token écrit aussi *les règles du marché.*')}
      start={0.5}
      end={4.2}
      size={74}
    />
    <Words parts={P('Ces règles sont *publiques.*')} start={4.5} end={7.0} size={82} />
    <Words parts={P('Personne ne les *lit.*')} start={7.3} end={10.0} size={88} />
    <Words parts={P('Nous, *si.*')} start={10.6} end={13.0} size={104} />
    <EndCard start={13.4} line="Le portefeuille change. Le code, non." />
    <Grain />
  </AbsoluteFill>
);
