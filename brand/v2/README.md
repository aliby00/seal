# SEAL — identité v2

## Pourquoi une v2

Relevé le 12/10/2026, à côté de ce que font les projets qui montent :

| Projet   | Ce qui marche                                                                                                   | Couleur |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------- |
| crawlnet | wordmark sur mesure, fin et large ; le site **montre la machine tourner en direct** (crawlers, logs, compteurs) | cyan    |
| zauth    | wordmark pixelisé, titre en serif italique, la console du produit en vitrine                                    | gris    |
| Virtuals | tableau de marché dense, mono partout                                                                           | teal    |
| RugCheck | mascotte cartoon                                                                                                | or      |

La v1 (`brand/logo`) ne tenait pas la comparaison : un « S » dans un carré
générique, un phoque de banque d'images, un wordmark en grotesque grasse par
défaut.

## L'idée

Un hook Uniswap v4 porte **14 bits de permission dans son adresse**. Le sceau
SEAL a **14 lobes, un par bit** : bit 13 en haut, puis sens horaire.

- Tous les bits allumés : c'est la marque.
- Le masque d'un vrai hook : c'est **le sceau de ce marché**. Chaque rulebook a
  sa forme, et cette forme est une donnée, pas une décoration.

Personne d'autre dans la catégorie n'a un logo qui est aussi une lecture de la
chaîne.

## Système

| Rôle                     | Valeur                          |
| ------------------------ | ------------------------------- |
| Cire (accent, la marque) | `#E5432A`                       |
| Creux de la cire         | `#A82A17`                       |
| Os (texte)               | `#EEEBE3`                       |
| Encre (fond)             | `#0B0B0C`                       |
| Titres                   | Inter 600, interlettrage −3,5 % |
| Données, interface       | JetBrains Mono                  |

Rouge cire : personne ne l'occupe dans la catégorie (cyan, teal, gris, or), et
c'est littéralement la couleur d'un sceau.

Le wordmark est construit au trait sur une grille : même épaisseur partout, E en
trois barres (des lignes de bits), A en arche. Le S du sceau est le S du
wordmark.

## Fichiers

- `gen/marks.mjs` — génère toutes les marques. `node gen/marks.mjs logo`
- `logo/mark.svg` — la marque. `mark-small.svg` sous 48 px (sans anneau, creux plus sombre).
- `logo/avatar.svg` — photo de profil X.
- `logo/lockup-dark.svg`, `lockup-light.svg` — marque + nom.
- `logo/seal-hook-0x2544.svg` — le sceau du hook qui portait 28 marchés sur 97.
- `video/` — les films (Remotion). `npm run stills` pour vérifier, `npm run render` pour tout rendre.

## Les films

Tous sur des **données réelles** : 177 marchés v4 relevés sur Robinhood Chain le
11/10/2026, blocs 86 100 036 – 86 131 118 (~51 min). `video/src/markets.json`.

| Film      | Durée | Ce qu'il montre                                                                                            |
| --------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `Reveal`  | 8 s   | les 14 permissions s'allument une à une, la cire s'écrase, le nom se trace                                 |
| `Live`    | 18 s  | le flux réel des marchés, chacun avec son sceau ; arrêt sur « HOOD » et ce que trois spécialistes y lisent |
| `Shapes`  | 16 s  | 177 marchés, 149 sans rulebook, 28 avec, sur 13 rulebooks — et le sceau de chacun                          |
| `Compose` | 17 s  | 10 spécialistes, on en choisit 4, ils deviennent un agent ; pas de prompt                                  |

Chaque film existe en 16:9 et en 9:16.

Tout ce qui est affiché sur « HOOD » est vérifié sur la chaîne : son token n'est
pas un beacon proxy de la famille des tokens actions émis ; son hook est un proxy
EIP-1967 (implémentation `0x3690…eb17`) ; ses permissions incluent la
modification du montant d'un échange.

Aucun chiffre de classement n'apparaît : il n'en existe pas encore.

**Handle X** : `HANDLE` dans `video/src/lib2.tsx`. Vide tant que le vrai n'est
pas confirmé — aucun handle plutôt qu'un handle qui renvoie chez quelqu'un
d'autre.

## Tweets

**J-7 · Reveal** (à épingler)

> every market on robinhood chain has a rulebook.
> 14 permissions, written into its address.
> we read them.

**J-5 · Shapes**

> 177 new markets in 51 minutes.
> 149 had no rulebook. 28 did, across 13 rulebooks.
> each rulebook has a shape. it's written in its address.

**J-3 · Live**

> 51 minutes of robinhood chain.
> one market called itself HOOD.
> its rulebook can be rewritten without changing address.
> SEAL reads every market.

**J-1 · Compose**

> 10 specialists. pick yours.
> no prompt — nothing to inject.
> every agent gets replayed on past markets and ranked by what it caught.

**J0 · lancement** : le lien.

Règles : des faits, jamais « scam », « rug » ni « safe ». On montre ce que fait
un rulebook, pas ce qu'il veut faire.
