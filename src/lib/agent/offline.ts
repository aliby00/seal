import type { TokenReport } from '../contracts';
import { volumePerTrade } from '../market';

/**
 * Explication produite sans appel au modèle.
 *
 * Elle existe pour deux raisons.
 *
 * D'abord pour que le produit soit testable gratuitement : tout le pipeline de
 * données est gratuit (RPC public, DexScreener sans clé, Blockscout en tier
 * gratuit), seule l'explication coûte. Sans ce mode, on ne peut rien essayer
 * sans payer.
 *
 * Ensuite parce qu'une source indisponible ne doit jamais rendre le produit
 * muet. Si l'API est en panne ou le quota épuisé, mieux vaut une restitution
 * honnête des faits qu'une page d'erreur.
 *
 * Ce n'est PAS l'agent. Elle énumère, elle ne raisonne pas, et elle le dit.
 * Les mêmes garde-fous s'y appliquent : aucun score, aucun conseil.
 */

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

export function offlineExplanation(report: TokenReport): string {
  const parts: string[] = [];
  const { creator, holders, market } = report;

  parts.push(
    "Cette restitution est produite sans l'agent de raisonnement : elle énumère " +
      'les faits relevés, sans les croiser ni les interpréter.',
  );

  // — Créateur —
  if (creator.completeness === 'unavailable') {
    parts.push("L'historique du créateur n'a pas pu être lu.");
  } else {
    const c = creator.data.counts;
    const scope =
      creator.completeness === 'partial'
        ? ` sur la fenêtre observée (blocs ${creator.data.scannedRange.fromBlock} à ${creator.data.scannedRange.toBlock}, l'historique antérieur n'est pas couvert)`
        : '';
    parts.push(
      `Créateur : ${c.launched} token${c.launched > 1 ? 's' : ''} lancé${c.launched > 1 ? 's' : ''}${scope}, ` +
        `dont ${c.graduated} gradué${c.graduated > 1 ? 's' : ''} et ${c.abandoned} abandonné${c.abandoned > 1 ? 's' : ''}.`,
    );
  }

  // — Holders —
  if (holders.completeness === 'unavailable') {
    const why = holders.sources[0]?.note ?? 'source indisponible';
    parts.push(`Concentration des détenteurs : non mesurée (${why}).`);
  } else {
    parts.push(
      `Détenteurs : le premier détient ${pct(holders.data.concentration.top1)} de l'offre en circulation, ` +
        `le top 10 en cumule ${pct(holders.data.concentration.top10)}. ` +
        'Le pool de liquidité et les adresses de burn sont exclus de ce calcul.',
    );
  }

  // — Marché —
  if (market.completeness === 'unavailable') {
    parts.push(`Marché : ${market.sources[0]?.note ?? 'aucune donnée'}.`);
  } else {
    const m = market.data;
    const bits: string[] = [];
    if (m.priceUsd !== null) bits.push(`prix ${m.priceUsd} USD`);
    if (m.liquidityUsd !== null) bits.push(`liquidité ${m.liquidityUsd.toFixed(2)} USD`);
    if (m.graduation) {
      bits.push(
        `graduation à ${pct(m.graduation.progress)} du seuil de ${m.graduation.thresholdEth} ETH`,
      );
    }
    if (bits.length > 0) parts.push(`Marché : ${bits.join(', ')}.`);

    const perTrade = volumePerTrade(market);
    if (perTrade !== null && m.txns) {
      const trades = m.txns.h24.buys + m.txns.h24.sells;
      parts.push(
        `Sur 24 h : ${m.volumeUsd?.h24.toFixed(2)} USD de volume réparti sur ${trades} échange${trades > 1 ? 's' : ''}, ` +
          `soit ${perTrade.toFixed(2)} USD par échange en moyenne.`,
      );
    }
  }

  if (report.completeness !== 'full') {
    parts.push(
      "Toutes les sources n'ont pas répondu : ce qui précède est une vue partielle, " +
        'et certains points ne peuvent pas être vérifiés ici.',
    );
  }

  return parts.join('\n\n');
}
