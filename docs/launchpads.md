# Launchpads de Robinhood Chain

Relevé du 17/10/2026 sur le nœud public (`https://rpc.mainnet.chain.robinhood.com`,
tête ≈ 91 050 000) et l'API publique de DexScreener. Tout ce qui suit a été lu
on-chain : la transaction du premier mint de chaque token (son `to`, ses logs),
l'événement de lancement décodé champ par champ, puis compté sur tout
l'historique du contrat. Les noms de signature viennent de la base publique
openchain.xyz et ont été recalculés par keccak.

pons est presque à l'arrêt (d'après l'indexeur, aucun `TokenLaunched` depuis plus
de 33 h). Le flux
vivant passe par flap.sh, par d'autres contrats de lancement à courbe qui
graduent vers Uniswap v4, par Doppler, et par des contrats déployés directement
puis cotés sur v4.

## Les quinze tokens étudiés

Choisis sur DexScreener (volume 24 h, paires récentes, tous les `dexId` vus :
`uniswap` v3/v4, `flapsh`, `metric`).

| Token                     | Bloc du mint | `from` → `to` de la transaction                       | Événement de lancement                                  | Où il s'échange                        |
| ------------------------- | ------------ | ----------------------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| ROBINHOOD `0xb417…7777`   | 90 436 042   | `0x498b…d384` → `0xd3de…6666` (routeur flap.sh)       | flap.sh `TokenCreated` (créateur = le routeur)          | paire V2 `0xc10f…359e` (flapsh)        |
| 4663 `0xfb43…7777`        | 8 874 307    | `0x3775…3151` → `0xe9f7…197b` (fabrique de vaults)    | flap.sh `TokenCreated`, `FlapTaxVaultTokenCreated`      | courbe flap.sh, paire `0x9b97…AbA6`    |
| ELON `0xe747…7777`        | 18 329 349   | `0x35a8…d3f9` → `0xe9f7…197b`                         | flap.sh `TokenCreated`                                  | courbe flap.sh, paire `0x1550…b565`    |
| ROBINHOOD `0x008d…2005`   | 58 519 582   | `0x9a80…45f6` → `0xe33e…2948` (routeur)               | `0x7ed5…` `TokenLaunched` + routeur `Launched`          | courbe `0xc1f7…1f60`, puis v4          |
| ROBINHOOD `0xeec4…ae28`   | 76 031 705   | `0x86d1…e29a` → `0x6319…8ce2` (multicall)             | `0x7ed5…` `TokenLaunched`                               | v4 contre USDG                         |
| FRC `0x8ea2…615f`         | 90 272 322   | `0x8430…be37` → `0xe33e…2948`                         | `0x7ed5…` `TokenLaunched`                               | v4 contre TSLA                         |
| AGEM `0x7c04…5bfe`        | 89 107 964   | `0xab48…0730` → `0x3d6e…0091`                         | `0x3d6e…` `Launched`                                    | courbe `0xf6a7…f77b`, v4 `0xdd12…bba6` |
| PAYLOAD `0x9353…0e3a`     | 90 257 835   | `0x681d…b97d` → `0x3d6e…0091`                         | `0x3d6e…` `Launched`                                    | courbe `0x4c4b…633e`, v4 contre SPCX   |
| Wheel Smith `0xeb57…0684` | 90 389 156   | `0x5954…46b6` → `0xf05a…4b8d`                         | `0xf05a…` `TokenLaunched` + `Initialize` v4             | v4 contre TSLA, hook `0x9921…e044`     |
| MEME `0x385f…1e18`        | 53 697 172   | `0xa72a…2399` → `0x22e9…eeed`                         | `LaunchCreated` + Airlock Doppler `Create`              | v4 contre ETH (initializer `0x4e34…`)  |
| BOTCOIN `0xf5cd…109e`     | 89 334 863   | bundler `0xf22e…1ff5` → EntryPoint v0.7 `0x0000…a032` | Airlock Doppler `Create` (pas de créateur nommé)        | v4 contre SPCX et USDG                 |
| MPAD `0x2fc1…b25a`        | 89 559 296   | `0x8a91…f724` → `0xd8e6…6c88` (metricpad)             | metricpad `Launched`                                    | pool metric `0xf790…30be`              |
| SPATIAL `0x691d…a695`     | 90 348 283   | `0x48d0…8c9e` → création de contrat                   | aucun : déploiement direct, un seul log                 | v4 contre ETH, marché créé ensuite     |
| HIVEMIND `0xc4b7…ffc3`    | 90 559 498   | `0x5b8f…5752` → `0x1cba…a149`                         | aucun : mint vers `0x1cba…`, puis 205 transferts        | v4 contre ETH                          |
| JUGGERNAUT `0xd732…3b88`  | 126 005      | `0xe5f8…8361` → `0xd9ec…fccb`                         | pons `TokenLaunched` (1ʳᵉ génération, hors liste avant) | pool V3 `0x588b…2746` (metric)         |

