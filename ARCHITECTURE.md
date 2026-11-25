# ARCHITECTURE

Comment les pièces s'assemblent : **pipeline de données → agent de raisonnement → interface**.

---

## Le principe directeur

SEAL ne calcule pas de score. Le pipeline ne produit donc **aucun agrégat, aucune note,
aucun verdict** : il rassemble des blocs de faits et les remet tels quels à l'agent, qui
les croise. C'est tout le propos du produit — si le pipeline pré-mâchait une conclusion,
il ne resterait à l'agent qu'à la reformuler, et SEAL redeviendrait un scanner de plus.

## Vue d'ensemble

```
                         POST /api/analyze  (une mint Solana, en base58, casse gardée)
                                │
                                ▼
                     ┌──────────────────────┐
                     │  collect(mint)       │   un client Solana par analyse,
                     └──────────┬───────────┘   300 appels et 27 s au plus
        étape 1, en parallèle   │
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
 ┌──────────────┐   ┌───────────────────────┐   ┌──────────────────┐
 │ readToken    │   │ readSolanaMarket      │   │ findCreator      │
 │ mint, Token- │   │ DexScreener, puis     │   │ courbe pump.fun, │
 │ 2022, pouvoirs│  │ launchpad, graduation,│   │ payeur de la     │
 │ métadonnées  │   │ liquidité des pools   │   │ création, ou     │
 └──────┬───────┘   └───────────┬───────────┘   │ autorité méta.   │
        │                       │               └────────┬─────────┘
        └───────────────────────┼────────────────────────┘
        étape 2, en parallèle   ▼
 ┌────────────┐ ┌──────────────┐ ┌────────────────┐ ┌────────────────┐ ┌───────────────┐
 │ readHolders│ │ replayLaunch │ │ creatorHistory │ │ creatorOnToken │ │ linkedWallets │
 └─────┬──────┘ └──────┬───────┘ └───────┬────────┘ └───────┬────────┘ └───────┬───────┘
       └───────────────┴─────────────────┼──────────────────┴──────────────────┘
                                         ▼
                                 ┌─────────────┐
                                 │ TokenReport │   blocs de faits + complétude de chacun
                                 └──────┬──────┘
                                        ▼
                             ┌──────────────────────┐
                             │  lib/agent           │
                             │  prompt → modèle     │
                             │  guardrails + coût   │
                             └──────────┬───────────┘
                                        ▼
                  explication en langage clair + blocs dessinés à l'écran
```

## Les lecteurs

Chacun vit dans son module, ne connaît pas les autres, et se teste **indépendamment** sur
des fixtures relevées sur le réseau principal, servies par un faux nœud
(`src/lib/solana/fake-rpc.ts`). Aucun test unitaire ne touche le réseau.

| Module                                                      | Source                   | Produit                                                                                                 |
| ----------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `lib/solana/token.ts`                                       | nœud Solana              | la mint (programme, offre, autorités, extensions, métadonnées) et ses pouvoirs                          |
| `lib/solana/creator.ts`                                     | nœud Solana, DexScreener | le créateur, ses autres tokens, ce qu'il a fait de celui-ci, les portefeuilles à qui il a envoyé du SOL |
| `lib/solana/holders.ts`                                     | nœud Solana              | les détenteurs regroupés par propriétaire, chacun nommé par rôle                                        |
| `lib/solana/launch.ts`                                      | nœud Solana              | les premières transactions après la création, rejouées                                                  |
| `lib/market/`                                               | DexScreener (Solana)     | prix, liquidité, volume, pools listés                                                                   |
| `lib/solana/launchpads.ts`, `graduation.ts`, `liquidity.ts` | nœud Solana              | le launchpad, la graduation, la liquidité de chaque pool                                                |

Le nœud est Alchemy quand `RPC_URL` porte une clé Alchemy, un nœud à soi avec
`SOLANA_RPC_URL`, sinon le nœud public `api.mainnet-beta.solana.com` (quelques appels par
seconde, pas de `getTokenLargestAccounts` : le client se replie sur une autre lecture).

Les adresses Solana sont du base58 **sensible à la casse** : elles ne sont jamais mises en
minuscules, ni dans les lectures, ni dans les clés de cache, ni à l'écran. Les montants
restent en unités brutes (chaînes décimales) ; les parts vont de 0 à 1.

Le détail des launchpads, de la graduation et des pools lus est dans
[`docs/launchpads.md`](docs/launchpads.md).

## La complétude, partout

Chaque bloc porte son propre `completeness` : `full`, `partial` ou `unavailable`, et ses
sources avec une note quand elles n'ont pas tout donné. La complétude d'ensemble est la plus
faible de la mint, du créateur, des détenteurs et du marché.

C'est structurel, pas cosmétique. Pour que l'agent puisse **dire** que sa vue est partielle,
il faut qu'il le **sache** : « l'historique du créateur est plus long que ce qui a été lu » et
« le nœud a refusé 21 lectures de transactions » ne conduisent pas au même paragraphe. Une
lecture en échec (erreur de source, plafond d'appels ou de temps, 429, méthode non servie)
est listée dans `failedReads` ; ce qu'elle aurait trouvé reste inconnu, jamais « rien ».

**Un échec partiel ne tue jamais l'analyse.** Un lecteur qui échoue laisse son bloc
`unavailable` avec sa raison ; les autres blocs restent ce qu'ils étaient.

## Gestion des erreurs

Chaque appel externe peut échouer de trois façons — timeout, rate limit, donnée incomplète —
et les trois sont traitées explicitement, jamais supposées absentes. Le client Solana porte
un budget d'appels commun à toute l'analyse ; chaque lecteur ajoute son plafond et son délai,
et chaque limite coupe les requêtes en cours. Le wrapper HTTP commun (`lib/http.ts`) porte le
timeout, le retry exponentiel et le respect du `Retry-After` pour DexScreener.

Les erreurs sont typées (`lib/errors.ts`) : un `RateLimitError` et un `NotFoundError` (une
adresse qui ne porte pas de mint) ne se traduisent pas par la même complétude ni par le même
message.

## L'agent

Le system prompt est un **préfixe stable**, donc éligible au prompt caching. Les données du
token viennent après, et changent à chaque requête.

Deux garde-fous sont testés automatiquement dans le CI (`lib/agent/guardrails.ts`) : aucun
score numérique, aucune formulation de conseil d'achat. Ce sont des propriétés vérifiables,
pas des intentions.

Le coût de chaque requête est lu dans `response.usage`, converti en dollars via une table
de tarifs versionnée, et loggué avec le label `SEAL_ENV`.

## L'interface

La réponse de `/api/analyze` porte le texte, les faits dessinés par les cartes (`facts`), la
chronologie des lancements du créateur, le replay du lancement et une vue compacte des blocs
Solana (`solana`, construite par `src/app/components/solana-view.ts`) : mint et pouvoirs,
offre par rôle, liquidité par pool, lancement, créateur. Chaque adresse et chaque transaction
renvoie à l'explorateur Solana (`explorer.solana.com`). Un bloc non lu est dit « non lu »,
jamais dessiné à zéro.

`/api/glance` donne le « In short » sans modèle, pour l'extension navigateur ; `/api/card`
dessine l'image de partage d'une lecture.
