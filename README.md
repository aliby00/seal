# SEAL

L'agent qui explique, là où les autres se contentent de noter.

SEAL analyse un token lancé sur le launchpad **pons** (Robinhood Chain) et produit une
explication en langage clair plutôt qu'un score isolé. Il lit les mêmes données publiques
que les scanners existants — historique du créateur, concentration des détenteurs, état du
marché — mais les **croise** et dit là où les signaux ne racontent pas la même histoire.

> SEAL n'attribue aucune note et ne dit jamais s'il faut acheter. Voir les avertissements
> en bas de l'interface.

## Lancer en local

```bash
pnpm install
cp .env.example .env.local   # puis remplir
pnpm dev                     # http://localhost:3000
```

### Variables d'environnement

| Variable             | Requise     | Où l'obtenir                                                                               |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`  | oui         | [platform.claude.com](https://platform.claude.com)                                         |
| `ANTHROPIC_MODEL`    | non         | défaut `claude-sonnet-5`                                                                   |
| `BLOCKSCOUT_API_KEY` | recommandée | [dev.blockscout.com](https://dev.blockscout.com) — gratuite, 5 req/s, 100 000 crédits/jour |
| `RPC_URL`            | non         | défaut `https://rpc.mainnet.chain.robinhood.com` (public, rate-limité)                     |
| `SEAL_ENV`           | non         | `development` \| `staging` \| `production`                                                 |

### Trois modes, du gratuit au payant

| Configuration       | Ce que tu obtiens                             | Coût             |
| ------------------- | --------------------------------------------- | ---------------- |
| aucune clé          | les faits restitués, sans être croisés        | 0                |
| `GROQ_API_KEY`      | un vrai raisonnement, ~14 analyses/jour       | 0                |
| `ANTHROPIC_API_KEY` | la meilleure qualité, sans plafond journalier | ~0,019 $/analyse |

Groq est choisi en premier quand les deux clés sont là : on ne dépense pas par défaut.

### Essayer sans dépenser un centime

**Aucune clé n'est obligatoire.** Le pipeline de données est entièrement gratuit — RPC
public de Robinhood Chain, DexScreener sans clé, Blockscout en tier gratuit. Seule
l'explication produite par le modèle est facturée.

Sans `ANTHROPIC_API_KEY`, l'application bascule en **mode hors-ligne** : elle restitue les
faits relevés sans les croiser, et le dit explicitement dans la réponse. Tout le reste —
lecture de la chaîne, concentration, marché, interface, déploiement — fonctionne
normalement. C'est le moyen d'essayer SEAL de bout en bout pour zéro euro.

Sans `BLOCKSCOUT_API_KEY`, le bloc « détenteurs » est marqué indisponible et l'explication
le signale. Une source manquante n'empêche jamais l'analyse.

## Commandes

|                             |                                         |
| --------------------------- | --------------------------------------- |
| `pnpm dev`                  | serveur de développement                |
| `pnpm build`                | build de production                     |
| `pnpm typecheck`            | TypeScript, mode strict                 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                       |
| `pnpm test`                 | suite complète, **aucun appel réseau**  |
| `pnpm test:guards`          | garde-fous de l'agent uniquement        |
| `pnpm probe:rpc`            | rejoue les mesures RPC de `RESEARCH.md` |
| `pnpm probe:blockscout`     | idem Blockscout                         |
| `pnpm probe:dexscreener`    | idem DexScreener                        |

Les sondes touchent le réseau pour de vrai — c'est leur but. Elles existent pour que les
chiffres de `RESEARCH.md` soient rejouables plutôt que crus sur parole.

## Structure

```
src/lib/chain/      RPC Robinhood Chain, factory pons, graduation
src/lib/holders/    Blockscout — concentration des détenteurs
src/lib/market/     DexScreener — prix, liquidité, volume
src/lib/collect.ts  orchestrateur : les trois en parallèle
src/lib/agent/      prompt, appel au modèle, garde-fous, coût
src/app/            interface et route /api/analyze
```

Chaque module se teste indépendamment, sur des fixtures capturées en direct.

## Documents

|                                      |                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------- |
| [`RESEARCH.md`](RESEARCH.md)         | ce qui a été mesuré, ce qui vient d'une doc, ce qui reste non confirmé |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | comment les pièces s'assemblent                                        |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | branches, pipelines, règles non négociables                            |
| [`TASKS.md`](TASKS.md)               | plan de développement                                                  |

## Coût

Le coût de chaque requête au modèle est calculé depuis `response.usage` et loggué — pas
estimé. Sur Sonnet 5, une analyse typique revient à environ **0,019 $**, soit ~57 $/mois à
100 requêtes par jour.

## Frontend

Le front utilise Tailwind CSS et les primitives Button/Input shadcn/ui adaptées
à une palette neutre. Le thème suit `prefers-color-scheme`. L'accent est réservé
aux interactions ; la complétude et les limites utilisent la typographie et les filets.
Les sources sont globales au rapport, sans citations par phrase. La rubrique de
divergences est mise en valeur lorsqu'elle est explicitement titrée dans la prose ;
le front n'infère jamais une qualification depuis la position d'un paragraphe.

Pour vérifier le parcours dans Chromium (réponses API simulées, aucun appel au modèle) :

```bash
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

Les tests couvrent desktop et mobile 375 px, clair et sombre, validation, attente,
complétude, mode hors-ligne, erreurs et nouvelles tentatives, ainsi que les contrôles
d'accessibilité automatisés axe. Ils tournent également dans le CI. Les captures
et rapports sont écrits dans `/tmp`, jamais commités.

Voir [FRONTEND-DIRECTION.md](FRONTEND-DIRECTION.md) pour les références et les choix.

L'entrée immersive et l'analyse partagent un paysage original de montagnes et de
brume. Le scroll natif pilote une avancée douce dans les nuages, puis révèle le
formulaire ; aucun événement wheel/touch n'est intercepté. « Ouvrir SEAL » et le
lien d'évitement donnent un accès direct. Avec `prefers-reduced-motion`, l'entrée
reste statique. La provenance des visuels et le prompt sont dans
[public/images/README.md](public/images/README.md).