## Les launchpads

| Launchpad                 | Contrat                                                                                  | Lancements | Premier bloc | Dernier bloc |
| ------------------------- | ---------------------------------------------------------------------------------------- | ---------- | ------------ | ------------ |
| pons, 5 générations       | `0xf4fc…`, `0xa24d…`, `0xa5aa…`, `0x0c37…`, `0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb` | ~330 000   | 61 869       | ouvert       |
| flap.sh (portail v5.23.1) | `0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09`                                             | 373 159    | 4 227 932    | ouvert       |
| launchpad `0x7ed5…`       | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`                                             | 699 362    | 27 027 321   | ouvert       |
| launchpad `0x3d6e…`       | `0x3d6ea4e97b8ab9e1a1b4943febffe22d8c920091`                                             | 1 936      | 88 527 856   | ouvert       |
| launchpad `0xf05a…`       | `0xf05a26e92e27b8f0385f6895f5507db26a2f4b8d`                                             | 211        | 87 735 869   | ouvert       |
| Doppler, façade `0x22e9…` | `0x22e99278308b393ea1260859b181ad7e78f5eeed`                                             | 31 742     | 8 658 626    | 59 235 550   |
| Doppler, Airlock          | `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862`                                             | 211 113    | 734 616      | ouvert       |
| metricpad                 | `0xd8e6fda8639b53c63ffe78eee5431d1af3c56c88`                                             | 1          | 89 559 296   | —            |
| Virtuals (launchpad)      | `0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007`                                             | 26 184     | 220 679      | ouvert       |
| Virtuals (gestion. taxe)  | `0x6d80b81d9fc56a7a839b1af9006eb49151961ce7`                                             | 26 185     | 220 679      | ouvert       |

### pons

`TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)`,
topic `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a`.
Créateur en topic 2, pool V3 au 2ᵉ mot. La génération `0xd9ec…` (60 142
lancements, blocs 61 869 à 6 880 646) émet le même `TokenLaunched` avec les
mêmes événements voisins (`TokenDeployed`, `PositionLocked` d'un locker) et
répond à `getLaunchedToken` selon la disposition documentée : elle manquait à
`PONS_FACTORIES`, et JUGGERNAUT était lu comme un token quelconque.

### flap.sh

Portail `0x2660…eb09` (`version()` = `v5.23.1`) : il tient toutes les courbes.
`TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)`,
topic `0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603`.
**Rien n'est indexé** : le créateur est le 2ᵉ mot des données, le token le 4ᵉ.
Le nœud ne peut donc pas filtrer les lancements d'un créateur ; seul l'indexeur
les liste.

Le `creator` de l'événement est l'appelant du portail. Sur les 225 lancements
des 100 000 derniers blocs, 196 viennent de cinq contrats `…6666` (40 chacun) et
un de la fabrique de vaults `0xe9f7…197b` : l'événement nomme alors le relais,
pas la personne. Règle retenue : quand le créateur nommé est le contrat appelé
par la transaction, le créateur est l'expéditeur de la transaction.

Échanges sur la courbe, émis par le portail :
`TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)`
(`0xa800a203…cce8ff7`) et `TokenSold(uint256 ts, address token, address seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)`
(`0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a`, 899
ventes sur les 3 M derniers blocs). Les tokens portent le suffixe `7777`. Après la
courbe, une paire V2 (dexId DexScreener `flapsh`).

### Launchpad `0x7ed5…`

`TokenLaunched(address indexed token, address indexed curve, address indexed creator, address, uint256, uint256)`,
topic `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`.
Le routeur `0xe33e9e479df8802cb0866d5d05258bec4cf62948` émet en plus
`Launched(address indexed token, address indexed curve, address indexed creator, address, uint256, uint256)`
(`0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37`, 459 887
lancements, mêmes blocs). Il nomme le portefeuille qui l'a appelé là où la
factory peut nommer un contrat intermédiaire : pour `0xeec4…`, la factory nomme
`0x274a…` (un contrat), le routeur `0x86d1…`, l'expéditeur. SEAL lit les deux
et retient l'enregistrement qui nomme l'expéditeur. Chaque token a sa courbe (topic 2), qui émet
`CurveBuy(address,address,uint256,uint256,uint256,uint256)` (`0xec36bf57…c455`)
et `CurveSell(…)` (`0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df`),
puis gradue vers Uniswap v4. Nom public non vérifié : il est désigné par son
adresse.

### Launchpad `0x3d6e…`

`Launched(address indexed token, address indexed curve, address indexed creator, (address,address,address,address,address,(address,address,uint24,int24,address),bytes32,bool,string,string,string,uint64,uint128,uint256,uint256,uint256,uint256,uint16,uint16,uint16,bool,uint16[],uint256,uint16,uint256,address) params)`,
topic `0xa0354dae199953f2dbde6be8415166a744e7f92b7328671692196d8fdbb6bd9d`.
Le 12ᵉ mot des données (`bytes32`) est l'identifiant du marché v4 vers lequel le
token gradue : pour AGEM, `0xdd12…bba6`, la paire que liste DexScreener. La
courbe (topic 2) émet `Trade(address,address,address,address,uint8,bool,uint256,…)`
(`0xaca20dddb264298fd1f9f05d1dc1e0847e30f73956ee42aaf896b91eb73628b6`). Les
tokens sont cotés contre des actions tokenisées (SKHY, SPCX). Le site d'AGEM
est agentm.fun, ce qui ne suffit pas à nommer le contrat.

### Launchpad `0xf05a…`

`TokenLaunched(address indexed token, address indexed creator, address indexed quote, bool)`,
topic `0x8f9d1d4b2dfe54f1d49ec1d5b6a7b5bc380b5fac115339c49e671127d1481c69`.
Pas de courbe : le marché v4 est initialisé dans la même transaction, avec le
hook `0x992118de23b4ebe9f527dacbbb7d8d4bbbf8e044` (`LaunchLiquidity`,
`SwapFeeAccrued`), contre une action tokenisée (TSLA pour Wheel Smith).

### Doppler

L'Airlock `0xeb7c…0862` émet
`Create(address asset, address indexed numeraire, address initializer, address poolOrHook)`
(`0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab`), qui
**ne nomme pas le créateur** : il est lu comme l'expéditeur de la transaction,
ou le compte de la UserOperation quand elle passe par l'EntryPoint ERC-4337
(BOTCOIN, site anoncoin.it). L'initializer v4 `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544`
émet `Create(address,address,address)` et `Lock(address,(address,uint96)[])`.
La façade `0x22e9…eeed` émet
`LaunchCreated(address indexed token, address indexed, address indexed numeraire, address initializer, address creator, bytes32, uint48, uint48, string)`
(`0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b`),
créateur au 2ᵉ mot des données ; elle ne lance plus depuis le bloc 59 235 550.

### metricpad

`Launched(address indexed creator, address indexed token, address indexed pool, address, string, string, string)`,
topic `0x14ab72c95fd9b13db14c65da0cd02173bfd0aea9005b9ed422810bb985b5942e`
(la chaîne `metricpad.me` est dans les données). Un seul lancement, MPAD ; le
pool (topic 3) est la paire `metric` de DexScreener.

### Virtuals

Relevé du 18/10/2026, sur SIRIUS (`0x72e9…6c88`) puis sur l'historique
complet des deux contrats. La page officielle des adresses de Virtuals
(whitepaper.virtuals.io, « Virtuals Protocol Contract Addresses ») nomme, pour
Robinhood Chain, le token VIRTUAL `0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31`
et le contrat de courbe (« Bonding ») `0xd4cc…d007`. Le code est celui du dépôt
public `Virtual-Protocol/protocol-contracts` (`contracts/launchpadv2/BondingV5.sol`,
`BondingConfig.sol`, `FPairV2.sol`).

**La transaction de lancement de SIRIUS** (`0xb0cac924…`, bloc 48 392 950,
28/08/2026) est envoyée par `0xc47f…d9bed9f` à `0xd4cc…`, sélecteur
`0xa2baa044` = `preLaunch(string,string,uint8[],string,string,string[4],uint256,uint256,uint8,uint16,bool,uint8,bool,bytes)`.
Ses 17 logs, dans l'ordre :

- 10 VIRTUAL du créateur vers `0x86cb…3a9c` = `feeTo()` de la configuration :
  le frais de l'ACF (« Activating ACF costs a 10 $VIRTUAL fee », whitepaper) ;
- le token (`OwnershipTransferred`, mint de 1 milliard vers `0xd4cc…`) ;
- `PairCreated` de la fabrique Uniswap V2 `0x8bce…937f` : la paire
  SIRIUS/VIRTUAL `0x8285…dba5`, créée dès le lancement, et
  `LiquidityPoolCreated(0x8285…)` émis par le token ;
- `NewApplication(id)` de l'AgentFactory `0x43e4…c2d4` ;
- `PairCreated` de la fabrique de courbes `0xfc2e…20a9` : la paire de courbe
  (FPair) `0x0539…34f0` ; 500 M lui sont transférés (`Mint(reserve0, reserve1)`
  avec une liquidité VIRTUAL fictive) ;
- 500 M de `0xd4cc…` vers `0x81f7…1415` ;
- `TokenRegistered(token indexé, creator indexé, address)` du gestionnaire de
  taxe `0x6d80…1ce7` ;
- `PreLaunched(token indexé, pair indexé, virtualId, initialPurchase, (launchMode, airdropBips, needAcf, antiSniperTaxType, isProject60days))`
  (`0xb9ee8aa6…bc8f`) : pour SIRIUS (0, 0, **true**, 4, false) ;
- `PreLaunchExtParams(token, …)` (`0x28f9cacb…02b9`).

**Ce qu'est chaque adresse**, lu sur la chaîne :

| Adresse       | Ce que c'est                                                                                                                                                                | Preuve                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0xd4cc…d007` | le launchpad de Virtuals (proxy de 1 167 octets)                                                                                                                            | page officielle ; `bondingConfig()` = `0x3e33…3e2f`, `factory()` = `0xfc2e…`, `router()` = `0xca63…6081`, `agentFactory()` = `0x43e4…` ; 26 184 `PreLaunched`                                                                                                 |
| `0x0539…34f0` | la paire de courbe (FPair) de SIRIUS : 50 % à la création                                                                                                                   | topic 2 de `PreLaunched` ; `Swap(uint256,uint256,uint256,uint256)` (`0x298c349c…`) à chaque achat ; vide aujourd'hui (graduation : `Graduated(token, agentToken)` du launchpad au bloc 70 428 026, 23/09/2026)                                                |
| `0x8285…dba5` | la paire Uniswap V2 SIRIUS/VIRTUAL, le marché après graduation (13,1 %)                                                                                                     | `PairCreated` ; `getReserves()` ; listée par DexScreener ; taxe de 1 % à l'achat et à la vente vers `0x6d80…` (`projectBuyTaxBasisPoints()` = `projectSellTaxBasisPoints()` = 100)                                                                            |
| `0x81f7…1415` | le **portefeuille de réserve de Virtuals** (un portefeuille, 64 277 transactions)                                                                                           | `teamTokenReservedWallet()` de la configuration `0x3e33…` ; `reserveSupplyParams()` = (500, 5 500, 5 000) : avec `needAcf`, 50 % réservés lui sont envoyés                                                                                                    |
| `0xe289…ee8a` | le **portefeuille de l'ACF** (Automated Capital Formation) de Virtuals, partagé (4 926 transactions)                                                                        | reçoit 25 % de `0x81f7…` à chaque lancement ACF échantillonné (SIRIUS, UMBRA, MIKO, SYNA, POPHIE, HOUSE), en quelques minutes ; pour SIRIUS, à +29 s ; le 23/09/2026 il a envoyé 70,5 M à `0x3eb3…`, qui en a placé 50,5 M dans le pool V3 `0x1991…`          |
| `0x75eb…29e1` | le **verrou TokenTable** (Sign) de SIRIUS, pour le créateur                                                                                                                 | clone minimal (44 octets) de `0x6b75…0b5c` ; `version()` = « 2.7.7-TTUnlocker-cancun », `getProjectToken()` = SIRIUS, `owner()` = `0x81f7…`, `deployer()` = `0x07cd…` (déployeur TokenTable, `deployTTSuite`) ; `isCancelable()` et `isWithdrawable()` = true |
| `0x1991…16c9` | un pool Uniswap V3 SIRIUS/USDG (0,3 %), absent de DexScreener : la liquidité de l'ACF                                                                                       | `token0()` = USDG `0x5fc5…`, `token1()` = SIRIUS, `fee()` = 3 000, `factory()` = `0x1f7d…` ; rempli par `0x3eb3…` en une transaction (81 transferts)                                                                                                          |
| `0x3eb3…f852` | un contrat de lots (Multicall3 avec administrateurs) par lequel passe l'ACF de SIRIUS ; 2 % y attendent                                                                     | `batchTransferTokens`, `aggregate3` ; propriétaire `0x6522…0af6`                                                                                                                                                                                              |
| `0x9080…74b8` | un portefeuille-contrat (compte ERC-4337)                                                                                                                                   | proxy à balise ; `entryPoint()` = EntryPoint v0.7 ; rôles `ROLE_DEFINITIVE`, `swapV2` : un coffre de trading ; alimenté par un contrat de règlement de solveur (`0x97ca…`, `fulfil`/`refund`)                                                                 |
| `0x3248…f337` | un portefeuille (41 624 transactions) qui a acheté 35,7 M sur la courbe en 12 achats (`buy` du launchpad) entre +1 h 44 et +12 h 44, puis les a versés au verrou TokenTable | transferts depuis `0x0539…`, puis vers `0x75eb…` (tx `0x0f76673d…`) ; son rôle chez Virtuals n'est pas établi                                                                                                                                                 |

