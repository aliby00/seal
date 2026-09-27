'use client';
import { useState } from 'react';

const perspectives = [
  {
    name: 'Creator',
    provider: 'Robinhood RPC',
    title: 'Before this token, there was a history.',
    text: 'Previous launches and their outcomes provide context. SEAL reads the available block range and makes the boundaries of that history explicit.',
    detail: 'Launch history · Graduation · Observed outcomes',
  },
  {
    name: 'Holders',
    provider: 'Blockscout',
    title: 'Ownership needs a closer look.',
    text: 'SEAL examines how supply is distributed, separating liquidity pools and burn addresses from holders. Concentration is an observation to explain, not a verdict.',
    detail: 'Supply distribution · Pool exclusions · Coverage limits',
  },
  {
    name: 'Market',
    provider: 'DexScreener',
    title: 'Activity is only part of the story.',
    text: 'Liquidity, volume and transactions are read together. SEAL looks at what they support, what they leave unanswered and where they contradict other observations.',
    detail: 'Liquidity · Trading activity · Cross-source context',
  },
] as const;

export function SourceStudy() {
  const [selected, setSelected] = useState(0);
  const item = perspectives[selected] ?? perspectives[0];
  return (
    <section id="method" className="perspectives" aria-labelledby="perspectives-title">
      <div className="perspectives-heading">
        <p className="eyebrow">Behind the analysis</p>
        <h2 id="perspectives-title">
          Different angles.
          <br />
          <em>A clearer picture.</em>
        </h2>
        <p>Three public sources. Read together, with their limitations in view.</p>
      </div>
      <div className="perspective-feature">
        <div className="lens-scene" aria-hidden="true" data-angle={selected}>
          <div className="lens-shadow" />
          <div className="lens lens-back" />
          <div className="lens lens-middle" />
          <div className="lens lens-front">
            <span>SEAL</span>
          </div>
          <span className="lens-caption">CONTEXT THROUGH CONNECTION</span>
        </div>
        <div className="perspective-content">
          <div className="perspective-controls" role="group" aria-label="Explore sources">
            {perspectives.map((p, i) => (
              <button
                key={p.name}
                type="button"
                aria-pressed={selected === i}
                aria-controls="source-study-detail"
                onClick={() => setSelected(i)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div id="source-study-detail" aria-live="polite">
            <p className="perspective-provider">{item.provider}</p>
            <h3>{item.title}</h3>
            <p>{item.text}</p>
            <p className="perspective-detail">{item.detail}</p>
          </div>
          <span className="method-caption">Method illustration · no token data displayed</span>
        </div>
      </div>
    </section>
  );
}
