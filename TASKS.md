# SEAL — Plan de développement

Plan complet, de zéro à la mise en production. Chaque tâche porte un identifiant
(`T0.1`, `T3.5`…) réutilisé dans les issues GitHub et dans les messages de commit.

- ⛔ = bloquant, rien ne continue tant que ce n'est pas fait
- Les branches `feat/*` sont celles définies dans `seal-build-plan-condensed.pdf`

**Stack retenue** : Next.js (App Router) · TypeScript strict · viem · `@anthropic-ai/sdk`
· Vitest · déploiement Vercel piloté par GitHub Actions.

---

## Phase 0 — Décisions et fondations

### T0.1 Décisions — tranchées

- [x] **Modèle Claude → `claude-sonnet-5`** (2 $/MTok entrée, 10 $/MTok sortie).
      Estimation ≈ 57 $/mois à 100 requêtes/jour, soit le double du budget initial de 30 $.
      Choix assumé : la qualité du raisonnement _est_ le produit. On mesure le coût réel
      via T3.6, et on redescend à Haiku 4.5 (≈ 29 $/mois) si la qualité le permet.
- [x] **Hébergement → Vercel**, déploiement piloté par GitHub Actions.
- [x] **URL → `.vercel.app`**, pas de domaine acheté.
      **Deux projets Vercel distincts** sur le compte `ali-ben-yezzas-projects` (plan Hobby) :
      `seal` pour la production (`https://seal-six-rho.vercel.app`) et `seal-staging`
      pour le staging. Chaque projet a sa propre URL de production stable et ses propres
      variables d'environnement — isolation réelle, et ça ne dépend pas du plan Vercel.
      C'est le même schéma que `sirius-evm` / `sirius-evm-staging`.
      Le passage à un vrai domaine plus tard ne changera qu'un réglage de domaine.
- [x] **RPC → public au démarrage** (`https://rpc.mainnet.chain.robinhood.com`).
      Suffisant pour le MVP ; insuffisant pour T4.1 (backfill de 71,7 M blocs) — on bascule
      sur un RPC payant à ce moment-là.
- [x] **Historique créateur au MVP → fenêtre récente.** L'historique complet est le sujet
      de `feat/creator-history` (T4.1), conformément au build plan.
- [ ] **Version longue du build plan** — `instructions` cite `seal-build-plan-internal-en.pdf`,
      le repo contient `seal-build-plan-condensed.pdf`. Existe-t-il une version non condensée ?

### T0.2 Comptes et clés

- [ ] Clé API Anthropic — **deux** clés distinctes (staging / production)
- [ ] Clé Blockscout sur `dev.blockscout.com` — **deux** clés (gratuit : 5 req/s, 100 000 crédits/jour)
- [ ] Clé RPC si T0.1 tranche « payant » — **deux** clés
- [x] Projets Vercel créés sur `ali-ben-yezzas-projects` : `seal` (prod) et `seal-staging`.
      Connexion GitHub volontairement **supprimée** — voir T0.4.
- [x] `.env.example` commité, `.env.local` et `.vercel/` dans `.gitignore`

> Les clés sont doublées pour que la dépense de staging ne pollue ni le budget de production
> ni la mesure de coût par requête (T3.6).

### T0.3 Squelette du repo

- [x] `pnpm create next-app` — App Router, TypeScript
- [x] `tsconfig` : `strict: true`, `noUncheckedIndexedAccess: true`
- [x] Vitest, ESLint, Prettier
- [x] `.gitignore`, `.nvmrc` (Node 24), champ `engines` dans `package.json`
- [x] Premier commit

---

## Phase 0bis — Les deux pipelines

Mis en place **sur une page vide**, rendus verts de bout en bout, avant toute ligne de SEAL.
Déboguer le CI et le produit en même temps est le meilleur moyen de perdre trois jours.

```
feat/*  ──PR──►  staging  ──PR──►  main
   │               │                 │
Preview         Pipeline          Pipeline
éphémère        STAGING           PRODUCTION
(URL par PR)   seal-staging.vercel.app    seal.vercel.app
```

> Extension de la structure git décrite dans `instructions` : `main` reste la production
> et ne reçoit que du release. Les branches `feat/*` partent de `staging`.

### T0.4 ⛔ Couper l'auto-deploy natif de Vercel

