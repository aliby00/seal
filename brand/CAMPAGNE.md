# SEAL — campagne de pré-lancement

Trois films, trois trouvailles réelles. Aucune n'est une promesse produit : ce sont
des choses mesurées sur la chaîne. C'est ce qui se retweete, pas « on lance bientôt ».

## Séquence

| Quand | Film           | Rôle                                                       |
| ----- | -------------- | ---------------------------------------------------------- |
| J-10  | `seal-Teaser`  | ouvre le compte, **à épingler**                            |
| J-7   | `seal-Reuse`   | la preuve de travail : on a compté, voilà le chiffre       |
| J-4   | `seal-Imperso` | le constat qui dérange                                     |
| J-1   | —              | un seul post texte : « demain » + le carton final en image |
| J     | lancement      |                                                            |

Un film tous les trois jours. Entre les deux, ne rien poster : la crédibilité du
compte vient de ce qu'il ne parle que quand il a trouvé quelque chose. C'est le même
principe que le produit.

## Tweets

### J-10 — Teaser (épinglé)

```
Celui qui lance un token écrit aussi les règles du marché.
Combien tu paies pour vendre. Si tu as le droit de vendre.

Ces règles sont publiques. Personne ne les lit.

Nous, si.
```

### J-7 — Réutilisation

```
97 marchés créés en 50 minutes sur Robinhood Chain.
28 tournent sur exactement le même code.

7 lancements/jour, 0 créateur répété : les portefeuilles tournent.
Le code, non.

C'est la seule empreinte qui survit à la rotation.
```

### J-4 — Usurpation

```
6 marchés avec des règles custom listés sur cette chaîne.
5 s'appellent ROBINHOOD ou HOOD.

Ce n'est pas un risque à anticiper. C'est l'état actuel.
```

### J-1

```
Demain.
```

- le carton final en image fixe.

## Voix off — prompts ElevenLabs

Les films sont rendus **muets**. Ils fonctionnent tels quels (X lit en sourdine par
défaut), mais une voix double la rétention.

**Voix** — Text to Speech, modèle v3 ou Multilingual v2. Narrateur posé, grave,
sans emphase. Vitesse 0,95 · stabilité 50 · similarité 75. Ponctuer avec des points
et des « … » pour les respirations.

Teaser :

> Celui qui lance un token… écrit aussi les règles du marché. Ces règles sont
> publiques. Personne ne les lit. Nous, si.

Réutilisation :

> Quatre-vingt-dix-sept marchés, en cinquante minutes. Vingt-huit tournent sur le
> même code. Un seul acteur.

Usurpation :

> Six marchés listés. Cinq usurpent le nom de la plateforme. Ce n'est pas un risque.
> C'est l'état actuel.

**Musique** — ElevenLabs Music, 30 s :

> minimal cinematic tech underscore, low sustained synth, airy pads, restrained,
> no vocals, 92 bpm, ends on a soft unresolved note

Prendre la version la plus calme. La voix doit dominer.

**Effets** — Sound Effects, 2 s chacun, placés aux repères :

| Effet                   | Prompt                     | Repère             |
| ----------------------- | -------------------------- | ------------------ |
| apparition de la grille | `soft glassy shimmer`      | Reuse 3,0 s        |
| marquage des 28         | `gentle digital blip, low` | Reuse 7,0 s        |
| liens vers le nœud      | `airy whoosh, small`       | Reuse 8,0 s        |
| carton final            | `warm low bloom impact`    | fin de chaque film |

**Mixage** — `mix.sh` du skill : musique à 0,32, sidechain sous la voix,
`loudnorm` à **-14 LUFS**. Sans ça la vidéo sort vers -21 et paraît faible sur X.

## Règles tenues dans les films

- aucun score, aucun conseil, aucune promesse de gain
- aucune accusation nommée : on montre `0x4e34…`, jamais « untel est un escroc »
- aucun logo ni nom de partenaire — **pons n'apparaît nulle part**, le partenariat
  n'est pas annoncé tant qu'il n'est pas signé
- les chiffres affichés sont ceux qu'on a mesurés, rien n'est arrondi à la hausse
