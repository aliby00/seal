import type { AnalyzeResponse } from '../api/analyze/route';
import { Explanation } from './Explanation';

const labels: Record<string, string> = {
  full: 'Toutes les sources ont répondu.',
  partial: 'Une lecture partielle.',
  unavailable: 'Aucune source exploitable.',
};
export function AnalysisReport({ result }: { result: AnalyzeResponse }) {
  return (
    <article className="report" aria-labelledby="report-title">
      <header className="report-header">
        <span className="eyebrow">La lecture de SEAL</span>
        <h2 id="report-title">Ce que les données racontent.</h2>
        <p className="token-address">{result.token}</p>
      </header>
      <section
        className={`completeness completeness-${result.completeness}`}
        aria-label="Disponibilité des données"
      >
        <h3>{labels[result.completeness] ?? 'Disponibilité des données non précisée.'}</h3>
        {result.completeness === 'partial' && (
          <p>Certaines observations sont incomplètes. Ces limites font partie de la lecture.</p>
        )}
        {result.completeness === 'unavailable' && (
          <p>
            Les données disponibles ne permettent pas de construire une analyse. L’absence de
            données ne permet aucune conclusion sur ce token.
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
        <section className="offline-note" aria-label="Mode hors-ligne">
          <h3>Mode hors-ligne</h3>
          <p>Les faits sont restitués sans être croisés par l’agent de raisonnement.</p>
        </section>
      )}
      <div className="reading-layout">
        <Explanation text={result.explanation} offline={result.offline} />
        <aside className="sources" aria-label="Sources du rapport">
          <details open>
            <summary>
              Sources & limites{' '}
              <span aria-hidden="true" className="details-symbol">
                +
              </span>
            </summary>
            <p className="sources-intro">Sources du rapport dans son ensemble.</p>
            {result.sources.length === 0 && <p>Aucune source renseignée.</p>}
            {result.sources.map((source, index) => (
              <div className="source" key={`${source.name}-${index}`}>
                <h3>{source.name}</h3>
                <p>{source.note ?? 'Aucune limite signalée par cette source.'}</p>
              </div>
            ))}
          </details>
        </aside>
      </div>
      <footer className="report-footer">
        <p>
          Analysé le{' '}
          <time dateTime={result.collectedAt}>
            {new Date(result.collectedAt).toLocaleString('fr-FR', {
              dateStyle: 'long',
              timeStyle: 'short',
            })}
          </time>
        </p>
        <p>
          {result.offline
            ? 'aucun coût : aucun appel au modèle'
            : `Coût de cette requête : ${result.costUsd.toFixed(4)} $`}
        </p>
      </footer>
    </article>
  );
}
