# Indexeur SEAL

Un petit service autonome qui lit Robinhood Chain (chainId 4663) en continu et
répond aux questions que l'analyse en direct ne peut pas se payer en RPC :
tous les lancements d'un créateur depuis le début, les échanges d'un pool de
lancement pons, qui a financé un créateur, les marchés Uniswap v4 d'un token.

Aucune dépendance : Node 24 exécute le TypeScript tel quel, `node:sqlite` stocke
(mode WAL), `node:http` sert l'API.

## Ce qu'il lit

| Flux            | Source                                                            | Curseur                       |
| --------------- | ----------------------------------------------------------------- | ----------------------------- |
| `launches`      | `TokenLaunched` de chaque factory pons, depuis son premier bloc   | `launches:<factory>`          |
| `swaps:forward` | `Swap` Uniswap V3 de toute la chaîne, filtrés sur les pools pons  | `swaps:forward`               |
| `swaps:back`    | les mêmes, par listes de 999 pools, en remontant `BACKFILL_DAYS`  | `swaps:back` → `swaps:target` |
| `markets`       | `Initialize` du PoolManager v4, tout l'historique                 | `markets`                     |
| `funding`       | premier versement entrant de chaque créateur (API PRO Blockscout) | une ligne par créateur        |

Chaque flux reprend à son curseur après un arrêt ; les insertions sont
idempotentes sur (txHash, logIndex). Une erreur RPC (429, délai dépassé) fait
attendre la boucle, jamais tomber le processus. Une ligne de log JSON par lot.

L'heure d'un bloc est interpolée entre deux ancres lues tous les 50 000 blocs
(la chaîne tient 9,7 à 9,9 blocs/s) : l'écart reste de l'ordre de la seconde.

Le trader d'un swap est le signataire de la transaction (`eth_getTransactionByHash`),
pas le `sender` du swap, qui est presque toujours un routeur.

## Variables d'environnement

| Variable             | Défaut                                    | Rôle                                                      |
| -------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `INDEXER_TOKEN`      | — (obligatoire, 24 caractères au moins)   | jeton Bearer exigé partout sauf `/health`                 |
| `RPC_URL`            | `https://rpc.mainnet.chain.robinhood.com` | nœud Robinhood Chain                                      |
| `RPC_RATE`           | `4`                                       | requêtes `eth_getLogs` par seconde                        |
| `BLOCKSCOUT_API_KEY` | vide                                      | sans elle, le financement n'est pas lu (`/health` le dit) |
| `BACKFILL_DAYS`      | `30`                                      | jours de swaps relus au premier démarrage                 |
| `PORT`               | `8795`                                    | port HTTP                                                 |
| `DB_PATH`            | `/data/seal-indexer.db`                   | fichier SQLite                                            |

Côté application : `INDEXER_URL` (par exemple `http://127.0.0.1:8795`) et
`INDEXER_TOKEN` (le même jeton). Sans eux, l'application fonctionne comme avant.

## Lancer

En local :

```bash
cd indexer
INDEXER_TOKEN=$(openssl rand -hex 32) DB_PATH=/tmp/seal-indexer.db BACKFILL_DAYS=1 \
  node --disable-warning=ExperimentalWarning src/main.ts
```

Dans Docker :

```bash
cd indexer
cp .env.example .env   # puis remplir INDEXER_TOKEN, et BLOCKSCOUT_API_KEY si besoin
docker compose up -d --build
docker compose logs -f seal-indexer
```

Le conteneur `seal-indexer` tourne sous un utilisateur sans privilège, sur son
propre réseau `seal-indexer-net`, avec le volume `seal-indexer-data` monté sur
`/data`, 2 Go de mémoire au plus, et son port publié sur `127.0.0.1` seulement.

Les tests tournent avec ceux de l'application (`pnpm test` à la racine).

## Endpoints

Toutes les réponses sont en JSON et portent `indexedTo`, le dernier bloc lu par
le flux qui les nourrit. Les adresses sont validées et passées en minuscules ;
une adresse inconnue répond 404, une absence de jeton 401.

- `GET /health` (sans jeton) : bloc de tête, curseur et retard de chaque flux,
  nombre de lignes, financement actif ou non, mémoire.
- `GET /v1/creator/:address` : les lancements du créateur (token, pool, bloc,
  date), et `fundingState` : `found` (avec `funding.funder`, `txHash`, `block`,
  `otherCreatorsFunded`), `none` (`funding: null`, rien trouvé), `pending` (pas
  encore lu, le créateur passe en tête de file) ou `disabled` (pas de clé).
- `GET /v1/token/:address` : le lancement, puis sur 1 h, 24 h, 7 j et depuis le
  lancement : achats, ventes, traders distincts, volume côté token de paire (wei,
  en texte), dernier échange ; les 5 plus gros traders sur 7 j avec leur solde
  net ; si le créateur a échangé. `coveredFrom` dit à partir de quel bloc les
  swaps sont comptés, `sinceLaunchComplete` si tout depuis le lancement l'est.
- `GET /v1/funder/:address` : les créateurs financés par cette adresse.
- `GET /v1/markets/:token` : les marchés v4 où ce token est l'une des deux monnaies.

```bash
curl -s -H "Authorization: Bearer $INDEXER_TOKEN" http://127.0.0.1:8795/v1/token/0x…
```
