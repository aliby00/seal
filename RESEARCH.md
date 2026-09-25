# RESEARCH — vérifications techniques

Étape 1 du brief : rien n'est codé sur une supposition non vérifiée. Ce document
consigne ce qui a été **mesuré en direct** contre les APIs réelles, ce qui vient
d'une documentation, et ce qui reste **non confirmé**.

Les sondes sont rejouables : `pnpm tsx scripts/probe-rpc.ts`, `probe-blockscout.ts`,
`probe-dexscreener.ts`.

Mesures effectuées le **25 septembre 2026**.

Légende : ✅ vérifié en direct · 📄 documentation seule · ❌ contredit · ❓ non confirmé

---

## 1. Robinhood Chain — RPC

Source : <https://docs.robinhood.com/chain/connecting>

| Élément       | Valeur                                                      | Statut                                              |
| ------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| RPC mainnet   | `https://rpc.mainnet.chain.robinhood.com`                   | ✅                                                  |
| Chain ID      | `4663` / `0x1237`                                           | ✅ `eth_chainId` → `0x1237`, `net_version` → `4663` |
| Client        | `nitro/v3.12.0-rc.3`                                        | ✅ `web3_clientVersion` — pile **Arbitrum Orbit**   |
| Devise native | ETH                                                         | 📄                                                  |
| Explorateur   | `https://robinhoodchain.blockscout.com`                     | 📄                                                  |
| WebSocket     | `wss://feed.mainnet.chain.robinhood.com` (sequencer feed)   | 📄                                                  |
| Testnet       | `https://rpc.testnet.chain.robinhood.com`, chain ID `46630` | 📄                                                  |

### Temps de bloc et taille de la chaîne

Mesuré sur deux paires de blocs espacées de 1 M et 10 M :

```
(1790288879 - 1789279261) / 10 000 000 = 0,1010 s par bloc
```

- **0,101 s par bloc**, soit **~855 800 blocs par jour** ✅
- Bloc courant au moment de la mesure : **71 727 569**
- Âge de la chaîne : ~84 jours → genèse vers le **3 juillet 2026** ✅

### `eth_getLogs` — la limite n'est pas celle supposée

Le brief supposait « 1000 résultats par appel ». **C'est faux.** Réponse exacte du nœud :

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32000, "message": "logs matched by query exceeds limit of 10000" }
}
```

- Limite réelle : **10 000 logs par appel** ✅
- **Aucune limite de plage de blocs observée** ✅ — une requête `fromBlock: 0x0, toBlock: latest`
  est acceptée ; elle n'échoue pas sur l'étendue.

**Un second mode d'échec existe**, observé lors d'une réexécution de la sonde : sur une
requête couvrant toute la chaîne, le nœud peut répondre avant d'avoir compté les résultats :

```json
{ "error": { "code": -32000, "message": "log query timed out" } }
```

Il faut donc traiter **trois** issues distinctes pour un `eth_getLogs` :
dépassement de 10 000 résultats, timeout de requête, et rate limit (429/403).
Les trois se résolvent de la même façon — resserrer la fenêtre — mais elles ne portent
pas le même message, et un code qui ne reconnaîtrait que la première boucherait sur les
deux autres.

**Conséquence pour l'implémentation :** le découpage doit être piloté par le **volume de
logs**, pas par une taille de fenêtre fixe. Une fenêtre adaptative qui se divise en deux
dès qu'elle approche 10 000 est la bonne stratégie.

### Rate limit — non documenté, et sévère

La documentation dit seulement : _« rate-limited and not recommended for production use »_,
sans chiffre. Mesuré :

- après ~6 `eth_getLogs` rapprochés : `429 Too Many Requests` en série ✅
- puis **`403 Forbidden` au niveau HTTP**, pas seulement JSON-RPC ✅

**Conséquence :** un backfill complet de l'historique d'un créateur sur le RPC public
n'est pas réaliste. Cela valide la ligne « RPC payant ≤ 50 $ » du build plan et recoupe
le risque n°3 déjà assumé dans le whitepaper. Alternatives repérées : Alchemy
(`robinhood-mainnet.g.alchemy.com`), Dwellir (archive).

---

## 2. pons — factory et graduation

Source : <https://docs.ponsfamily.com/>

### ❌ L'adresse du factory dans la documentation est périmée

La documentation officielle annonce :

- factory « actif » : `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (start block 8991118)
- factory « legacy » : `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` (start block 8600612)

En interrogeant `TokenLaunched` **sur toute la chaîne** sur les 500 000 derniers blocs
(~14 h), toutes les émissions viennent d'une seule adresse, et ce n'est aucune des deux :

```
0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75   ← factory réellement vivant
```

Et `graduationStatus()` **revert** sur le `0xA5aA…` de la documentation pour un token récent,
alors qu'il répond correctement sur le `0xf4fc…`.