- [x] Connexion GitHub **déconnectée** du projet `seal` (`vercel git disconnect`). Elle était
      active avec `main` comme branche de production : Vercel aurait déployé à chaque push,
      sans attendre les tests.
- [x] `vercel.json` avec `git.deploymentEnabled: false` en ceinture-bretelles, si la connexion
      est rétablie un jour.
- [x] `VERCEL_ORG_ID` et `VERCEL_PROJECT_ID` posés par environnement (projets distincts).
- [ ] Générer un `VERCEL_TOKEN` et le poser dans les deux environnements

> Piège n°1 : l'intégration Git de Vercel déploie dès le push, **sans attendre le CI**.
> Sans cette étape, les tests ne gatent rien. GitHub Actions doit être le seul chemin
> vers un déploiement.

### T0.5 Les deux GitHub Environments

- [x] Environment `staging` — branche autorisée : `staging` uniquement, pas de reviewer
- [x] Environment `production` — branche autorisée : `main` uniquement, **required reviewer** (Ali)
- [x] Secrets scopés par environnement (jamais au niveau repo) — `VERCEL_TOKEN` reste à poser :
      `ANTHROPIC_API_KEY`, `BLOCKSCOUT_API_KEY`, `RPC_URL`, `SEAL_ENV`,
      `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`

### T0.6 Protection des branches

- [ ] `main` — PR obligatoire, checks requis, pas de push direct, pas de force-push
- [ ] `staging` — PR obligatoire, mêmes checks requis
- [ ] Historique linéaire sur les deux, pour que le commit testé en staging soit
      exactement celui qui part en production

### T0.7 Workflow `ci.yml` — le socle partagé

Déclenché sur chaque PR et chaque push de `feat/*`. Réutilisé par les deux pipelines
de déploiement, pour qu'ils soient littéralement identiques.

- [x] `pnpm install --frozen-lockfile`
- [x] `typecheck`
- [x] `lint`
- [x] tests unitaires — fixtures figées, **zéro appel réseau réel**
- [x] tests de garde-fous de l'agent (voir T3.5)
- [x] `build`
- [x] cache pnpm + Next
- [x] `concurrency` par branche, annulation des runs obsolètes

### T0.8 Workflow `deploy-staging.yml`

- [x] Appelle `ci.yml` — si rouge, rien ne se déploie
- [x] `vercel pull --environment=preview`
- [x] `vercel build` puis `vercel deploy --prebuilt`
- [x] `vercel deploy --prebuilt --prod` **sur le projet `seal-staging`** — son URL de production est l'URL de staging, stable par construction (pas d'alias à gérer)
- [x] Smoke tests contre l'URL déployée : page qui répond, `/api/analyze` sur un token réel,
      une vraie requête Claude de bout en bout
- [x] Si les smoke tests échouent → job rouge, l'alias reste sur le déploiement précédent

> `--prebuilt` fait tourner le build sur le runner et n'envoie que `.vercel/output`.
> Sans ce flag, Vercel rebuild le même artefact et la facture CI double.

### T0.9 Workflow `deploy-production.yml`

Structurellement identique à staging, trois différences seulement.

- [x] Appelle `ci.yml` — rejoué sur le commit de merge
- [x] Gate `environment: production` → approbation humaine
- [x] `vercel pull --environment=production`, `vercel build --prod`, `vercel deploy --prebuilt --prod`
- [x] Smoke tests contre l'URL de production
- [x] **Rollback automatique** si les smoke tests échouent (`vercel rollback`)
- [x] Tag git `v*` + release notes

### T0.10 Rituel de promotion

- [x] Documenté dans `CONTRIBUTING.md`
- [x] La PR `staging → main` est une PR de release : elle liste ce qui part, rien n'y est ajouté

### T0.11 ⛔ Validation du squelette

- [ ] Une page « hello » passe `feat/test-pipeline` → `staging` → URL staging vivante
- [ ] Puis `staging` → `main` → URL production vivante
- [ ] Un test volontairement cassé **bloque** bien le déploiement
- [ ] Un smoke test volontairement cassé déclenche bien le rollback

---

## Phase 1 — `RESEARCH.md`

Étape 1 des `instructions` : rien n'est codé sur une supposition non vérifiée.

### T1.1 Rédiger les cinq sections vérifiées

