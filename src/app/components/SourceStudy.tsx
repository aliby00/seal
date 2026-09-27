'use client';

import { useState } from 'react';

const readings = [
  {
    name: 'La chaîne',
    provider: 'Robinhood RPC',
    title: 'Reconstituer le contexte.',
    text: 'Les lancements du créateur, dans la fenêtre de blocs disponible. Un historique borné reste un historique borné.',
    kind: 'chain',
  },
  {
    name: 'Les détenteurs',
    provider: 'Blockscout',
    title: 'Comprendre la répartition.',
    text: 'Qui détient l’offre, en distinguant le pool et les adresses de burn. Une concentration se lit avec son contexte.',
    kind: 'holders',
  },
  {
    name: 'Le marché',
    provider: 'DexScreener',
    title: 'Remettre l’activité en perspective.',
    text: 'Liquidité, volume et transactions. Une activité visible ne suffit pas à expliquer ce qui se passe derrière.',
    kind: 'market',
  },
] as const;

/** A methodology illustration, never a representation of a token's data. */
export function SourceStudy() {
  const [selected, setSelected] = useState(0);
  const reading = readings[selected] ?? readings[0];
  return (
    <aside className="source-study" aria-label="Comment SEAL croise les sources">
      <div className="study-heading">
        <span>Le principe de lecture</span>
        <span aria-hidden="true">↗</span>
      </div>
      <div className="study-illustration" aria-hidden="true" data-source={reading.kind}>
        <div className="study-orbit orbit-one" />
        <div className="study-orbit orbit-two" />
        <div className="evidence-sheet sheet-back">
          <span>03 / MARCHÉ</span>
          <div className="sheet-ledger">
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="evidence-sheet sheet-middle">
          <span>02 / DÉTENTEURS</span>
          <div className="sheet-ledger">
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="evidence-sheet sheet-front">
          <div className="sheet-top">
            <span>SEAL</span>
            <span>NOTE DE LECTURE</span>
          </div>
          <div className="sheet-title">
            Les faits,
            <br />
            <em>mis en relation.</em>
          </div>
          <div className="sheet-lines">
            <i />
            <i />
            <i />
          </div>
          <div className="sheet-annotation">
            <span>↳</span> Convergences.
            <br />
            Limites. Contradictions.
          </div>
          <div className="sheet-bottom">TROIS SOURCES / UNE EXPLICATION</div>
        </div>
        <span className="study-coordinate coordinate-left">DONNÉES PUBLIQUES</span>
        <span className="study-coordinate coordinate-right">LECTURE CROISÉE</span>
      </div>
      <div className="study-selector" role="group" aria-label="Explorer les sources">
        {readings.map((item, index) => (
          <button
            key={item.kind}
            type="button"
            aria-pressed={selected === index}
            aria-controls="source-study-detail"
            onClick={() => setSelected(index)}
          >
            <span>0{index + 1}</span>
            {item.name}
          </button>
        ))}
      </div>
      <div className="study-detail" id="source-study-detail" aria-live="polite">
        <div className="study-provider">{reading.provider}</div>
        <h3>{reading.title}</h3>
        <p>{reading.text}</p>
      </div>
      <p className="study-caption">Illustration de la méthode · aucune donnée de token affichée</p>
    </aside>
  );
}
