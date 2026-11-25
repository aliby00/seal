import { buildGlance } from '@/lib/glance';
import type { AnalyzeResponse } from '../api/analyze/route';
import { AtAGlance } from './AtAGlance';
import { Explanation } from './Explanation';
import { FactsBoard, namesOf, plainNote } from './FactsBoard';
import { LaunchReplay } from './LaunchReplay';
import { sourceLimits, sourceName } from './report-sources';
import { ReportHeader } from './ReportHeader';
import { SolanaFacts } from './SolanaFacts';
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
  // Said once: the note above the text says it was written offline, the summary
  // says which reads failed. The text itself keeps both for the API.
  const reading = result.explanation
    .split(/\n\s*\n/)
    .filter(
      (block, i) =>
        !(result.offline && i === 0 && /^This account is produced without/.test(block)) &&
        !(glance?.partial && /^Partial report:/.test(block.trim())),
    )
    .join('\n\n');
  // Sections are numbered in reading order; the Solana blocks and the replay
  // only exist for some responses.
  const sections = [
    ...(result.facts ? ['facts'] : []),
    ...(result.solana ? ['solana'] : []),
    ...(replay ? ['replay'] : []),
    'questions',
  ];
  const number = (section: string) => String(sections.indexOf(section) + 2).padStart(2, '0');
  const factsIndex = number('facts');
  const solanaIndex = number('solana');
  const replayIndex = number('replay');
  const questionsIndex = number('questions');
  return (
    <article className="report" aria-labelledby="report-title">
      <ReportHeader result={result} headline={glance?.items[0]?.title} />
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
                  <strong>{sourceName(source.name)}</strong> — {source.note}
                </p>
              ))}
        </section>
      )}
      <section className="reading-section" aria-labelledby="reading-title">
        <div className="report-section-head">
          <p className="report-kicker">01 — Reading</p>
          <h3 id="reading-title">How the facts fit together.</h3>
        </div>
        {/* A note on how the text was made, kept with the text rather than at the top. */}
        {result.offline && (
          <section className="offline-note" aria-label="Facts only">
            <h3>Facts only</h3>
            <p>Written from the facts alone: the explanation model was not used this time.</p>
          </section>
        )}
        <div className="reading-layout">
          <Explanation text={reading} offline={result.offline} />
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
              {/* One entry per source, every limit its reads reported, partial reads included. */}
              {sourceLimits(result.sources, result.solana, plainNote).map((group) => (
                <div className="source" key={group.source}>
                  <h3>{group.name}</h3>
                  {group.limits.length === 0 ? (
                    <p>No limitations reported by this source.</p>
                  ) : (
                    group.limits.map((limit) => <p key={limit}>{limit}</p>)
                  )}
                </div>
              ))}
            </details>
          </aside>
        </div>
      </section>
      {result.facts && (
        <FactsBoard
          facts={result.facts}
          timeline={result.timeline}
          solana={result.solana}
          index={factsIndex}
        />
      )}
      {result.solana && <SolanaFacts view={result.solana} index={solanaIndex} />}
      {replay && result.launch && (
        <LaunchReplay
          launch={result.launch}
          index={replayIndex}
          hasFlow={Boolean(result.facts?.supplyFlow)}
          names={namesOf(result.solana)}
          partial={result.solana ? result.solana.launch.read !== 'full' : false}
        />
      )}
      {result.specialists && result.specialists.length > 0 && (
        <SpecialistsPanel answers={result.specialists} index={questionsIndex} />
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
      </footer>
    </article>
  );
}