- [x] **RPC Robinhood Chain** — chain ID 4663 / `0x1237`, client `nitro` (Arbitrum Orbit),
      block time mesuré **0,101 s** (~855 800 blocs/jour), chaîne née vers le 3 juillet 2026.
      **Limite `eth_getLogs` = 10 000 logs** (et non 1 000 comme supposé dans `instructions`) :
      `{"code":-32000,"message":"logs matched by query exceeds limit of 10000"}`.
      Aucune limite de plage de blocs observée. Rate limit non documenté → 429 en série puis 403 HTTP.
- [x] **pons factory** — ABI `TokenLaunched` vérifiée sur un log réel (7 mots de `data`),
      topic0 `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a`.
      **Le factory vivant est `0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75`** — celui que les docs
      officielles annoncent comme « actif » (`0xA5aAb3F0…`) **revert**.
      `graduationStatus(address)` selector `0x98d652f1` → `(pairedPrincipal, threshold, graduated)`,
      seuil confirmé à **4,2 ETH**. Uniswap **V3**, pas de bonding curve.
      Supply fixe 1e9, fee de pool 1 %, launch fee 0,0005 ETH, split créateur/protocole 70/30.
- [x] **Blockscout** — `https://api.blockscout.com/4663/api/v2/…`, clé **obligatoire**
      (sinon `HTTP 402`), tier gratuit 5 req/s et 100 000 crédits/jour.
      L'instance publique `robinhoodchain.blockscout.com` est derrière Cloudflare → `403` côté serveur.
- [x] **DexScreener** — slug de chaîne **`robinhood`**, `GET /token-pairs/v1/robinhood/{token}`,
      sans clé, 300 req/min. Champs : `priceUsd`, `liquidity{usd,base,quote}`, `volume`, `txns`,
      `fdv`, `marketCap`, `priceChange`, `pairCreatedAt`.
- [x] **Claude API** — SDK `@anthropic-ai/sdk`. Tarifs relevés : Opus 5 5 $/25 $ par MTok ·
      Sonnet 5 2 $/10 $ · Haiku 4.5 1 $/5 $. Les modèles 4.7+ utilisent un tokenizer
      produisant ~30 % de tokens en plus. Tableau de coût par requête à inclure.

> Recoupement à trois sources qui tombe juste : le champ `pool` du log `TokenLaunched`
> = le `pairAddress` de DexScreener, et `pairedPrincipal` de `graduationStatus()`
> = `liquidity.quote`. Le pipeline à trois modules tient debout.

### T1.2 Combler les trous, et écrire « non confirmé » là où ça reste ouvert

- [ ] Pagination Blockscout v2 (`next_page_params`) — sonde prête (`pnpm probe:blockscout`), en attente d'une clé
- [x] `restrictionsEndBlock` = 26 050 559 alors que le bloc courant est 71,7 M → **non élucidé**,
      hypothèse bloc L1. Ne pas s'en servir tant que ce n'est pas compris.
- [ ] Rate limit réel du RPC payant retenu
- [ ] Concurrents cités par le whitepaper : PonsScan, ponscan.fun, xroot.dev, Blockaid,
      RobinSight / $SIGHT — pour calibrer le ton de l'agent (T3.5)
- [ ] Combien de générations de factory existent, et comment les énumérer

### T1.3 Rendre la vérification reproductible

- [x] `scripts/probe-rpc.ts`, `scripts/probe-blockscout.ts`, `scripts/probe-dexscreener.ts`
      (`pnpm probe:rpc`, `probe:blockscout`, `probe:dexscreener`)
- [x] Documenter la méthode de mesure du rate limit

### T1.4 ⛔ Validation

- [ ] Commit et revue de `RESEARCH.md` avant de passer à la Phase 2

---

## Phase 2 — Architecture

### T2.1 Figer la stack

- [x] Issue des décisions T0.1

### T2.2 Arborescence

- [x] Mettre en place :

