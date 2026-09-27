# SEAL — références et direction du front

Examen du 27 septembre 2026. Le brief complet reçu ensuite prime sur cette recherche :
palette neutre, un accent réservé aux interactions, aucun score visuel, thèmes clair
et sombre, sources globales au rapport.

## Ce qui a été vérifié

Les quatorze URL ont été ouvertes. Des captures desktop de 1440 × 1100 ont été
examinées pour les pages accessibles, avec lecture de leur contenu public.
Ce premier passage porte sur la composition et la rédaction, pas sur un audit
exhaustif des parcours, du mobile ou des animations.

- Perplexity : vérification anti-bot ; interface et interactions non vérifiées.
  « Réponse + sources » reste une référence fournie par le brief.
- Linear : capture limitée à la navigation, contenu principal non rendu.
- Ramp : version texte destinée aux machines, pas la page visuelle habituelle.
- Production SEAL : inaccessible via l'outil web ; interface examinée dans le code local.
- Les durées de motion proposées plus bas sont des choix pour SEAL, pas des mesures
  prétendument extraites des références.

Captures de cette session : `/tmp/seal-<nom>.png`, avec les noms paradigm,
mercury, every, stratechery, rekt, ponscan, xroot, perplexity, stripe,
linear, arc, ramp, messari et delphi. Ces fichiers temporaires ne sont pas des assets
destinés au produit.

## Références retenues : emprunts précis

