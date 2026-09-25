/**
 * Les trois avertissements viennent de la section « Risks We Are Not Hiding »
 * du whitepaper. Ils sont affichés, pas repliés derrière un lien : le document
 * public en fait un argument, pas une précaution juridique.
 */
export function Disclaimer() {
  return (
    <section
      aria-label="Avertissements"
      style={{
        marginTop: '3rem',
        paddingTop: '1.5rem',
        borderTop: '1px solid var(--line)',
        color: 'var(--muted)',
        fontSize: '0.8125rem',
        lineHeight: 1.7,
      }}
    >
      <p style={{ margin: '0 0 0.75rem' }}>
        <strong>Ce n&apos;est pas un conseil financier.</strong> SEAL décrit ce qu&apos;il observe
        dans des données publiques. Il ne dit pas si un token est un bon ou un mauvais
        investissement, et n&apos;attribue aucune note.
      </p>
      <p style={{ margin: '0 0 0.75rem' }}>
        <strong>Ce n&apos;est pas un audit de contrat.</strong> L&apos;analyse porte sur des signaux
        de comportement — créateur, détenteurs, marché — pas sur le bytecode. Elle reste
        complémentaire des outils qui vérifient la logique du contrat, pas leur remplaçante.
      </p>
      <p style={{ margin: 0 }}>
        <strong>L&apos;agent n&apos;est pas déterministe.</strong> Deux lectures du même token à
        quelques minutes d&apos;intervalle peuvent être formulées différemment. C&apos;est le
        contrepoids assumé d&apos;une explication face à un score, parfaitement reproductible mais
        muet sur la nuance.
      </p>
    </section>
  );
}
