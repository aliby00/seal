import { AnalyzeForm } from './AnalyzeForm';
import { Disclaimer } from './components/Disclaimer';

// The environment label follows the deployment, including promoted builds.
export const dynamic = 'force-dynamic';

export default function Home() {
  const environment = process.env.SEAL_ENV ?? 'development';
  return (
    <div className="site-shell">
      <a href="#analysis" className="skip-link">
        Aller à l’analyse
      </a>
      <header className="masthead">
        <a href="/" className="wordmark" aria-label="SEAL, accueil">
          seal<span aria-hidden="true">.</span>
        </a>
        <span className="masthead-caption">Une lecture de la chaîne.</span>
        <nav aria-label="Navigation principale">
          <a href="#method">La méthode</a>
          <a href="https://github.com/aliby00/seal">
            Le projet <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main id="analysis">
        <div className="edition-line">
          <span>Pons / Robinhood Chain</span>
          {environment !== 'production' ? (
            <span>Environnement : {environment}</span>
          ) : (
            <span>Analyse de tokens</span>
          )}
        </div>
        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow">Les faits. Leur contexte.</p>
          <h1 id="hero-title">
            Derrière un token,
            <br /> <em>une histoire à lire.</em>
          </h1>
          <p className="hero-description">
            SEAL croise le créateur, les détenteurs et le marché pour expliquer ce que les signaux
            racontent. Une analyse en prose, jamais une note.
          </p>
        </section>
        <AnalyzeForm />
        <section id="method" className="method" aria-labelledby="method-title">
          <div className="section-heading">
            <span className="eyebrow">La méthode</span>
            <h2 id="method-title">Lire ensemble ce qui paraît séparé.</h2>
          </div>
          <div className="method-columns">
            <div>
              <span className="index">01 / Le créateur</span>
              <h3>Ce qui précède.</h3>
              <p>
                Les lancements précédents et leur devenir, dans la fenêtre d’historique disponible.
              </p>
            </div>
            <div>
              <span className="index">02 / Les détenteurs</span>
              <h3>Ce qui se concentre.</h3>
              <p>
                La répartition de l’offre, en distinguant les portefeuilles du pool et des adresses
                de burn.
              </p>
            </div>
            <div>
              <span className="index">03 / Le marché</span>
              <h3>Ce qui s’échange.</h3>
              <p>
                La liquidité, le volume et les transactions, remis en contexte les uns avec les
                autres.
              </p>
            </div>
          </div>
          <p className="method-note">
            Le raisonnement commence là où ces observations se rencontrent — et parfois se
            contredisent. Une donnée manquante reste une limite explicite.
          </p>
        </section>
        <Disclaimer />
      </main>
      <footer className="site-footer">
        <span className="footer-brand">seal.</span>
        <p>Des données publiques. Une lecture qui s’explique.</p>
        <a href="#analysis">Retour à l’analyse ↑</a>
      </footer>
    </div>
  );
}
