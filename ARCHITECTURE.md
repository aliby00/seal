# ARCHITECTURE

Comment les pièces s'assemblent : **pipeline de données → agent de raisonnement → interface**.

---

## Le principe directeur

SEAL ne calcule pas de score. Le pipeline ne produit donc **aucun agrégat, aucune note,
aucun verdict** : il rassemble trois blocs de faits et les remet tels quels à l'agent, qui
les croise. C'est tout le propos du produit — si le pipeline pré-mâchait une conclusion,
il ne resterait à l'agent qu'à la reformuler, et SEAL redeviendrait un scanner de plus.

## Vue d'ensemble

```
                        POST /api/analyze
                               │
                               ▼
                    ┌──────────────────────┐
                    │  collect(token)      │   les trois modules en parallèle
                    └──────────┬───────────┘
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
   ┌────────────────┐ ┌──────────────┐ ┌────────────────┐
   │ lib/chain      │ │ lib/holders  │ │ lib/market     │
   │ RPC + factory  │ │ Blockscout   │ │ DexScreener    │
   │ CreatorHistory │ │ Distribution │ │ MarketState    │
   └────────┬───────┘ └──────┬───────┘ └───────┬────────┘
            └─────────────────┼─────────────────┘
                              ▼
                       ┌─────────────┐
                       │ TokenReport │   trois blocs + leur complétude
                       └──────┬──────┘
                              ▼
                    ┌──────────────────────┐
                    │  lib/agent           │
                    │  prompt → Claude     │
                    │  guardrails + cost   │
                    └──────────┬───────────┘
                               ▼
                    explication en langage clair
```

## Les trois modules

Chacun vit dans son dossier, ne connaît pas les autres, et se teste **indépendamment**
sur des fixtures figées. Aucun test unitaire ne touche le réseau.

| Module        | Source              | Produit              | Clé requise               |
| ------------- | ------------------- | -------------------- | ------------------------- |
| `lib/chain`   | RPC Robinhood Chain | `CreatorHistory`     | non (public, rate-limité) |
| `lib/holders` | Blockscout API PRO  | `HolderDistribution` | **oui**, gratuite         |
| `lib/market`  | DexScreener         | `MarketState`        | non                       |

### `lib/chain`

Résout **dynamiquement** l'adresse du factory — celle de la documentation pons est périmée
et revert, et au moins quatre générations existent (voir `RESEARCH.md`). Puis filtre
`TokenLaunched` par `deployer` (topic2, indexé) et lit `graduationStatus()` pour chaque token.

Le découpage des `eth_getLogs` est **piloté par le volume**, pas par une taille de fenêtre
fixe : la fenêtre se divise en deux à l'approche de 10 000 résultats. Trois issues doivent
être traitées — dépassement de limite, `log query timed out`, et rate limit (429/403).

### `lib/holders`

L'instance publique Blockscout est derrière Cloudflare et renvoie 403 côté serveur : tout
passe par l'API PRO, qui exige une clé même en gratuit (5 req/s, 100 000 crédits/jour).

Le pool et les adresses de burn sont exclus du calcul des parts — sinon le pool ressort
systématiquement comme « détenteur majoritaire » et fausse tout.

### `lib/market`

Slug de chaîne DexScreener : `robinhood`. Pas de clé, 300 req/min.

Croise le volume avec le nombre de transactions distinctes : 485 $ de volume pour 4 achats
et 3 ventes ne raconte pas la même histoire que le même volume réparti sur 200 échanges.
C'est le signal « aller-retour artificiel » du whitepaper.

## La complétude, partout

Chaque bloc porte son propre `completeness` : `full`, `partial` ou `unavailable`.

C'est structurel, pas cosmétique. Le whitepaper assume publiquement que la vue peut être
partielle — _« the agent may have a partial view of a very old creator until indexing is
complete »_. Pour que l'agent puisse le **dire**, il faut qu'il le **sache**. D'où un champ
par source plutôt qu'un drapeau global : « l'historique du créateur est tronqué » et
« Blockscout n'a pas répondu » ne conduisent pas au même paragraphe.

**Un échec partiel ne tue jamais l'analyse.** Deux sources sur trois restent une analyse,
à condition de le signaler. `combineCompleteness` applique la règle du maillon faible.

## Gestion des erreurs

Chaque appel externe peut échouer de trois façons — timeout, rate limit, donnée incomplète —
et les trois sont traitées explicitement, jamais supposées absentes. Le wrapper HTTP commun
(`lib/http.ts`) porte le timeout, le retry exponentiel, le respect du `Retry-After` et un
plafond de requêtes par analyse, pour qu'une analyse ne puisse pas épuiser un quota
journalier à elle seule.

Les erreurs sont typées (`lib/errors.ts`) : un `RateLimitError` et un `NotFoundError` ne se
traduisent pas par la même complétude ni par le même message.

## L'agent

Le system prompt est un **préfixe stable**, donc éligible au prompt caching. Les données du
token viennent après, et changent à chaque requête.

Deux garde-fous sont testés automatiquement dans le CI (`lib/agent/guardrails.ts`) : aucun
score numérique, aucune formulation de conseil d'achat. Ce sont des propriétés vérifiables,
pas des intentions.

Le coût de chaque requête est lu dans `response.usage`, converti en dollars via une table
de tarifs versionnée, et loggué avec le label `SEAL_ENV` — **dès le MVP**, pas ajouté après
coup. Sans ça, l'arbitrage Sonnet 5 contre Haiku 4.5 resterait théorique.

## Ce qui est volontairement absent du MVP

| Absent                                       | Où ça arrive            |
| -------------------------------------------- | ----------------------- |
| Historique créateur complet sur 71,7 M blocs | `feat/creator-history`  |
| Détection de clusters de wallets liés        | `feat/holder-deep-scan` |
| Cache de réponses                            | `feat/response-cache`   |
| Persistance, utilisateurs                    | `feat/watchlist`        |

Le MVP scanne une **fenêtre récente** et marque `completeness: partial`. C'est assumé et
visible dans la réponse, pas caché.
