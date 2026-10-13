# SEAL — identité v3 : le contrôle

## L'idée

SEAL fait ce que fait un scanner de contrôle : un marché passe, on voit ce
qu'il contient, et on ne dit pas s'il est bon. L'agent de sûreté ne juge pas
le voyageur ; il montre ce qu'il y a dans la valise.

- **L'arche** est le portique du scanner.
- **Le rideau** a 14 lanières, une par bit de permission du hook Uniswap v4
  (bit 13 à gauche). Lanière longue = permission active. Toutes longues : la
  marque. Le masque d'un vrai hook : le rideau de ce marché.
- **Chaque marché est un bagage.** Sur le tapis il est opaque ; sous l'arche on
  le voit aux rayons X. Un bagage vide, c'est un marché sans rulebook.

La v2 (cire rouge sur noir) a été abandonnée : elle était trop proche d'un autre
projet. Elle reste dans l'historique git.

## Couleurs — les fausses couleurs d'un scanner

| Rôle            | Valeur    | Dans l'image aux rayons X                                         |
| --------------- | --------- | ----------------------------------------------------------------- |
| Écran           | `#E6ECEE` | le fond                                                           |
| Dense           | `#0E1317` | texte, wordmark                                                   |
| Organique       | `#F2801C` | ce qui touche aux échanges, donc à la sortie de celui qui détient |
| Organique dense | `#B9500B` | pouvoir de modifier le montant d'un échange                       |
| Métal           | `#1E4FD8` | ce qui touche à la liquidité ; l'arche                            |
| Mixte           | `#2F9A5B` | le reste (création du marché, dons)                               |
| Plomb           | `#5E6A73` | texte secondaire                                                  |

## Typographie

- **Archivo** 800, interlettrage −3 % : titres.
- **Martian Mono** : données, étiquettes, interface.
- **Wordmark** : pochoir dessiné, comme un marquage de cargaison. Le A est
  l'arche.

## Fichiers

- `gen/marks.mjs` génère toutes les marques : `node gen/marks.mjs logo`.
- `logo/mark.svg` est la marque. Sous 48 px, utiliser `mark-small.svg` (5 lanières).
- `logo/avatar.svg` : photo de profil.
- `logo/lockup.svg`, `lockup-dense.svg` : marque + nom.
- `logo/rulebook-0x2544.svg` : le rideau du hook qui portait 28 marchés sur 97.
  `rulebook-0x20cc.svg` : celui du marché « HOOD ».
- `video/` : les films (Remotion). `npm run stills` pour vérifier, `npm run render` pour tout rendre.

## Les films

Données réelles : 177 marchés v4 relevés sur Robinhood Chain le 11/10/2026,
blocs 86 100 036 – 86 131 118 (~51 min). `video/src/markets.json`.

| Film      | Durée | Ce qu'il montre                                                                                                                  |
| --------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Reveal`  | 8 s   | l'arche se trace, les 14 lanières tombent avec le nom de leur permission, le faisceau balaie, le nom s'assemble                  |
| `Live`    | 18 s  | les vrais marchés défilent sur le tapis, vus aux rayons X sous l'arche ; arrêt sur « HOOD » et ce qu'y lisent trois spécialistes |
| `Shapes`  | 16 s  | 177 marchés, 149 vides, 28 avec un rulebook, 13 rulebooks différents — l'image de chacun                                         |
| `Compose` | 17 s  | 10 spécialistes, 4 choisis, un agent ; pas de prompt                                                                             |

Chaque film existe en 16:9 et en 9:16. Tout ce qui est dit de « HOOD » est
vérifié sur la chaîne. Aucun chiffre de classement n'apparaît : il n'en existe
pas encore.

**Handle X** : `HANDLE` dans `video/src/lib3.tsx`, vide tant que le vrai n'est
pas confirmé.

## Tweets

**J-7 · Reveal** (à épingler)

> every market on robinhood chain has a rulebook.
> 14 permissions, written into its address.
> we x-ray it.

**J-5 · Shapes**

> 177 new markets in 51 minutes.
> 149 came through empty. 28 carried a rulebook, 13 different ones.
> each one leaves a different image.

**J-3 · Live**

> 51 minutes of robinhood chain, through the scanner.
> one market called itself HOOD.
> its rulebook can be rewritten without changing address.

**J-1 · Compose**

> 10 specialists. pick yours.
> no prompt, nothing to inject.
> every agent gets replayed on past markets and ranked by what it caught.

Règles : des faits. Jamais « scam », « rug » ni « safe ». On montre ce qu'un
rulebook peut faire, pas ce qu'il veut faire.
