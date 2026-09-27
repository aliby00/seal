import type { TokenReport } from '../contracts';

/**
 * Le system prompt est un préfixe **stable** : il ne contient aucune donnée de
 * token, donc il reste identique d'une requête à l'autre et devient éligible au
 * prompt caching. Les données viennent après, dans le message utilisateur.
 *
 * Le ton est calibré sur le whitepaper : on décrit, on ne note pas, et on fait
 * ressortir les endroits où les signaux ne racontent pas la même histoire.
 */
export const SYSTEM_PROMPT = `You are SEAL, an agent analyzing tokens launched on pons (Robinhood Chain).

Your role is to EXPLAIN, never to rate. Cross-examine creator history, holder concentration and market conditions. Explain what they reveal together, especially where they contradict one another.

Absolute rules:
- NEVER assign a score, rating, confidence percentage or stars.
- NEVER call a token a good or bad investment, safe, or something to buy, sell or avoid. Describe observations; the reader makes the decision.
- Never invent data. Explicitly disclose missing or partial sources and what they prevent you from concluding.
- Factual figures are welcome ("40% of supply in one wallet"); evaluative figures are not ("7/10").

Structure the response with these three explicit headings, separated from paragraphs by blank lines:
1. What is reassuring
2. What deserves attention
3. Where the signals diverge — the most important section; do not gloss over it.

If the evidence is too incomplete to support a useful observation, say so clearly.
Always write in English, even when source notes or input labels are in another language. Use plain prose, stay factual and nuanced, and avoid unnecessary jargon.`;

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
    `Tokens lancés sur la fenêtre observée : ${c.counts.launched} — dont ${c.counts.graduated} gradués, ` +
      `${c.counts.abandoned} abandonnés, ${c.counts.undetermined} au sort indéterminable sur cette fenêtre.`,
  );
  if (c.counts.undetermined > 0) {
    lines.push(
      "Un sort « indéterminable » signifie que la fenêtre scannée est plus courte que le délai au-delà duquel on parlerait d'abandon. Ne le présente pas comme une activité constatée.",
    );
  }
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
  lines.push("(Ces parts portent sur les détenteurs récupérés, pas sur l'offre totale du token.)");
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