```
src/
  lib/
    config.ts          # env validé par zod, fail-fast au boot
    errors.ts          # erreurs typées : Timeout, RateLimit, Incomplete, NotFound
    http.ts            # fetch + timeout + retry/backoff + budget de requêtes
    chain/             # module 1 — RPC, factory, graduation
    holders/           # module 2 — Blockscout
    market/            # module 3 — DexScreener
    collect.ts         # orchestrateur des trois modules
    agent/
      prompt.ts        # system prompt (préfixe stable, cacheable)
      reason.ts        # appel Claude
      guardrails.ts    # refus de score / de conseil d'achat
      cost.ts          # usage → $ → log structuré
  app/
    page.tsx
    api/analyze/route.ts
    components/Disclaimer.tsx
tests/
scripts/
```

### T2.3 Contrats de données

- [x] `CreatorHistory`, `HolderDistribution`, `MarketState`, `TokenReport`
- [x] Chaque type porte `completeness: 'full' | 'partial' | 'unavailable'` et `sources[]`

> Indispensable : le whitepaper assume publiquement que la vue peut être partielle.
> L'agent doit le savoir pour pouvoir le dire.

### T2.4 `ARCHITECTURE.md`

- [x] Pipeline de données → agent de raisonnement → interface
- [x] Schéma des flux et traitement des erreurs partielles

### T2.5 Créer les huit branches `feat/*` depuis `staging`

- [ ] `feat/creator-history`
- [ ] `feat/contradiction-detector`
- [ ] `feat/holder-deep-scan`
- [ ] `feat/response-cache`
- [ ] `feat/telegram-bot`
- [ ] `feat/watchlist`
- [ ] `feat/creator-reputation-trend`
- [ ] `feat/multi-token-compare`

---

## Phase 3 — Le MVP

### T3.0 Socle

- [x] Validation d'environnement zod, fail-fast au démarrage
- [ ] Client viem sur Robinhood Chain (chaîne 4663 custom) — fait dans `feat/chain-module`
- [x] Wrapper HTTP : timeout, retry exponentiel, respect du `Retry-After`,
      plafond de requêtes par analyse
- [x] Erreurs typées — chaque appel externe a une gestion propre (contrainte des `instructions`)
- [x] Logger structuré JSON

### T3.1 Module 1 — historique du créateur (`lib/chain/`)

- [ ] Résolution **dynamique** du factory — ne jamais coder l'adresse en dur, elle a déjà changé
- [ ] `getLogs` chunké, fenêtre **adaptative** : division par deux dès qu'on approche 10 000 logs
- [ ] `TokenLaunched` filtré par `deployer` (topic2 indexé) → liste des tokens du créateur
- [ ] Pour chaque token : `graduationStatus()` → gradué / abandonné / en cours
- [ ] Détection de retrait de liquidité et de dump de l'allocation créateur
- [ ] `completeness: 'partial'` quand la fenêtre est tronquée
- [ ] Tests sur fixtures de logs réels figées

### T3.2 Module 2 — concentration des holders (`lib/holders/`)

- [ ] `GET /4663/api/v2/tokens/{addr}/holders` + pagination
- [ ] Top N, part du top 1 et du top 10, exclusion du pool et des adresses de burn
- [ ] Historique de transferts pour mesurer l'activité réelle
- [ ] Budget de requêtes respectant 5 req/s
- [ ] Dégradation propre : `unavailable` plutôt qu'un crash si Blockscout tombe

### T3.3 Module 3 — état du marché (`lib/market/`)

- [x] `GET /token-pairs/v1/robinhood/{token}`
- [x] Extraction : prix, liquidité, volume par fenêtre, `txns` buys/sells, `fdv`, `pairCreatedAt`
- [x] Croisement volume ↔ nombre de transactions distinctes
      (le signal « aller-retour artificiel » du whitepaper)
- [x] Progression de graduation = `pairedPrincipal / 4,2 ETH`
- [x] Cas « aucune paire indexée » (token trop récent)

### T3.4 Orchestrateur (`lib/collect.ts`)

- [ ] Les trois modules en parallèle
- [ ] Un échec partiel ne tue pas l'analyse

### T3.5 Agent de raisonnement (`lib/agent/`)

- [ ] System prompt en préfixe stable → éligible au prompt caching
- [ ] Les trois blocs de données + leur `completeness` en entrée
- [ ] **Garde-fous avec tests automatiques** : aucun score numérique, aucune formulation
      de conseil (« safe to buy », « bon investissement », « je recommande »…).
      Une suite de tests échoue si une phrase interdite sort.
