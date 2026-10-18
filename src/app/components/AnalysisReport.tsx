import { buildGlance } from '@/lib/glance';
import type { AnalyzeResponse } from '../api/analyze/route';
import { AtAGlance } from './AtAGlance';
import { Explanation } from './Explanation';
import { FactsBoard, plainNote } from './FactsBoard';
import { LaunchReplay } from './LaunchReplay';
import { ReportHeader } from './ReportHeader';
import { SpecialistsPanel } from './SpecialistsPanel';
import { SupplyFlow } from './SupplyFlow';

const labels: Record<string, string> = {
  full: 'All sources responded.',
  partial: 'A partial picture.',
  unavailable: 'No usable sources.',
};

/**
 * The report, top to bottom: who the token is, the few facts to know in ten
 * seconds, the written reading, then every measure in full. Nothing is scored
 * and nothing is summed: every block reads on its own.
 */
export function AnalysisReport({ result }: { result: AnalyzeResponse }) {
  const glance = buildGlance(result);
  const replay = Boolean(result.launch && result.launch.moves.length > 0);
  // Sections are numbered in reading order; the replay only exists for some tokens.
  const number = (n: number) => String(n).padStart(2, '0');
  return (
    <article className="report" aria-labelledby="report-title">
      <ReportHeader result={result} />
      {glance && <AtAGlance glance={glance} />}
      {/* Where the supply went comes right after the summary: what the rest is read against. */}
      {result.facts?.supplyFlow && (
        <SupplyFlow flow={result.facts.supplyFlow} creator={result.facts.creator.address} />
      )}
      {/* The summary already lists what was not measured; the banner stays for the other cases. */}
      {(!glance || result.completeness === 'unavailable') && (
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
      )}
      <section className="reading-section" aria-labelledby="reading-title">
        <div className="report-section-head">
          <p className="report-kicker">{number(1)} — Reading</p>
          <h3 id="reading-title">How the facts fit together.</h3>
        </div>
        {/* A note on how the text was made, kept with the text rather than at the top. */}
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
                  <p>{plainNote(source.note) ?? 'No limitations reported by this source.'}</p>
                </div>
              ))}
            </details>
          </aside>
        </div>
      </section>
      {result.facts && (
        <FactsBoard facts={result.facts} timeline={result.timeline} index={number(2)} />
      )}
      {replay && result.launch && (
        <LaunchReplay
          launch={result.launch}
          index={number(3)}
          hasFlow={Boolean(result.facts?.supplyFlow)}
          names={Object.fromEntries(
            (result.facts?.roles ?? []).map((r) => [r.address.toLowerCase(), r.name]),
          )}
        />
      )}
      {result.specialists && result.specialists.length > 0 && (
        <SpecialistsPanel answers={result.specialists} index={number(replay ? 4 : 3)} />
      )}
      <footer className="report-footer">
        <p>
          Analyzed on{' '}
          <time dateTime={result.collectedAt}>
            {new Date(result.collectedAt).toLocaleString('en-US', {
              dateStyle: 'long',
              // 'long' carries the time zone; timeZoneName cannot be combined with timeStyle.
              timeStyle: 'long',
            })}
          </time>
        </p>
        <p>
          {result.cached
            ? 'Served again from a reading made minutes ago: no new cost.'
            : result.offline
              ? 'No cost: no model call.'
              : `Request cost: $${result.costUsd.toFixed(4)}`}
        </p>
      </footer>
    </article>
  );
}
