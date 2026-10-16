'use client';

import { useRef, type CSSProperties } from 'react';
import type { SpecialistAnswer } from '@/lib/specialists/brief';
import { SignalBadge } from './signals';

/**
 * The ten questions, one tile each, always in the same order. A tile is read
 * on its own: there is no total, no count of answers per kind, no ranking.
 */
export function SpecialistsPanel({ answers }: { answers: SpecialistAnswer[] }) {
  const grid = useRef<HTMLDivElement>(null);
  const setAll = (open: boolean) =>
    grid.current?.querySelectorAll('details').forEach((d) => {
      d.open = open;
    });

  return (
    <section className="questions" aria-labelledby="questions-title">
      <div className="report-section-head">
        <p className="report-kicker">02 — Ten questions</p>
        <h3 id="questions-title">Asked of every token, answered one by one.</h3>
        <p className="questions-intro">
          Each specialist reads the chain for one question. The answers are not added up: each tile
          stands on its own, with what it could not see.
        </p>
        <div className="questions-tools">
          <button type="button" className="text-link" onClick={() => setAll(true)}>
            Open all
          </button>
          <button type="button" className="text-link" onClick={() => setAll(false)}>
            Close all
          </button>
        </div>
      </div>
      <div className="question-grid" ref={grid}>
        {answers.map((answer, i) => (
          <details
            key={answer.specialist}
            className="question-tile"
            data-signal={answer.signal}
            style={{ '--i': i } as CSSProperties}
          >
            <summary>
              <span className="question-top">
                <span className="question-title">{answer.title}</span>
                <SignalBadge signal={answer.signal} />
              </span>
              <span className="question-text">{answer.question}</span>
              {answer.facts[0] && <span className="question-preview">{answer.facts[0]}</span>}
              {!answer.facts[0] && answer.limits[0] && (
                <span className="question-preview">{answer.limits[0]}</span>
              )}
              <span className="question-more" aria-hidden="true" />
            </summary>
            <div className="question-body">
              {answer.facts.length > 0 && (
                <>
                  <h4>What was read</h4>
                  <ul>
                    {answer.facts.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </>
              )}
              {answer.limits.length > 0 && (
                <>
                  <h4>What it could not see</h4>
                  <ul className="question-limits">
                    {answer.limits.map((limit) => (
                      <li key={limit}>{limit}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
