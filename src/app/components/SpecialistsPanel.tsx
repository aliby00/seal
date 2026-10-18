'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import type { FunderKind } from '@/lib/chain/funder-kind';
import type { SpecialistAnswer } from '@/lib/specialists/brief';
import type { FundingPathStep } from '@/lib/specialists/types';
import { describeService } from '@/lib/specialists/names';
import { PLAIN_LABEL, shortAnswer } from '@/lib/specialists/plain';
import { SIGNAL_LABEL } from './signal-labels';
import { SignalIcon } from './signals';

const KIND_LABEL: Record<FunderKind, string> = {
  wallet: 'wallet',
  service: 'service or contract',
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
              {step.kind === 'service' ? (
                describeService(step.name, step.txCount)
              ) : (
                <>
                  {KIND_LABEL[step.kind]}
                  {step.name ? ` (${step.name})` : ''}
                  {step.txCount !== null
                    ? `, ${step.txCount.toLocaleString('en-US')} transactions`
                    : ''}
                </>
              )}
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

function Details({ answer }: { answer: SpecialistAnswer }) {
  return (
    <div className="question-body">
      <p className="question-asked">{answer.question}</p>
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
  );
}

/**
 * The ten questions as one checklist, always in the same order: a plain name,
 * a one-line answer, the detail on demand. Questions nothing could be read for
 * are gathered at the end so they do not drown the answers. There is no total
 * and no ranking.
 */
export function SpecialistsPanel({
  answers,
  index = '02',
}: {
  answers: SpecialistAnswer[];
  /** Section number: the launch replay, when shown, comes before. */
  index?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  // A link to a question (from the summary) opens it, and its group if folded.
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id.startsWith('question-')) return;
      const row = document.getElementById(id);
      if (row instanceof HTMLDetailsElement) row.open = true;
      const group = row?.parentElement?.closest('details');
      if (group) group.open = true;
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);

  const measured = answers.filter((a) => a.signal !== 'unknown');
  // A question that does not apply is no gap in the data: said apart.
  const notApplicable = answers.filter((a) => a.signal === 'unknown' && a.notApplicable);
  const unmeasured = answers.filter((a) => a.signal === 'unknown' && !a.notApplicable);

  return (
    <section className="questions" aria-labelledby="questions-title">
      <div className="report-section-head">
        <p className="report-kicker">{index} — Ten checks</p>
        <h3 id="questions-title">Ten checks, in plain words.</h3>
        <p className="questions-intro">
          Each line reads one thing on the chain. Open a line to see exactly what was read.
        </p>
      </div>
      <div className="check-list" ref={list}>
        {measured.map((answer, i) => (
          <details
            key={answer.specialist}
            id={`question-${answer.specialist}`}
            className="check-row"
            data-signal={answer.signal}
            style={{ '--i': i } as CSSProperties}
          >
            <summary>
              <span className="check-icon" data-signal={answer.signal}>
                <SignalIcon signal={answer.signal} />
              </span>
              <span className="check-name">{PLAIN_LABEL[answer.specialist]}</span>
              <span className="check-answer">{shortAnswer(answer)}</span>
              <span className="check-tag" data-signal={answer.signal}>
                {SIGNAL_LABEL[answer.signal]}
              </span>
            </summary>
            <Details answer={answer} />
          </details>
        ))}
        {notApplicable.length > 0 && (
          <details className="check-row check-unmeasured" data-signal="unknown">
            <summary>
              <span className="check-icon" data-signal="quiet">
                <SignalIcon signal="quiet" />
              </span>
              <span className="check-name">Does not apply to this token</span>
              <span className="check-answer">
                {notApplicable.map((a) => PLAIN_LABEL[a.specialist]).join(' · ')}
              </span>
            </summary>
            <div className="check-sublist">
              {notApplicable.map((answer) => (
                <details
                  key={answer.specialist}
                  id={`question-${answer.specialist}`}
                  className="check-subrow"
                >
                  <summary>
                    <span className="check-name">{PLAIN_LABEL[answer.specialist]}</span>
                    <span className="check-answer">{shortAnswer(answer)}</span>
                  </summary>
                  <Details answer={answer} />
                </details>
              ))}
            </div>
          </details>
        )}
        {unmeasured.length > 0 && (
          <details className="check-row check-unmeasured" data-signal="unknown">
            <summary>
              <span className="check-icon" data-signal="unknown">
                <SignalIcon signal="unknown" />
              </span>
              <span className="check-name">Not measured for this token</span>
              <span className="check-answer">
                {unmeasured.map((a) => PLAIN_LABEL[a.specialist]).join(' · ')}
              </span>
            </summary>
            <div className="check-sublist">
              {unmeasured.map((answer) => (
                <details
                  key={answer.specialist}
                  id={`question-${answer.specialist}`}
                  className="check-subrow"
                >
                  <summary>
                    <span className="check-name">{PLAIN_LABEL[answer.specialist]}</span>
                    <span className="check-answer">{shortAnswer(answer)}</span>
                  </summary>
                  <Details answer={answer} />
                </details>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
