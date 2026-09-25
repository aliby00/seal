# Contribuer à SEAL

## Structure des branches

```
feat/*  ──PR──►  staging  ──PR──►  main
   │               │                 │
Preview         Pipeline          Pipeline
éphémère        STAGING           PRODUCTION
(URL par PR)   URL de prod du projet seal-staging    seal-six-rho.vercel.app
```

| Branche | Rôle | Qui y écrit |
|---|---|---|
| `main` | Production. Ne reçoit que du release. | Personne directement — uniquement via une PR depuis `staging` |
| `staging` | Intégration. C'est là que les devs poussent leur travail terminé. | Via PR depuis `feat/*` |
| `feat/*` | Une feature, une branche. Part toujours de `staging`. | Le dev qui la porte |

`main` reste « uniquement le MVP tel que décrit dans le build plan ». Une feature de
Wave 1 ou 2 entre dans `staging` quand elle est prête à être **testée**, et dans `main`
quand elle est prête à être **releasée**.

## Le cycle de travail

### 1. Ouvrir une branche

```bash
git checkout staging
git pull
git checkout -b feat/ma-feature
```

Les huit branches de feature sont déjà nommées dans `seal-build-plan-condensed.pdf` :
`creator-history`, `contradiction-detector`, `holder-deep-scan`, `response-cache`,
`telegram-bot`, `watchlist`, `creator-reputation-trend`, `multi-token-compare`.

### 2. Pousser et ouvrir une PR vers `staging`

```bash
git push -u origin feat/ma-feature
gh pr create --base staging --fill
```

Le workflow `ci.yml` se déclenche : typecheck, lint, tests unitaires, tests de
garde-fous de l'agent, build. **La PR ne peut pas être mergée tant que tout n'est pas vert.**

### 3. Merge dans `staging` → déploiement automatique

Le workflow `deploy-staging.yml` rejoue le CI, construit, déploie, puis réaligne
déploie sur le projet Vercel `seal-staging`, dont l'URL de production est stable, puis lance les smoke tests
contre l'URL réelle.

Si les smoke tests échouent, l'alias **reste sur le déploiement précédent**.

### 4. Release : PR `staging` → `main`

```bash
gh pr create --base main --head staging --title "Release: <ce qui part>"
```

C'est une **PR de release** : elle liste ce qui part en production, et rien n'y est
ajouté. On ne commite pas dans `staging` pendant qu'une PR de release est ouverte.

Le merge déclenche `deploy-production.yml`, qui demande une **approbation humaine**
(environment `production`) avant de déployer. En cas d'échec des smoke tests,
rollback automatique sur le déploiement précédent.

## Règles non négociables

1. **Rien n'est codé sur une supposition non vérifiée.** Si un détail technique n'est pas
   confirmé, on le teste en vrai et on l'écrit dans `RESEARCH.md` — ou on écrit
   explicitement qu'il n'est pas confirmable.
2. **Chaque appel à une API externe a une gestion d'erreur propre.** Timeout, rate limit,
   donnée incomplète : les trois cas sont traités, jamais supposés absents.
3. **L'agent ne produit jamais de score numérique** et jamais de formulation qui ressemble
   à un conseil d'achat. C'est testé automatiquement dans `ci.yml` — un test qui passe
   n'est pas optionnel.
4. **Le coût par requête est loggué**, depuis le MVP, pas ajouté après coup.
5. **Les tests unitaires ne font aucun appel réseau réel.** Fixtures figées uniquement.
   Les seuls appels réels sont dans les smoke tests post-déploiement.

## Environnements et secrets

Les secrets sont scopés **par GitHub Environment**, jamais au niveau du repo.

| Secret | `staging` | `production` |
|---|---|---|
| `ANTHROPIC_API_KEY` | clé dédiée staging | clé dédiée production |
| `BLOCKSCOUT_API_KEY` | clé dédiée staging | clé dédiée production |
| `RPC_URL` | endpoint staging | endpoint production |
| `SEAL_ENV` | `staging` | `production` |
| `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | ✓ | ✓ |

Les clés sont doublées pour que la dépense de staging ne pollue ni le budget de
production ni la mesure de coût par requête.

**Ne jamais commiter de clé.** `.env.local` est dans `.gitignore` ; `.env.example`
liste les variables attendues, sans valeur.

## Convention de commit

Préfixer par l'identifiant de tâche de `TASKS.md` :

```
T3.2 holders: pagination Blockscout + exclusion du pool
T0.8 ci: alias staging après déploiement
```

## Tests

```bash
pnpm typecheck
pnpm lint
pnpm test           # unitaires, sans réseau
pnpm test:guards    # garde-fous de l'agent
```