**Le verrou TokenTable** : deux échéanciers (`actuals(0)`, `actuals(1)`), tous
deux au créateur (`ownerOf` des NFT `futureToken()` `0x30c8…`) :

- 250 M (25 %), départ 28/08/2027 : 16,66 % puis cinq tranches de 30 jours,
  dernière le 25/01/2028 (`getEncodedPreset` : débuts [0, 1], fin 12 960 001 s,
  bips [1 666, 8 334], déblocages [1, 5]) — l'« équipe » de l'ACF : « locked
  for one year after TGE, then vests linearly over six months » (whitepaper) ;
- 35,7 M (3,6 %), départ 29/11/2026 : neuf tranches mensuelles jusqu'au
  27/07/2027.

Rien n'est réclamé (`calculateAmountClaimable` = 0). Le gestionnaire du verrou
(`owner()`, le portefeuille de réserve de Virtuals) peut encore annuler des
échéanciers et retirer le dépôt (`isCancelable`, `isWithdrawable`) : le verrou
tient à Virtuals, pas au seul code.

**La graduation** se lit à l'événement du launchpad lui-même :
`Graduated(address indexed token, address agentToken)` (`0x381d54fa…7e07e`).
SIRIUS a gradué au bloc 70 428 026 (23/09/2026, tx `0x1b082665…`). Dans
cette transaction, la paire de courbe rend ce qu'elle tient (15,1 %) au
launchpad, qui en envoie 10,47 % à la paire Uniswap v2 (via le contrat du
token) et 4,45 % au portefeuille `graduationExcessBurnWallet()` de la
configuration, `0xaea2…2aa9` : les tokens adossés à la liquidité VIRTUAL
fictive de la courbe (`_openTradingOnUniswap` de `BondingV5.sol`). Malgré son
nom, ce portefeuille n'a rien brûlé pour SIRIUS : il a passé ces 4,45 % en 14
parts égales de 0,318 % à un contrat de réclamation Merkle `0x6da0…c744`
(`merkleRoot()`, `claim(address,uint256,bytes32,bytes32[])`,
`cumulativeClaimed`), d'où 24 adresses ont réclamé. Le reste de la courbe,
environ 35,1 %, a été acheté sur la courbe avant la graduation. SEAL lit la
graduation de chaque lancement Virtuals du créateur (une requête sur le
launchpad, filtrée par les tokens), et pour le token analysé la transaction
de graduation : le flux de l'offre montre alors la branche de la courbe
entière (acheté sur la courbe, versé à la paire, versé au portefeuille
d'excédent).

**ACF n'est pas ACP.** ACF (Automated Capital Formation) est le module de
lancement qui réserve 50 % : 25 % vendus par Virtuals via des pools successifs
de 2 M$ à 160 M$ de FDV, le produit allant aux fondateurs, et 25 % d'équipe
verrouillés. ACP (Agent Commerce Protocol) est le protocole de paiement entre
agents, avec séquestre des paiements : aucun contrat ACP ne détient de
SIRIUS, et SIRIUS a été lancé en mode normal (`launchMode` = 0 ; le mode 2
est `LAUNCH_MODE_ACP_SKILL`). Sur les 26 184 lancements Virtuals, 3 266 ont
l'ACF.

**Ce que SEAL lit** : le gestionnaire de taxe nomme le créateur en topic 2
(26 185 `TokenRegistered`, un par lancement, dans la même transaction que
`PreLaunched` ; créateur = expéditeur sur 25 lancements tirés au hasard) : il
sert d'enregistrement de lancement, et ses lancements se listent par le nœud et
par l'indexeur. Le launchpad donne la courbe ; les deux enregistrements d'un
même lancement sont fusionnés. Les ventes sur la courbe se reconnaissent au
`Swap` de la FPair ; la paire V2 est trouvée par son `PairCreated`.

### Sans launchpad

- **Déploiement direct** (SPATIAL) : la transaction crée le contrat, un seul log ;
  le marché v4 vient après, dans une autre transaction. Le créateur est le
  déployeur. Ses autres déploiements ne se listent pas depuis les logs.
- **Mint par un contrat** (HIVEMIND) : le premier mint part vers le contrat
  appelé, qui distribue aussitôt. Le créateur retenu est l'expéditeur, avec la
  réserve déjà affichée (« lancé via `0x1cba…` »).

## Ce que SEAL en fait

- `src/lib/chain/launchpads.ts` : le registre `LAUNCHPADS` (nom, adresse,
  événement, topic, position du token, du créateur, de la courbe, du pool ou du
  marché, événements d'échange de la courbe, premier et dernier bloc).
  `PONS_FACTORIES` en est dérivé.
- **Créateur** : l'événement de lancement du token, sinon l'expéditeur. Si
  l'événement nomme un contrat (le routeur appelé, un exécuteur de lots), le
  créateur est l'expéditeur, ou le compte de la UserOperation ERC-4337.
- **Autres lancements** : une requête par launchpad dont l'événement indexe le
  créateur, par fenêtre de 10 M de blocs, en un seul batch ; flap.sh et la
  façade Doppler par l'indexeur ; les déploiements directs restent « non
  listés », et le rapport le dit. Sur le nœud public (≈ 4 requêtes de logs par
  seconde, 30 s par analyse), la liste tient en 18 requêtes : le launchpad du
  token d'abord, puis les ouverts, chacun lu en entier ou pas du tout. pons (22
  requêtes) est alors laissé à l'indexeur et marqué « non listé ». Les
  launchpads que l'indexeur a lus jusqu'à la tête (`/v1/coverage`) ne sont pas
  redemandés au nœud.
- **Ventes du créateur** : un transfert vers une courbe n'est une vente que si
  la courbe a émis son événement d'échange dans la même transaction ; vers un
  pool V2/V3 ou le PoolManager, que s'il y a eu un `Swap`. Les marchés atteints
  après le lancement (paires DexScreener, identifiant v4 de l'événement) sont
  inclus.
- **Rejeu du lancement** : la courbe et les paires comptent comme « pool ».
- **Graduation** : lue sur pons et sur Virtuals (événement `Graduated`) ;
  ailleurs « non mesurée », ou « ne s'applique pas » sans courbe.
- **Indexeur** : colonne `launchpad`, un curseur par contrat, `/v1/coverage`.
- **Rôles** (`src/lib/chain/roles.ts`) : les plus gros détenteurs et les
  destinataires du lancement sont nommés par ce qu'ils répondent — verrou
  TokenTable (échéanciers, bénéficiaire, part encore verrouillée, gestionnaire),
  pool V2/V3 (`token0`/`token1`, `fee` ou `getReserves`), compte ERC-4337
  (`entryPoint`) — ou par la configuration du launchpad (portefeuilles de
  réserve et d'ACF de Virtuals). Un verrou et un pool non listé sont mis de côté
  des parts de concentration, et le rapport le dit.
- **Flux de l'offre** (`src/lib/supply-flow.ts`) : mint → premiers détenteurs →
  ce qu'ils ont passé à d'autres pendant la fenêtre, avec les parts, les noms par
  rôle et ce que chacun détient aujourd'hui ; en tête du rapport et du résumé.

## Avant / après

| Token                 | Launchpad reconnu (après)  | Créateur  | Lancements du créateur | Ventes confirmées / lancements vérifiés | Échanges dans le rejeu | Marché DexScreener |
| --------------------- | -------------------------- | --------- | ---------------------- | --------------------------------------- | ---------------------- | ------------------ |
| ROBINHOOD `0xb417…`   | flap.sh                    | `0x498b…` | ≥ 1 → ≥ 1              | 0/1 → 0/1                               | 0 → 1                  | oui → oui          |
| 4663 `0xfb43…`        | flap.sh                    | `0x3775…` | 1 → ≥ 1                | 0/1 → 0/1                               | 0 → 38                 | oui → oui          |
| ELON `0xe747…`        | flap.sh                    | `0x35a8…` | 1 → ≥ 1                | 0/1 → 1/1                               | non → 39               | oui → oui          |
| ROBINHOOD `0x008d…`   | launchpad 0x7ed5…          | `0x9a80…` | 1 → 1                  | 0/1 → 0/1                               | non → 38               | oui → oui          |
| ROBINHOOD `0xeec4…`   | launchpad 0x7ed5…          | `0x86d1…` | 649 → 649              | 0/0 → 1/11                              | non → 37               | oui → oui          |
| FRC `0x8ea2…`         | launchpad 0x7ed5…          | `0x8430…` | 2 → 2                  | 0/2 → 1/2                               | non → non              | oui → oui          |
| AGEM `0x7c04…`        | launchpad 0x3d6e…          | `0xab48…` | 1 → 1                  | 0/1 → 0/1                               | non → non              | oui → oui          |
| PAYLOAD `0x9353…`     | launchpad 0x3d6e…          | `0x681d…` | 3 → 3                  | 0/3 → 0/3                               | non → non              | oui → oui          |
| Wheel Smith `0xeb57…` | launchpad 0xf05a…          | `0x5954…` | 1 → 1                  | 1/1 → 1/1                               | non → non              | oui → oui          |
| MEME `0x385f…`        | Doppler launchpad 0x22e9…  | `0xa72a…` | ≥ 1 → ≥ 1              | 0/1 → 0/1                               | 38 → 38                | oui → oui          |
| BOTCOIN `0xf5cd…`     | Doppler                    | `0x5ee0…` | ≥ 1 → ≥ 1              | 0/1 → 0/1                               | 0 → 0                  | oui → oui          |
| MPAD `0x2fc1…`        | metricpad                  | `0x8a91…` | 1 → 1                  | 0/1 → 0/1                               | 0 → 2                  | oui → oui          |
| SPATIAL `0x691d…`     | aucun (lu par le 1er mint) | `0x48d0…` | ≥ 1 → ≥ 1              | 0/0 → 0/1                               | non → non              | oui → oui          |
| HIVEMIND `0xc4b7…`    | aucun (lu par le 1er mint) | `0x5b8f…` | ≥ 1 → ≥ 1              | 0/1 → 0/1                               | non → non              | oui → oui          |
| JUGGERNAUT `0xd732…`  | pons                       | `0xe5f8…` | 5 → 19                 | 4/5 → 4/9                               | 4 → 4                  | oui → oui          |

Produit par `tests/live/launchpads.live.test.ts` (`SEAL_LIVE=1`), qui appelle
`collect()` directement sur le nœud public, sans indexeur ni clé Blockscout,
sans modèle. « ≥ » : les autres lancements ne peuvent pas être listés depuis le
nœud, le nombre est un minimum.

- Avant, aucun token hors pons n'avait de launchpad nommé : tous étaient
  « tracés depuis le premier mint ». Après, 13 des 15 ont le leur ; SPATIAL
  (déploiement direct) et HIVEMIND (mint par un contrat) n'en ont pas, et le
  disent.
- 4663 et ELON : avant, « 1 lancement listé » venait d'un registre deviné, la
  fabrique de vaults `0xe9f7…` (`FlapTaxVaultTokenCreated`), qui ne voit que
  ses propres lancements. flap.sh n'indexe pas le créateur : sans indexeur, le
  rapport dit maintenant « au moins 1 ».
- ELON, FRC, `0xeec4…` : ventes du créateur confirmées par l'événement
  d'échange de la courbe (`TokenSold`, `CurveSell`) ou par un `Swap` du
  PoolManager. Avant, la courbe n'était pas connue : aucune vente sur une courbe
  ne pouvait être vue, et pour `0xeec4…` aucun lancement n'était vérifié.
- Rejeu : la courbe et les paires DexScreener comptent comme marché, les
  achats sur la courbe ne sont plus lus comme des « allocations ». Les « non »
  restants sont des refus du nœud public (429) pendant la reconstruction des
  détenteurs depuis la chaîne, déjà présents avant ; lancé seul, le rejeu de
  Wheel Smith aboutit (153 mouvements). Il est maintenant redemandé une fois
  après une pause.
- JUGGERNAUT : avant, la génération pons `0xd9ec…` manquait, le token était lu
  comme quelconque et « 4 ventes sur 5 » venaient de transferts vers la factory,
  sans confirmation. Après : lancement pons, 9 lancements pons et 10 sur
  d'autres launchpads, ventes confirmées par le pool.

## Non couvert

- **Déploiements directs** : un contrat créé par un portefeuille n'émet pas
  d'événement ; ses autres déploiements ne se listent pas depuis les logs.
  Affiché « Not listed: contracts deployed directly ».
- **Doppler (Airlock)** : `Create` ne nomme pas le créateur, rien à filtrer ni
  à indexer par créateur.
- **flap.sh via un relais** : quand l'événement nomme un routeur, l'indexeur
  range le lancement sous le routeur ; les autres lancements de la personne ne
  sont donc pas listés.
- **Graduation** hors pons : non lue (« not measured on flap.sh ») ; elle ne
  s'applique pas aux launchpads sans courbe (`0xf05a…`, metricpad) ni aux
  déploiements directs.
- **Échanges indexés** : l'indexeur ne compte les swaps que des pools pons ;
  pour les autres tokens, le marché vient de DexScreener seul.
- **Noms** : `0x7ed5…`, `0x3d6e…`, `0xf05a…` sont désignés par leur adresse,
  faute de nom public vérifiable on-chain.