Au moins quatre adresses ont du bytecode déployé (`0x0c37`, `0x7ed5` cité par Bitquery,
`0xA5aA`, `0xf4fc`).

> **Règle qui en découle :** l'adresse du factory ne doit jamais être une constante copiée
> d'une documentation. Elle se découvre dynamiquement, ou se configure.

Rythme de lancement observé : **15 lancements en ~14 h**, soit **~26 tokens/jour**.

### `TokenLaunched` — ABI vérifiée sur un log réel

topic0 : `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a`

```solidity
event TokenLaunched(
  address indexed token,
  address indexed deployer,
  address indexed dexFactory,
  address pairToken,
  address pool,
  uint256 dexId,
  uint256 launchConfigId,
  uint256 positionId,
  uint256 restrictionsEndBlock,
  uint256 initialBuyAmount
)
```

Décodage d'un log réel — 7 mots de `data`, correspondance exacte avec l'ABI ✅ :

| Champ                     | Valeur observée                                     |
| ------------------------- | --------------------------------------------------- |
| `dexFactory` (topic3)     | `0x1f7d7550…` = le factory **Uniswap V3**           |
| `pairToken`               | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` = WETH |
| `pool`                    | `0x668942551AffD4Ee3a2E570366aaEF28b56c3A97`        |
| `dexId`, `launchConfigId` | `0`                                                 |
| `initialBuyAmount`        | `100000000000000` = 0,0001 ETH                      |

### `graduationStatus(address)` — vérifié en direct

Selector calculé : **`0x98d652f1`**

```solidity
function graduationStatus(address token) view returns (
  uint256 pairedPrincipal,
  uint256 threshold,
  bool graduated
)
```

Appel réel sur un token live :

```
pairedPrincipal = 0,002235 ETH
threshold       = 4,2 ETH      ← confirme le seuil documenté
graduated       = false        → progression 0,053 %
```

### Économie du token

| Élément                    | Valeur                            | Statut |
| -------------------------- | --------------------------------- | ------ |
| Supply fixe                | 1 000 000 000 (1e9)               | 📄     |
| Fee de pool                | 1 % (10 000 bps)                  | 📄     |
| Launch fee                 | 0,0005 ETH                        | 📄     |
| Split créateur / protocole | 70 / 30 (actif), 90 / 10 (legacy) | 📄     |
| Seuil de graduation        | 4,2 ETH                           | ✅     |
| DEX                        | Uniswap **V3**                    | ✅     |

### ❌ Contradiction avec les sources tierces

Plusieurs sources (Bitquery, Mobula, un article DEV.to) décrivent pons avec une **bonding
curve**, des pools **Uniswap v4** et un « meme hook ». La documentation officielle dit
littéralement l'inverse — _« There is no bonding curve and no migration later »_ — et la
chaîne confirme la documentation officielle : `dexFactory` pointe sur le factory V3, et
DexScreener étiquette le pool `labels: ["v3"]`.

**Ne pas construire sur les docs tierces pour ce point.**

### ❓ Non élucidé

`restrictionsEndBlock` vaut `26 050 559` sur un log récent, alors que le bloc courant est
71,7 M. Ce numéro ne correspond pas à la numérotation de blocs L2. Hypothèse : un numéro de
bloc L1. **À ne pas utiliser tant que ce n'est pas compris.**

---

## 3. Blockscout

Sources : <https://docs.blockscout.com/robinhood-api>, <https://robinhoodchain.blockscout.com/api-docs>

### L'instance publique est inutilisable côté serveur

`robinhoodchain.blockscout.com` est derrière un challenge Cloudflare. Depuis un serveur :

```
HTTP/2 403
server: cloudflare
<!DOCTYPE html>…<title>Just a moment...</title>
```

### L'API PRO demande une clé, même en gratuit

Base : `https://api.blockscout.com/4663/api/v2/…`

Sans clé :

```
HTTP 402
{"error":"Proceed with API key or make a X402 payment to continue"}
```

| Élément                  | Valeur                                              | Statut |
| ------------------------ | --------------------------------------------------- | ------ |
| Clé                      | obligatoire, gratuite sur `dev.blockscout.com`      | ✅     |
| Tier gratuit             | **5 req/s**, **100 000 crédits/jour**               | 📄     |
| Holders                  | `GET /4663/api/v2/tokens/{addr}/holders`            | 📄     |
| Transferts               | `GET /4663/api/v2/addresses/{addr}/token-transfers` | 📄     |
| API compatible Etherscan | `?module=account&action=…`                          | 📄     |

### ❓ Non confirmé

La pagination (`next_page_params`) n'est pas documentée sur la page Robinhood et n'a pas pu
être testée faute de clé. À vérifier dès qu'une clé est disponible.

---

