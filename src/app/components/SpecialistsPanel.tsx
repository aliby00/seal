'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import type { FunderKind } from '@/lib/chain/funder-kind';
import type { SpecialistAnswer } from '@/lib/specialists/brief';
import type { FundingPathStep } from '@/lib/specialists/types';
import { SignalBadge } from './signals';

const KIND_LABEL: Record<FunderKind, string> = {
  wallet: 'wallet',
  service: 'high-volume service',
  tool: 'batch-sending tool',
  unknown: 'not identified',
};

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Who funded the creator, then who funded that wallet, up to three steps. */
function FundingPath({ path }: { path: FundingPathStep[] }) {
  return (
    <>
      <h4>Funding path</h4>
      <ol className="funding-path">
        {path.map((step, i) => (
          <li key={`${step.address}-${i}`}>
            <span className="funding-path-step">{i === 0 ? 'Creator funded by' : 'Funded by'}</span>{' '}
            <code title={step.address}>{shortAddress(step.address)}</code>{' '}
            <span className="funding-path-kind">
              {KIND_LABEL[step.kind]}
              {step.name ? ` (${step.name})` : ''}
              {step.txCount !== null
                ? `, ${step.txCount.toLocaleString('en-US')} transactions`
                : ''}
            </span>
            {step.via && (
              <span className="funding-path-via">
                {' '}
                through the batch-sending tool{' '}
                <code title={step.via.address}>{shortAddress(step.via.address)}</code>
                {step.via.name ? ` (${step.via.name})` : ''}
              </span>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * The ten questions, one tile each, always in the same order. A tile is read
 * on its own: there is no total, no count of answers per kind, no ranking.
 */
export function SpecialistsPanel({
  answers,
  index = '02',
}: {
  answers: SpecialistAnswer[];
  /** Section number: the launch replay, when shown, comes before. */
  index?: string;
}) {
  const grid = useRef<HTMLDivElement>(null);
  // A link to a question (from the summary) opens its tile.
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id.startsWith('question-')) return;
      const tile = document.getElementById(id);
      if (tile instanceof HTMLDetailsElement) tile.open = true;
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);
  const setAll = (open: boolean) =>
    grid.current?.querySelectorAll('details').forEach((d) => {
      d.open = open;
    });

  return (
    <section className="questions" aria-labelledby="questions-title">
      <div className="report-section-head">
        <p className="report-kicker">{index} — Ten questions</p>
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
            id={`question-${answer.specialist}`}
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
              {answer.funding && answer.funding.path.length > 0 && (
                <FundingPath path={answer.funding.path} />
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
