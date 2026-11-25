# SEAL

L'agent qui explique, là où les autres se contentent de noter.

SEAL lit un token **Solana** à partir de son adresse (sa mint) et produit une explication en
langage clair plutôt qu'un score isolé. Il lit ce que la chaîne montre — ce que la mint permet
(Token-2022 compris), le créateur et ses autres tokens, les détenteurs par rôle, le lancement,
la liquidité des pools, le marché sur DexScreener — puis **croise** ces faits et dit là où ils
ne racontent pas la même histoire. Les launchpads lus sont pump.fun, Meteora Dynamic Bonding
Curve et Raydium LaunchLab (voir [`docs/launchpads.md`](docs/launchpads.md)).

> SEAL n'attribue aucune note et ne dit jamais s'il faut acheter. Voir les avertissements
> en bas de l'interface.

## Lancer en local

```bash
pnpm install
cp .env.example .env.local   # puis remplir
pnpm dev                     # http://localhost:3000
```

### Variables d'environnement

| Variable            | Requise     | Où l'obtenir                                                                                                     |
| ------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | non         | [platform.claude.com](https://platform.claude.com) ; sans clé, mode hors-ligne                                   |
| `ANTHROPIC_MODEL`   | non         | défaut `claude-sonnet-5-5`                                                                                       |
| `RPC_URL`           | recommandée | URL Alchemy (une ou plusieurs, séparées par des virgules) : sa clé lit Solana via `solana-mainnet.g.alchemy.com` |
| `SOLANA_RPC_URL`    | non         | un nœud Solana à soi ; prioritaire sur la clé Alchemy de `RPC_URL`                                               |
| `SEAL_ENV`          | non         | `development` \| `staging` \| `production`                                                                       |

Sans `RPC_URL` ni `SOLANA_RPC_URL`, SEAL lit le nœud public `https://api.mainnet-beta.solana.com` :
il est limité (quelques appels par seconde) et ne sert pas `getTokenLargestAccounts`, donc les
rapports y sont souvent partiels, et le disent.

### Trois modes, du gratuit au payant

| Configuration       | Ce que tu obtiens                             | Coût             |
| ------------------- | --------------------------------------------- | ---------------- |
| aucune clé          | les faits restitués, sans être croisés        | 0                |
| `GROQ_API_KEY`      | un vrai raisonnement, ~14 analyses/jour       | 0                |
| `ANTHROPIC_API_KEY` | la meilleure qualité, sans plafond journalier | ~0,019 $/analyse |

Groq est choisi en premier quand les deux clés sont là : on ne dépense pas par défaut.

### Essayer sans dépenser un centime

**Aucune clé n'est obligatoire.** Le pipeline de données est entièrement gratuit — nœud
public de Solana, DexScreener sans clé. Seule l'explication produite par le modèle est
facturée.

Sans `ANTHROPIC_API_KEY`, l'application bascule en **mode hors-ligne** : elle restitue les
faits relevés sans les croiser, et le dit explicitement dans la réponse. Tout le reste —
lecture de la chaîne, concentration, marché, interface, déploiement — fonctionne
normalement. C'est le moyen d'essayer SEAL de bout en bout pour zéro euro.

Quand un appel est refusé (429, méthode non servie, délai dépassé), le bloc concerné est marqué
partiel ou indisponible et l'explication le signale. Une source manquante n'empêche jamais
l'analyse.

## Commandes

|                             |                                        |
| --------------------------- | -------------------------------------- |
| `pnpm dev`                  | serveur de développement               |
| `pnpm build`                | build de production                    |
| `pnpm typecheck`            | TypeScript, mode strict                |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                      |
| `pnpm test`                 | suite complète, **aucun appel réseau** |
| `pnpm test:guards`          | garde-fous de l'agent uniquement       |

Les lectures Solana de bout en bout sont enregistrées sur le réseau principal puis rejouées sans
réseau ; pour les réenregistrer : `SEAL_RECORD=1 pnpm vitest run tests/collect/record.live.test.ts`.

## Structure

```
src/lib/solana/      nœud Solana : mint et pouvoirs, détenteurs, créateur, lancement,
                     launchpads, graduation, liquidité des pools
src/lib/market/      DexScreener (Solana) — prix, liquidité, volume, pools listés
src/lib/collect.ts   orchestrateur : les lectures en parallèle, sous un budget d'appels et de temps
src/lib/agent/       prompt, appel au modèle, garde-fous, coût
src/app/             interface, carte de partage et routes /api/*
extension/           extension navigateur (DexScreener, Solscan, Solana Explorer, pump.fun)
```

Chaque module se teste indépendamment, sur des fixtures capturées en direct et un faux nœud
RPC.

## Documents

|                                            |                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| [`RESEARCH.md`](RESEARCH.md)               | ce qui a été mesuré, ce qui vient d'une doc, ce qui reste non confirmé |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)       | comment les pièces s'assemblent                                        |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)       | branches, pipelines, règles non négociables                            |
| [`TASKS.md`](TASKS.md)                     | plan de développement                                                  |
| [`docs/launchpads.md`](docs/launchpads.md) | launchpads, graduation et pools lus sur Solana                         |

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
reste statique.

## Licence

Tous droits réservés. Le code est public pour que chacun puisse vérifier la méthode,
pas pour être réutilisé : voir [LICENSE](LICENSE).
