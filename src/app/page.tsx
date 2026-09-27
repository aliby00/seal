import { AnalyzeForm } from './AnalyzeForm';
import { Disclaimer } from './components/Disclaimer';
import { ImmersiveEntrance } from './components/ImmersiveEntrance';

// The environment label follows the deployment, including promoted builds.
export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <ImmersiveEntrance environment={process.env.SEAL_ENV ?? 'development'}>
      <AnalyzeForm />
      <div className="reading-notes">
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
      </div>
    </ImmersiveEntrance>
  );
}
