'use client';
import { useState } from 'react';

const perspectives = [
  {
    name: 'Creator',
    provider: 'Robinhood RPC',
    title: 'The history behind the address.',
    text: 'SEAL looks back at the creator’s previous launches and their observed outcomes. A new token is read in the context of what came before it.',
    facts: ['Previous token launches', 'Graduation and observed outcomes'],
    limit: 'Only the scanned block range is covered. Earlier activity may be missing.',
    question: 'What has this creator launched before?',
    reading:
      'A creator’s previous launches add context. They do not establish what will happen to this token.',
    connection: 'Read alongside the current ownership and market activity.',
  },
  {
    name: 'Holders',
    provider: 'Blockscout',
    title: 'Look beyond the wallet count.',
    text: 'SEAL examines how supply is distributed and distinguishes liquidity pools and burn addresses from holders. The explanation makes that distinction visible.',
    facts: ['Supply distribution across holders', 'Liquidity pool and burn exclusions'],
    limit: 'Unavailable or incomplete holder data is disclosed before the explanation.',
    question: 'Who holds the supply, and what is excluded?',
    reading:
      'Concentrated ownership needs context. A liquidity pool and an individual holder do not mean the same thing.',
    connection: 'Read alongside liquidity and the creator’s observed history.',
  },
  {
    name: 'Market',
    provider: 'DexScreener',
    title: 'Activity is a starting point.',
    text: 'SEAL reads liquidity, volume and transactions together. It explains what those observations support and what they cannot tell you on their own.',
    facts: ['Available liquidity and trading volume', 'Transactions and market activity'],
    limit: 'Market observations describe the collection time, not what comes next.',
    question: 'What does the activity actually explain?',
    reading:
      'An active market does not explain who controls the supply. Those observations need to be read together.',
    connection: 'Read alongside ownership distribution and source coverage.',
  },
] as const;

export function SourceStudy() {
  const [selected, setSelected] = useState(0);
  const item = perspectives[selected] ?? perspectives[0];
  return (
    <section id="method" className="perspectives" aria-labelledby="perspectives-title">
      <div className="perspectives-heading">
        <p className="eyebrow">Inside a SEAL reading</p>
        <h2 id="perspectives-title">
          The facts are a beginning.
          <br />
          <em>The connection is the point.</em>
        </h2>
        <p>
          One token address. Three public sources. A written explanation of what agrees, what
          differs and what is still unknown.
        </p>
      </div>
      <div className="method-workbench">
        <div className="method-narrative">
          <p className="method-kicker">01 — Examine the evidence</p>
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
            <ul className="method-facts">
              {item.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
            <div className="method-boundary">
              <span>The boundary of this source</span>
              <p>{item.limit}</p>
            </div>
          </div>
          <a className="method-try" href="#analysis">
            Start with a token address <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="method-preview">
          <div className="evidence-inbox" aria-hidden="true">
            {perspectives.map((p, i) => (
              <span key={p.name} data-selected={selected === i}>
                {p.provider}
                <span>↘</span>
              </span>
            ))}
          </div>
          <div className="reading-sheet" key={item.name}>
            <div className="reading-sheet-header">
              <span>✳ SEAL</span>
              <span>A REASONED READING</span>
            </div>
            <p className="sheet-eyebrow">02 — Put the facts in context</p>
            <h3>{item.question}</h3>
            <p className="sheet-prose">{item.reading}</p>
            <div className="sheet-connection">
              <span>Where the signals meet</span>
              <p>{item.connection}</p>
            </div>
            <div className="sheet-footer">
              <span>Sources & their limits</span>
              <span>Included with every report ↗</span>
            </div>
          </div>
          <span className="method-caption">Method illustration · no token data displayed</span>
        </div>
      </div>
      <div className="method-takeaway">
        <span className="method-kicker">03 — Keep the nuance</span>
        <h3>
          A reason to understand.
          <br />
          <em>Not a number to follow.</em>
        </h3>
        <p>
          The report explains reassuring observations, points that deserve attention and where the
          signals diverge. Missing evidence stays visible. In offline mode, facts are presented
          without model interpretation.
        </p>
      </div>
    </section>
  );
}
