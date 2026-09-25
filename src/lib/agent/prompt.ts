import type { TokenReport } from '../contracts';

/**
 * Le system prompt est un préfixe **stable** : il ne contient aucune donnée de
 * token, donc il reste identique d'une requête à l'autre et devient éligible au
 * prompt caching. Les données viennent après, dans le message utilisateur.
 *
 * Le ton est calibré sur le whitepaper : on décrit, on ne note pas, et on fait
 * ressortir les endroits où les signaux ne racontent pas la même histoire.
 */
export const SYSTEM_PROMPT = `Tu es SEAL, un agent qui analyse des tokens lancés sur le launchpad pons (Robinhood Chain).

Ton rôle est d'EXPLIQUER, pas de noter. Les outils existants produisent déjà des scores ; ta valeur est de croiser trois familles de signaux — l'historique du créateur, la concentration des détenteurs, l'état du marché — et de dire ce qu'ils racontent ensemble, surtout quand ils se contredisent.

Règles absolues :
- N'attribue JAMAIS de score, de note, de pourcentage de confiance ou d'étoiles.
- Ne dis JAMAIS si un token est un bon ou un mauvais investissement, s'il est sûr, s'il faut acheter, vendre ou éviter. Tu décris ce que tu observes ; la décision appartient au lecteur.
- N'invente aucune donnée. Si une source est absente ou partielle, dis-le explicitement et précise ce que cela empêche de conclure.
- Les chiffres factuels sont bienvenus (« 40 % de l'offre sur un seul wallet »), les chiffres d'évaluation ne le sont pas (« 7/10 »).

Structure ta réponse en trois parties courtes :
1. Ce qui est rassurant.
2. Ce qui mérite attention.
3. Là où les signaux divergent — c'est la partie la plus importante, ne la survole pas.

Si les données sont trop incomplètes pour dire quoi que ce soit d'utile, dis-le franchement plutôt que de meubler.

Écris en prose, sans jargon inutile, dans la langue de l'utilisateur. Reste factuel et nuancé.`;

/** Rend le rapport lisible par le modèle, en nommant explicitement les trous. */
export function renderReport(report: TokenReport): string {
  const lines: string[] = [];

  lines.push(`Token analysé : ${report.token}`);
  lines.push(`Collecté le : ${report.collectedAt}`);
  lines.push(`Complétude d'ensemble : ${report.completeness}`);
  lines.push('');

  lines.push('## Historique du créateur');
  lines.push(`Complétude : ${report.creator.completeness}`);
  for (const source of report.creator.sources) {
    if (source.note) lines.push(`Limite : ${source.note}`);
  }
  const c = report.creator.data;
  lines.push(`Créateur : ${c.creator}`);
  lines.push(
    `Tokens lancés sur la fenêtre observée : ${c.counts.launched} — dont ${c.counts.graduated} gradués, ${c.counts.abandoned} abandonnés.`,
  );
  for (const token of c.tokens.slice(0, 10)) {
    lines.push(
      `- ${token.address} : ${token.outcome}, progression ${(token.graduationProgress * 100).toFixed(2)} %` +
        (token.liquidityPulled === null ? ' (retrait de liquidité : non déterminé)' : ''),
    );
  }
  lines.push('');

  lines.push('## Concentration des détenteurs');
  lines.push(`Complétude : ${report.holders.completeness}`);
  for (const source of report.holders.sources) {
    if (source.note) lines.push(`Limite : ${source.note}`);
  }
  const h = report.holders.data;
  lines.push(`Part du premier détenteur : ${(h.concentration.top1 * 100).toFixed(2)} %`);
  lines.push(`Part cumulée du top 10 : ${(h.concentration.top10 * 100).toFixed(2)} %`);
  lines.push('(Le pool de liquidité et les adresses de burn sont exclus de ces parts.)');
  lines.push('');

  lines.push('## État du marché');
  lines.push(`Complétude : ${report.market.completeness}`);
  for (const source of report.market.sources) {
    if (source.note) lines.push(`Limite : ${source.note}`);
  }
  const m = report.market.data;
  lines.push(`Prix : ${m.priceUsd === null ? 'inconnu' : `${m.priceUsd} USD`}`);
  lines.push(`Liquidité : ${m.liquidityUsd === null ? 'inconnue' : `${m.liquidityUsd} USD`}`);
  if (m.graduation) {
    lines.push(
      `Graduation : ${(m.graduation.progress * 100).toFixed(2)} % du seuil de ${m.graduation.thresholdEth} ETH` +
        (m.graduation.graduated ? ' — seuil atteint' : ''),
    );
  } else {
    lines.push('Graduation : non déterminée');
  }
  if (m.volumeUsd && m.txns) {
    const trades = m.txns.h24.buys + m.txns.h24.sells;
    lines.push(
      `Volume 24 h : ${m.volumeUsd.h24} USD réparti sur ${trades} échanges (${m.txns.h24.buys} achats, ${m.txns.h24.sells} ventes).`,
    );
  } else {
    lines.push('Volume : non disponible');
  }

  return lines.join('\n');
}
