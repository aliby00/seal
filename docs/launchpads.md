# Launchpads et pools de Solana

Ce que SEAL lit pour dire d'où vient un token Solana, s'il a quitté sa courbe et ce qu'est
devenue la liquidité de ses pools. Chaque disposition de compte et chaque discriminant ci-dessous
a été lu dans la source ou l'IDL du projet, puis comparé à de vrais comptes et de vraies
transactions du réseau principal le 24/11/2026 (`tests/fixtures/solana/market/`). Le code fait
foi : `src/lib/solana/launchpads.ts`, `graduation.ts`, `liquidity.ts` et `programs.ts`, où chaque
offset porte sa source.

Un launchpad ou un pool absent de ces listes n'est jamais deviné : la réponse est « aucun de
ceux-là », et le rapport le dit.

## Les trois launchpads lus

| Launchpad                     | Programme                                     | Compte du token            |
| ----------------------------- | --------------------------------------------- | -------------------------- |
| pump.fun                      | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `BondingCurve` (PDA)       |
| Meteora Dynamic Bonding Curve | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `VirtualPool` (424 octets) |
| Raydium LaunchLab             | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | `PoolState` (429 octets)   |

Le launchpad est reconnu de deux façons :

- **son compte pour le token** : propriétaire (le programme), discriminant Anchor (8 premiers
  octets) et mint écrit dedans — la courbe pump.fun dérivée de `["bonding-curve", mint]`, le
  `VirtualPool` de DBC (mint à l'offset 136), le `PoolState` de LaunchLab (dérivé de
  `["pool", mint, quote]`, mint à l'offset 205) ;
- **l'instruction qui a créé le token** dans sa première transaction : `create` / `create_v2`
  pour pump.fun, `initialize_virtual_pool_with_spl_token` / `…_with_token2022` pour DBC,
  `initialize`, `initialize_v2` ou `initialize_with_token_2022` pour LaunchLab.

### Le créateur

Sur pump.fun, la courbe nomme son créateur (champ `creator`, offset 49) : c'est la source la plus
directe. Sinon, SEAL prend le payeur de la transaction qui a initialisé le mint — un service de
lancement peut la payer, ce qui ne prouve pas qui a fait le token — puis, à défaut, l'autorité de
mise à jour des métadonnées. Le rapport dit laquelle des trois a servi.

## La graduation

| Launchpad         | Diplômé quand                                          | Progression                         | Destination                              |
| ----------------- | ------------------------------------------------------ | ----------------------------------- | ---------------------------------------- |
| pump.fun          | `complete` = 1 (offset 48)                             | part des tokens de la courbe vendus | pool PumpSwap dérivé par `migrate`       |
| Meteora DBC       | `is_migrated`, `migration_progress` (offsets 305, 308) | quote levé / seuil de la config     | pool DAMM v1 ou v2 selon la config       |
| Raydium LaunchLab | `status` = 2 (offset 17)                               | quote levé / objectif du pool       | Raydium AMM ou CPMM selon `migrate_type` |

La progression pump.fun n'est donnée que si la courbe est partie des paramètres du compte
`Global` : une courbe créée sous d'autres paramètres donne une progression inconnue, jamais
estimée. Vérifié : la courbe de FIONA (`B34n…pump`) est `complete`, et son pool PumpSwap dérivé
est `DjbLtX1H…`, celui que liste DexScreener.

## La liquidité, par type de pool

| Pool                                                        | Ce qui est lu                                                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PumpSwap, Raydium AMM, Raydium CPMM                         | LP émis par le pool contre LP encore en circulation : l'écart est brûlé ; la part tenue par le coffre de Raydium Burn & Earn ou l'incinérateur est verrouillée ; le reste peut être retiré |
| Meteora DAMM v2                                             | la part verrouillée pour de bon, comptée par le pool, et les positions                                                                                                                     |
| Raydium CLMM, Orca Whirlpool, Meteora DLMM, Meteora DAMM v1 | liquidité dans des positions dont les détenteurs ne sont pas lus : `known: false`, jamais deviné                                                                                           |

Les plus gros détenteurs de LP ne sont listés que si le nœud sert `getTokenLargestAccounts`
(un nœud à clé ; le nœud public ne le sert pas), jamais en balayant tous les comptes de LP.

## Les détenteurs, par rôle

Les comptes de token de la mint sont regroupés par propriétaire, et chaque propriétaire est
nommé pour ce que la chaîne en montre : portefeuille (clé sur la courbe ed25519), courbe de
lancement, pool, verrou (Jupiter Lock, Streamflow), adresse de burn, ou compte de programme.
Courbes, pools, verrous et burn sont mis de côté : les parts des détenteurs portent sur ce qui
circule, et le rapport donne aussi chaque rôle en part de l'offre totale.

## Les tokens de référence

Douze tokens relus sur le réseau principal servent de référence
(`tests/fixtures/solana/REFERENCE.json`). Trois sont proposés comme exemples sur la page
d'accueil, chacun montrant une autre partie d'une lecture :

| Exemple       | Mint                                           | Ce qu'il montre                                                                   |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| The Poor Bull | `FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump` | lancement pump.fun ; le créateur a acheté à la création puis tout revendu         |
| FIONA         | `B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump` | token pump.fun diplômé vers PumpSwap                                              |
| PYUSD         | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 : délégué permanent, gel, hook de transfert et autres pouvoirs détenus |

## Non couvert

- Les launchpads autres que ces trois : leur token est lu comme une mint ordinaire, sans courbe
  ni graduation.
- Les détenteurs des positions de pools concentrés (CLMM, Whirlpool, DLMM) et de DAMM v1.
- Le code des programmes : un hook de transfert est nommé, son comportement n'est pas audité.
