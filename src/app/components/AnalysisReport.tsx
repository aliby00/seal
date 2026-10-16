import type { AnalyzeResponse } from '../api/analyze/route';
import { Explanation } from './Explanation';
import { FactsBoard } from './FactsBoard';
import { ReportHeader } from './ReportHeader';
import { SpecialistsPanel } from './SpecialistsPanel';

const labels: Record<string, string> = {
  full: 'All sources responded.',
  partial: 'A partial picture.',
  unavailable: 'No usable sources.',
};

/**
 * The report, top to bottom: who the token is and what could be read, the
 * measured numbers, the ten questions, then the written reading. Nothing is
 * scored and nothing is summed: every block reads on its own.
 */
export function AnalysisReport({ result }: { result: AnalyzeResponse }) {
  return (
    <article className="report" aria-labelledby="report-title">
      <ReportHeader result={result} />
      <section
        className={`completeness completeness-${result.completeness}`}
        aria-label="Data availability"
      >
        <h3>{labels[result.completeness] ?? 'Data availability was not specified.'}</h3>
        {result.completeness === 'partial' && (
          <p>Some observations are incomplete. These limitations are part of the analysis.</p>
        )}
        {result.completeness === 'unavailable' && (
          <p>
            The available data cannot support an analysis. Missing data does not justify any
            conclusion about this token.
          </p>
        )}
        {/* With the cards, each limit is shown once, on the card it concerns. */}
        {!result.facts &&
          result.sources
            .filter((source) => source.note)
            .map((source, index) => (
              <p className="source-limit" key={`${source.name}-${index}`}>
                <strong>{source.name}</strong> — {source.note}
              </p>
            ))}
      </section>
      {result.offline && (
        <section className="offline-note" aria-label="Offline mode">
          <h3>Offline mode</h3>
          <p>Facts are presented without being cross-examined by the reasoning agent.</p>
        </section>
      )}
      {result.facts && <FactsBoard facts={result.facts} timeline={result.timeline} />}
      {result.specialists && result.specialists.length > 0 && (
        <SpecialistsPanel answers={result.specialists} />
      )}
      <section className="reading-section" aria-labelledby="reading-title">
        <div className="report-section-head">
          <p className="report-kicker">03 — Reading</p>
          <h3 id="reading-title">How the facts fit together.</h3>
        </div>
        <div className="reading-layout">
          <Explanation text={result.explanation} offline={result.offline} />
          <aside className="sources" aria-label="Report sources">
            <details open>
              <summary>
                Sources & limitations{' '}
                <span aria-hidden="true" className="details-symbol">
                  +
                </span>
              </summary>
              <p className="sources-intro">Sources apply to the report as a whole.</p>
              {result.sources.length === 0 && <p>No sources provided.</p>}
              {result.sources.map((source, index) => (
                <div className="source" key={`${source.name}-${index}`}>
                  <h3>{source.name}</h3>
                  <p>{source.note ?? 'No limitations reported by this source.'}</p>
                </div>
              ))}
            </details>
          </aside>
        </div>
      </section>
      <footer className="report-footer">
        <p>
          Analyzed on{' '}
          <time dateTime={result.collectedAt}>
            {new Date(result.collectedAt).toLocaleString('en-US', {
              dateStyle: 'long',
              timeStyle: 'short',
            })}
          </time>
        </p>
        <p>
          {result.cached
            ? 'Served again from a reading made minutes ago: no new cost.'
            : result.offline
              ? 'no cost: no model call'
              : `Request cost: ${result.costUsd.toFixed(4)} $`}
        </p>
      </footer>
    </article>
  );
}
