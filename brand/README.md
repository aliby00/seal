# Marque et films de pré-lancement

Tout est **codé**, rien n'est généré : les marques sont des SVG écrits à la main,
les films sont des compositions Remotion. Conséquence pratique : net à n'importe
quelle taille, et deux rendus successifs donnent exactement le même fichier.

Seules les **sources** sont versionnées. Les rendus (`out/`, `web/`, `stills/`)
sont des sorties de build et restent hors du dépôt.

## Les marques — `logo/`

| Fichier                    | Rôle                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `mark-f-tampon.svg`        | **primaire** — tient à 14 px, lit « atteste » avant « lettre » |
| `mark-e-phoque.svg`        | avatar — le plus lisible et le plus mémorisable                |
| `mark-d-reutilisation.svg` | concept — trois fois la même forme, c'est la thèse             |
| `mark-a-empreinte.svg`     | grand format uniquement — illisible sous 32 px                 |
| `lockup-*.svg`             | marque + mot, en version fond sombre et fond clair             |

Deux autres directions ont été dessinées puis abandonnées après lecture à petite
taille : un monogramme barré qui se lisait « interdit », et un diaphragme devenu
roue de bateau.

Palette reprise du site : `#090c0b` fond, `#b9d4c0` sauge, `#f0f3ed` crème,
`#304d3c` vert moyen.

## Les films — `video/`

Trois films, chacun en 16:9 et 9:16, **muets** — X lit en sourdine par défaut.
Leur contenu, ce sont les chiffres mesurés sur la chaîne, pas une promesse produit.

| Composition | Durée  | Sujet                                    |
| ----------- | ------ | ---------------------------------------- |
| `Teaser`    | 18,1 s | quatre phrases, à épingler sur le compte |
| `Reuse`     | 19,6 s | 97 marchés, 28 sur le même rulebook      |
| `Imperso`   | 18,4 s | 6 marchés listés, 5 usurpent le nom      |

Chacune a sa variante `-9x16`.

### Rendre

```bash
cd brand/video
npm install
npx remotion studio                       # aperçu interactif
npx remotion render src/index.ts Teaser out/seal-Teaser.mp4 --codec=h264 --crf=17
```

Si Remotion ne trouve pas de navigateur :
`--browser-executable=/usr/bin/google-chrome`.

Le grain animé fait grimper le débit : un rendu brut pèse 16 à 19 Mo. Repasser
derrière pour le web ramène à ~900 ko sans perte visible —

```bash
ffmpeg -i out/seal-Teaser.mp4 -c:v libx264 -crf 29 -preset medium \
       -pix_fmt yuv420p -movflags +faststart -an web/seal-Teaser.mp4
```

### Modifier un texte

Les phrases sont des chaînes isolées dans chaque composition (`P("…")`), et les
repères sont écrits en secondes. Changer la langue ou une formulation ne demande
pas de toucher à l'animation.

## Audio

Les films sortent muets et fonctionnent tels quels. La voix off double la
rétention : les prompts ElevenLabs, les effets avec leurs repères et le mixage à
−14 LUFS sont dans `CAMPAGNE.md`.

## À faire avant publication

Le handle `@SEAL_ONCHAIN` qui apparaît dans les trois cartons finaux est un
**placeholder**. Le remplacer dans `video/src/lib.tsx` (`EndCard`) et re-rendre
les six avant de poster quoi que ce soit.