| Référence                                              | Observation                                                                                                                                 | Transposition proposée pour SEAL                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Paradigm / Writing](https://www.paradigm.xyz/writing) | Fond blanc, serif, composition asymétrique, marges généreuses, dates et navigation numérotée.                                               | Base visuelle : titre serif, beaucoup d'air autour du texte, rubriques numérotées, filets fins. Réduire l'espace du haut pour garder le formulaire immédiatement accessible.                                               |
| [Perplexity](https://www.perplexity.ai)                | Accès bloqué ; principe réponse + sources donné par le brief.                                                                               | Une réponse centrale et un bloc de sources identifiable. Les citations numérotées par phrase nécessitent une provenance que l'API actuelle ne fournit pas.                                                                 |
| [Stripe docs](https://docs.stripe.com)                 | Intitulés d'action concrets, navigation explicite, instructions courtes.                                                                    | La voix : « Collez l'adresse du token », « Lire l'analyse », « Historique incomplet ». Une erreur explique ce qui a échoué et l'action possible.                                                                           |
| [Every](https://every.to)                              | Masthead très présent, titres serif avec italiques, hiérarchie de magazine, images et colonnes contrastées. La capture actuelle est sombre. | Donner à SEAL une signature typographique ; un mot en italique peut porter le contraste du titre. Garder un seul sujet principal par écran plutôt que reproduire la densité de la une.                                     |
| [Stratechery](https://stratechery.com)                 | Colonne de lecture dominante, colonne secondaire, métadonnées discrètes, liens intégrés au texte.                                           | Résultat lisible comme un article : prose à gauche, sources et contexte à droite sur desktop. Sur mobile, conserver l'ordre de lecture.                                                                                    |
| [rekt.news](https://rekt.news)                         | Typographie mono, grands titres, filets marqués, entrées qui commencent par l'incident.                                                     | Emprunter l'attaque directe : commencer par ce que les observations permettent de dire. Le ton reste proportionné aux données. Les capitales et la grille de quatre colonnes ne sont pas nécessaires à une analyse unique. |
| [Mercury](https://mercury.com)                         | Navigation aérée, action principale claire, composition maîtrisée ; le hero actuel est une grande scène photographique.                     | Plafond de finition et de sérieux : espacement, hiérarchie et contrôles soignés. La scène photographique ne sert pas directement la lecture d'un token.                                                                    |

Deux pages intérieures ont également été lues :
[l'article Paradigm sur le volume Polymarket](https://www.paradigm.xyz/writing/polymarket-volume-is-being-double-counted)
et [l'article rekt sur Nostra](https://rekt.news/nostra-rekt).
Le second illustre bien l'intérêt d'annoncer le fait central, de développer le
mécanisme, puis de préciser ce que les sources n'établissent pas.

## Concurrents

### [ponscan](https://ponscan.fun)

La page capture immédiatement les codes du terminal : fond noir verdâtre,
quadrillage, monospace, vert lumineux, commandes dans les libellés. Le formulaire
est accompagné d'exemples. La proposition est organisée autour de la distribution,
des indicateurs de risque et des portefeuilles.

À reprendre : une adresse comme point d'entrée, une action évidente et la méthode
accessible. Pour SEAL, le résultat doit consacrer son espace principal à
l'explication. Le backend local ne fournit pas les fonctions portefeuille,
bubble map ou watchlist présentées par ponscan.

### [xroot](https://xroot.dev)

Fond presque noir, grille discrète, titre monospace massif, accent orange et liens
vers la recherche. La page relie les outils aux questions qui ont conduit à les
construire. Elle explicite que les vérifications lisent les données publiques sans
connexion de portefeuille.

À reprendre : le lien clair entre méthode et résultat, une rédaction concrète,
et l'explication du parcours sans wallet. SEAL doit préciser son propre périmètre :
comportement du créateur, détenteurs, marché. Les vérifications de contrat et les
opérations sur portefeuille de xroot ne font pas partie de ce front.

## Références écartées

| Site                                       | Résultat de l'examen                                                                                                | Décision                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Linear](https://linear.app)               | Navigation sombre et fine visible ; hero non rendu dans la capture.                                                 | Reste écarté selon le brief. Pas de conclusion sur sa motion à partir de cette capture.                           |
| [Arc](https://arc.net)                     | Page actuelle centrée sur Dia, couleurs très vives, surfaces pastel, contours ondulés, démonstration de navigateur. | Expression plus ludique que la lecture analytique recherchée.                                                     |
| [Ramp](https://ramp.com)                   | Version machine servie à Chromium.                                                                                  | Reste écarté ; examen visuel non concluant.                                                                       |
| [Messari](https://messari.io)              | Fond sombre, bleu, promesse institutionnelle, grand aperçu de terminal riche en panneaux.                           | Cette densité pousserait SEAL vers un dashboard de marché.                                                        |
| [Delphi Digital](https://delphidigital.io) | Fond bleu nuit, lignes décoratives, offre de recherche et abonnement au premier plan.                               | Le parcours commercial et la présentation institutionnelle ne correspondent pas au formulaire d'analyse immédiat. |

## Composition proposée

La combinaison principale est **Paradigm pour la page, Stratechery pour la lecture,
Perplexity pour l'organisation réponse–sources, rekt pour l'entrée en matière**.
Every apporte la signature typographique, Stripe la rédaction et Mercury la finition.

Univers proposé : un carnet d'analyse de la chaîne. Fond papier clair, texte encre,
accent vert profond, repères numérotés et détails techniques en monospace.
Le vert sert aux actions et aux liens ; il ne signifie jamais qu'un token est sûr.

### Accueil

1. En-tête compact : SEAL, Méthode, lien vers le repo.
2. Repère de contexte : « Tokens pons · Robinhood Chain ».
3. Titre proposé : « Un token ne se résume pas à une note. »
4. Phrase d'explication : « SEAL croise le créateur, les détenteurs et le marché,
   puis explique ce qui concorde — et ce qui se contredit. »
5. Champ d'adresse et bouton « Lire l'analyse », avec label visible.
6. Méthode en trois rubriques courtes et limites visibles.

Un exemple éventuel doit porter « Exemple fictif » de façon permanente, ou être
une vraie analyse datée. Aucun faux flux d'analyses récentes ni chiffre d'activité.

### Résultat

Ordre : adresse analysée → disponibilité des données → mode hors-ligne si applicable
→ explication → sources et notes → date et coût de la requête.

Sur desktop, la prose occupe environ 640–720 px et les sources une colonne
secondaire de 240–280 px. La disponibilité globale reste au-dessus de la prose,
y compris lorsque les sources sont affichées à droite. Sur mobile, les sources
passent sous la réponse, et leurs limites importantes restent annoncées en tête.

L'API renvoie une explication textuelle unique. Le front peut respecter ses
paragraphes et en faciliter la lecture ; il ne doit pas inventer des conclusions,
extraire arbitrairement des « contradictions » ni rattacher une phrase à une source
sans provenance explicite.

### Motion proposée, à valider après le brief complet

| Interaction              | Comportement proposé                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entrée de page           | Apparition courte du titre et du formulaire, déplacement vertical de 6 px maximum, environ 240 ms.                                               |
| Survol / focus           | Couleur et bordure en 140–180 ms ; focus clavier toujours visible.                                                                               |
| Analyse en cours         | Indicateur indéterminé et message honnête : « Lecture des données publiques… ». Aucune étape présentée comme terminée sans événement du serveur. |
| Résultat reçu            | Apparition du bloc en 200 ms ; annoncer sa disponibilité aux technologies d'assistance.                                                          |
| Sources détaillées       | Ouverture commandée au clic ou au clavier, contenu accessible au toucher.                                                                        |
| Réduction des animations | Respecter `prefers-reduced-motion` ; accès immédiat au contenu.                                                                                  |

La reproduction fidèle d'une animation externe demande encore une observation
temporelle et interactive. Les captures seules ne permettent pas d'en déduire les
durées, les courbes ou les déclencheurs.

## Contraintes vérifiées dans le repo

- `src/app/AnalyzeForm.tsx` : formulaire fonctionnel, états chargement/erreur/résultat,
  complétude avant la prose, mode hors-ligne et coût visibles.
- `src/app/api/analyze/route.ts` : sources limitées à `{ name, note? }` ; pas d'URL
  ni de correspondance entre phrases et preuves dans la réponse actuelle.
- `src/app/components/Disclaimer.tsx` : trois avertissements volontairement visibles.
- `ARCHITECTURE.md` : absence de score, vue partielle assumée, distinction entre
  données et raisonnement ; certaines capacités restent hors MVP.
- Le style actuel suit le thème système. Le fond clair proposé ici constitue un
  choix initial ; le brief complet impose et le front implémente les deux thèmes.

## Mise en œuvre

Branche `feat/frontend` : Tailwind via PostCSS, composants Button et Input issus
du modèle shadcn/ui et adaptés au thème neutre, aucune bibliothèque de charts.
Les sources restent au niveau du rapport. Les paragraphes sont conservés ; seule
une rubrique explicitement titrée « Là où les signaux divergent » reçoit une
emphase typographique. Aucune qualification n'est déduite de la position d'un paragraphe.

Le parcours comprend validation locale, exemple à insérer, attente explicite,
erreurs par code et nouvelle tentative, complétude, mode hors-ligne, date et coût.
Les tests navigateur utilisent des réponses interceptées, sans appel aux services
on-chain ni au modèle, et vérifient les parcours ainsi que l'accessibilité AA.
Les captures sont enregistrées sous `/tmp`, jamais dans le dépôt.

## Révision immersive demandée après la recette locale

L’entrée et la plateforme partagent désormais le même paysage naturel : deux
massifs, une vallée et une nappe de brume. Le scroll rapproche doucement le point
de vue, puis révèle le formulaire dans ce même univers. Aucune porte lumineuse,
aucun masque rectangulaire, aucun logo géant collé sur le paysage.

L’observation de [Mercury](https://mercury.com/) confirme une scène épinglée et une
avancée vers l’ordinateur pilotée par une vidéo (`hero-scrub-lg.mp4`). SEAL reprend
le principe de progression au scroll avec des transforms et des fondus CSS, sans
reprendre cette vidéo ni ajouter de bibliothèque d’animation.

La plateforme présente directement l’analyse de token pons : chaîne, détenteurs,
marché, puis champ d’adresse. Les données restent sur un panneau neutre suivant
le thème système, avec complétude avant prose et aucune couleur d’évaluation.
Le scroll demeure natif et réversible ; les liens donnent un accès direct, et
`prefers-reduced-motion` retire la traversée.

Le paysage de production est dans `public/images/`, avec sa provenance et son
prompt dans le README de ce dossier. Aucune capture de référence ou de test
n’est embarquée dans le front.
