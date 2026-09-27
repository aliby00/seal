export function Disclaimer() {
  return (
    <section className="disclaimers" aria-labelledby="limits-title">
      <div className="section-heading">
        <span className="eyebrow">Les limites, au grand jour</span>
        <h2 id="limits-title">Ce que cette lecture ne promet pas.</h2>
      </div>
      <div className="disclaimer-list">
        <p>
          <strong>Ce n’est pas un conseil financier.</strong> SEAL décrit les données publiques
          qu’il observe. Il ne recommande aucun achat ni aucune vente et n’attribue aucune note.
        </p>
        <p>
          <strong>Ce n’est pas un audit de contrat.</strong> L’analyse porte sur les comportements
          du créateur, des détenteurs et du marché, pas sur le bytecode du contrat.
        </p>
        <p>
          <strong>L’agent n’est pas déterministe.</strong> Deux lectures du même token peuvent
          différer dans leur formulation. L’explication doit toujours être lue avec ses sources et
          ses limites.
        </p>
      </div>
    </section>
  );
}