- [ ] Ton calibré sur le whitepaper : factuel, nuancé, fait ressortir les contradictions
- [ ] Sortie structurée : ce qui rassure / ce qui mérite attention / là où les signaux divergent
- [ ] Gestion de `stop_reason`, des timeouts, streaming si le modèle retenu le justifie

### T3.6 Coût par requête ⛔

Contrainte explicite des `instructions` : visible dès le MVP, pas ajouté après coup.

- [ ] Lire `response.usage` — `input_tokens`, `output_tokens`, `cache_read_input_tokens`
- [ ] Convertir en dollars via une table de tarifs versionnée
- [ ] Logger par requête + compteur cumulé, avec le label `SEAL_ENV`

### T3.7 Route API

- [ ] `POST /api/analyze` — validation d'adresse, timeout global, erreurs HTTP propres

### T3.8 Interface

- [ ] Un champ, un bouton, le résultat
- [ ] États loading / erreur / données partielles affichées explicitement
- [ ] Bandeau « STAGING » quand `SEAL_ENV=staging`

### T3.9 Disclaimers légaux

- [ ] Pas un conseil financier
- [ ] Pas un audit de contrat
- [ ] Agent non déterministe

> Les trois viennent directement de la section « Risks We Are Not Hiding » du whitepaper.

### T3.10 `README.md`

- [ ] Comment lancer en local
- [ ] Variables d'environnement
- [ ] Comment obtenir chaque clé

### T3.11 Brancher le MVP sur les pipelines

- [ ] Ajouter les vrais tests au `ci.yml`
- [ ] Ajouter les vrais smoke tests aux deux workflows de déploiement

### T3.12 Recette du MVP

- [ ] Cinq tokens réels testés de bout en bout : un gradué, un abandonné, un tout neuf,
      un très concentré, une adresse invalide

---

## Phase 4 — Wave 1 (avant lancement)

### T4.1 `feat/creator-history` — J+1

- [ ] Historique **complet** avec pagination chunkée sur les 71,7 M blocs
- [ ] RPC payant
- [ ] Indexation / persistance locale pour ne pas re-scanner à chaque requête
- [ ] Passage de `completeness: partial` à `full`

### T4.2 `feat/contradiction-detector` — J+3

- [ ] Règles de détection de signaux divergents, en amont du prompt
- [ ] Les contradictions sont passées **explicitement** à l'agent plutôt qu'espérées

### T4.3 `feat/holder-deep-scan` — J+5

- [ ] Détection de clusters de wallets liés : financement commun, timing, graphe de transferts

### T4.4 `feat/response-cache` — J+7

- [ ] Cache des réponses par (token, tranche de temps)
- [ ] Répond au risque n°1 du whitepaper (non-déterminisme) **et** fait chuter le coût par requête

---

## Phase 5 — Wave 2 (en parallèle)

### T5.1 `feat/telegram-bot` — dès J+1

- [ ] Bot, commande `/scan <addr>`, formatage, rate limit par utilisateur

### T5.2 `feat/watchlist` — J+2

- [ ] Persistance des tokens suivis, stockage, notion d'utilisateur
- [ ] ⚠️ **Deux datastores séparés** — staging ne doit jamais écrire dans la base de production

### T5.3 `feat/creator-reputation-trend` — J+3

- [ ] Comportement du créateur dans le temps, pas seulement un agrégat

### T5.4 `feat/multi-token-compare` — J+4

- [ ] Comparaison côte à côte, prompt adapté

---

## Phase 6 — Pré-lancement

### T6.1 Relecture juridique des disclaimers

### T6.2 Rate limiting et anti-abus sur l'API publique

### T6.3 Monitoring

- [ ] Taux d'erreur par source externe, latence
- [ ] **Coût journalier réel vs budget**, séparé par environnement

### T6.4 Analytics minimales

### T6.5 Décision coin

- [ ] Le whitepaper nomme déjà le conflit d'intérêt — à trancher **avant**, pas après

---

## Chemin critique

```
T0.1 → T0.2 → T0.3 → T0.4…T0.11 (pipelines verts sur page vide)
     → Phase 1 → validation → T2.3 → T3.0 → T3.1/2/3 → T3.5 → release
```

Les deux vrais risques de dérapage : le **choix du modèle** (×5 sur le budget entre
Haiku et Opus) et le **RPC** (le public ne tiendra pas un backfill complet en Wave 1).