## 4. DexScreener

Source : <https://docs.dexscreener.com/api/reference>

| Élément        | Valeur                                                                      | Statut |
| -------------- | --------------------------------------------------------------------------- | ------ |
| Slug de chaîne | **`robinhood`**                                                             | ✅     |
| Endpoint       | `GET https://api.dexscreener.com/token-pairs/v1/robinhood/{tokenAddress}`   | ✅     |
| Clé API        | aucune                                                                      | ✅     |
| Rate limit     | 300 req/min (pairs / tokens / search), 60 req/min (profiles / boosts / ads) | 📄     |

`robinhoodchain`, `rhc` et `4663` renvoient une liste vide — seul `robinhood` fonctionne ✅.

Réponse réelle sur un token pons lancé quelques heures plus tôt :

```json
{
  "chainId": "robinhood",
  "dexId": "uniswap",
  "labels": ["v3"],
  "pairAddress": "0x668942551AffD4Ee3a2E570366aaEF28b56c3A97",
  "priceUsd": "0.000003654",
  "liquidity": { "usd": 3654.24, "base": 998358847, "quote": 0.002235 },
  "volume": { "h24": 485.73, "h6": 485.73, "h1": 485.73, "m5": 0 },
  "txns": { "h24": { "buys": 4, "sells": 3 } },
  "fdv": 3654,
  "pairCreatedAt": 1790287702000
}
```

### Le recoupement à trois sources tombe juste

C'est le résultat le plus important de cette phase :

|                  | RPC                               | DexScreener                     |
| ---------------- | --------------------------------- | ------------------------------- |
| adresse du pool  | champ `pool` du log = `0x668942…` | `pairAddress` = `0x668942…` ✅  |
| ETH dans le pool | `pairedPrincipal` = 0,002235      | `liquidity.quote` = 0,002235 ✅ |

L'event on-chain, l'état de graduation et l'état du marché se croisent sur la même clé.
Le pipeline à trois modules du brief tient debout.

À noter : `txns.h24 = 4 achats / 3 ventes` pour 485 $ de volume — exactement le genre de
signal « volume réel contre aller-retour artificiel » que le whitepaper veut faire raisonner
l'agent.

---

## 5. Claude API

Source : <https://platform.claude.com/docs/en/about-claude/pricing>

SDK : **`@anthropic-ai/sdk`** (officiel TypeScript).

| Modèle    | Entrée $/MTok | Sortie $/MTok | Cache read |
| --------- | ------------- | ------------- | ---------- |
| Opus 5    | 5,00          | 25,00         | 0,50       |
| Sonnet 5  | 2,00          | 10,00         | 0,20       |
| Haiku 4.5 | 1,00          | 5,00          | 0,10       |

Cache : write 5 min = 1,25×, write 1 h = 2×. Batch API = −50 % (inutile ici, il faut du
temps réel). Fenêtre de 1 M tokens au tarif standard.

### Coût par requête

Hypothèse : ~6 000 tokens d'entrée (historique créateur + top holders + état du marché),
~700 tokens de sortie.

| Modèle                | $/requête | $/mois à 100 req/jour |
| --------------------- | --------- | --------------------- |
| Opus 5                | ~0,048    | ~142 $                |
| **Sonnet 5** (retenu) | ~0,019    | **~57 $**             |
| Haiku 4.5             | ~0,0095   | ~29 $                 |

Le budget de 30 $/mois du build plan correspond à **Haiku 4.5** avec un contexte sous
~6 k tokens. Sonnet 5 a été retenu : la qualité du raisonnement est le produit. Le coût
réel sera mesuré (T3.6) avant d'envisager une redescente.

Deux facteurs aggravants à connaître :

- les modèles 4.7+ (donc Sonnet 5) utilisent un tokenizer produisant **~30 % de tokens en
  plus** pour le même texte ;
- le prompt caching ne couvre que le préfixe stable (system prompt) — les données du token
  changent à chaque requête et sont payées plein tarif.

---

## Récapitulatif des points ouverts

| #   | Point                                                                         | Bloque                         |
| --- | ----------------------------------------------------------------------------- | ------------------------------ |
| 1   | Pagination Blockscout `next_page_params`                                      | module holders (T3.2)          |
| 2   | `restrictionsEndBlock` incohérent avec la numérotation L2                     | rien, à ignorer pour l'instant |
| 3   | Rate limit du RPC payant retenu                                               | backfill complet (T4.1)        |
| 4   | Combien de générations de factory, et comment les énumérer                    | résolution dynamique (T3.1)    |
| 5   | Concurrents : PonsScan, ponscan.fun, xroot.dev, Blockaid, RobinSight / $SIGHT | calibration du ton (T3.5)      |
| 6   | Version longue de `seal-build-plan-internal-en.pdf`                           | périmètre                      |
