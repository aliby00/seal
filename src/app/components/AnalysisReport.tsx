import type { AnalyzeResponse } from '../api/analyze/route';
import { Explanation } from './Explanation';

const labels: Record<string, string> = {
  full: 'All sources responded.',
  partial: 'A partial picture.',
  unavailable: 'No usable sources.',
};
export function AnalysisReport({ result }: { result: AnalyzeResponse }) {
  return (
    <article className="report" aria-labelledby="report-title">
      <header className="report-header">
        <span className="eyebrow">SEAL Research</span>
        <h2 id="report-title">What the evidence says.</h2>
        <p className="token-address">{result.token}</p>
      </header>
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
        {result.sources
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
          {result.offline
            ? 'no cost: no model call'
            : `Request cost: ${result.costUsd.toFixed(4)} $`}
        </p>
      </footer>
    </article>
  );
}
