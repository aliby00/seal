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

Sans `BLOCKSCOUT_API_KEY`, l'application fonctionne : le bloc « détenteurs » est simplement
marqué indisponible et l'explication le signale. C'est volontaire — une source manquante ne
doit pas empêcher l'analyse.

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
