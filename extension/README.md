# Extension navigateur SEAL

Quand on regarde un token Robinhood Chain sur un site de trading ou un explorateur, l'extension
affiche le « In short » de SEAL dans une petite carte, sans ouvrir sealauth.dev. Les faits sont
les mêmes que sur le site : un chiffre, une phrase, ce qui n'a pas pu être mesuré. Jamais de
score, jamais de verdict.

## Ce qu'elle fait

- **Sur une page de token** — une pastille « SEAL » en bas à droite ; un clic (ou Entrée) l'ouvre
  sur la carte In short. Échap la referme.
- **Au survol d'un lien vers une page de token** — une carte compacte après 400 ms. Elle se ferme
  quand le pointeur s'en va, ou avec Échap. Elle s'ouvre aussi au clavier (focus sur le lien).
- **Bouton de la barre d'outils** — coller une adresse affiche la même carte ; un interrupteur
  coupe l'extension sur le site de l'onglet courant (réglage gardé dans `chrome.storage.sync`).

Sites pris en charge :

| Site                                   | Page de token reconnue                     |
| -------------------------------------- | ------------------------------------------ |
| `dexscreener.com/robinhood…`           | `/robinhood/0x…` (paire, pool v3 ou id v4) |
| `robinhoodchain.blockscout.com`        | `/token/0x…`                               |
| `ponsfamily.com`, `www.ponsfamily.com` | `/launchpad/0x…`                           |

DexScreener nomme la **paire**, pas le token : le serveur la résout en token via l'API publique
DexScreener (`GET /api/glance?pair=0x…`). Un hash de transaction (64 caractères hors DexScreener)
n'est jamais pris pour une adresse.

La carte est rendue dans un Shadow DOM : le CSS du site ne la touche pas, et elle ne prend aucun
clic en dehors de la pastille et des cartes. Elle respecte `prefers-reduced-motion` et ne
s'attache jamais à un champ de saisie.

## Charger l'extension en local

Aucune étape de build : ce sont des scripts simples.

1. Ouvrir `chrome://extensions`.
2. Activer le **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** → choisir le dossier `extension/` du dépôt.
4. Ouvrir par exemple une paire sur `https://dexscreener.com/robinhood/…`.

Firefox (121+) : `about:debugging#/runtime/this-firefox` → **Charger un module temporaire** →
choisir `extension/manifest.json`.

### Pointer vers un serveur local

Par défaut l'extension interroge `https://sealauth.dev`. Pour développer contre `pnpm dev` ou
`pnpm start`, depuis la console du service worker (chrome://extensions → « service worker ») :

```js
chrome.storage.local.set({ apiBase: 'http://127.0.0.1:3100' });
```

Seules les adresses `http://127.0.0.1:<port>` et `http://localhost:<port>` sont acceptées ;
`chrome.storage.local.remove('apiBase')` revient au site public.

### Tests

- `pnpm test` — détection d'adresses, rendu de la carte, cache et backoff (`tests/extension/`).
- `pnpm test:e2e` — charge l'extension dans Chromium (Playwright) sur une page de test qui imite
  une URL DexScreener, avec une réponse `/api/glance` simulée (`tests/e2e/extension.spec.ts`).
- Icônes : `node scripts/extension-icons.mjs` les régénère depuis `src/app/icon.svg`.

## Permissions, et pourquoi

| Permission                                                                                  | Raison                                                                 |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `storage`                                                                                   | le cache de 5 min (`storage.session`) et la liste des sites désactivés |
| `https://sealauth.dev/*`                                                                    | la seule requête réseau : `GET /api/glance`                            |
| `dexscreener.com/robinhood*`, `robinhoodchain.blockscout.com/*`, `ponsfamily.com/*` (+ www) | lire l'URL de la page et ses liens pour y trouver un token             |

Pas de `tabs`, pas de `scripting`, pas d'accès à tous les sites, pas de code distant, pas
d'`eval`. La CSP des pages de l'extension est `script-src 'self'; object-src 'none'`.

## Vie privée

Seule l'adresse du token (ou de la paire, sur DexScreener) est envoyée à sealauth.dev. Ni l'URL
de la page, ni l'historique, ni cookie (`credentials: 'omit'`), ni identifiant. Les réponses
restent 5 minutes dans `chrome.storage.session`, effacé à la fermeture du navigateur. Politique
complète : https://sealauth.dev/privacy

## Publier sur le Chrome Web Store (à faire par le propriétaire)

1. Créer un compte développeur : https://chrome.google.com/webstore/devconsole — frais uniques
   de **5 $**, vérification d'identité et adresse e-mail de contact.
2. Zipper le **contenu** du dossier `extension/` (le `manifest.json` à la racine du zip) :
   `cd extension && zip -r ../seal-extension.zip . -x README.md`
3. Dans la console : **Nouvel élément** → envoyer le zip.
4. Fiche : description, catégorie (Outils de développement ou Productivité), langue, icône
   128 px (`icons/seal-128.png`), **au moins une capture d'écran 1280×800 ou 640×400**, une
   petite image promotionnelle 440×280 (facultative mais conseillée).
5. Onglet Confidentialité :
   - objectif unique : « afficher le résumé SEAL d'un token Robinhood Chain sur la page » ;
   - justifier `storage` et chaque hôte (voir le tableau ci-dessus) ;
   - aucun code distant ;
   - données : « contenu du site web » limité à l'adresse du token ; ni vendues ni transférées ;
   - URL de politique de confidentialité : **https://sealauth.dev/privacy**
6. Soumettre à l'examen (quelques jours en général). Les hôtes précis plutôt que `<all_urls>`
   accélèrent l'examen.

Firefox (facultatif) : https://addons.mozilla.org/developers/ — gratuit, même zip ; l'id
`seal@sealauth.dev` est déjà dans `browser_specific_settings`.
