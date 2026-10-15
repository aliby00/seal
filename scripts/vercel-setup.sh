#!/usr/bin/env bash
# Crée les projets Vercel de SEAL (production et staging) dans une équipe, puis
# affiche les identifiants à mettre dans les secrets GitHub.
#
#   pnpm dlx vercel@59 login            # une fois, avec le compte de l'équipe
#   scripts/vercel-setup.sh <scope>     # scope = slug de l'équipe Vercel
#
# Aucun dépôt Git n'est connecté aux projets : les déploiements partent des
# GitHub Actions (vercel.json désactive les déploiements Git). Aucune valeur
# secrète n'est lue ni écrite ici.
set -euo pipefail

SCOPE="${1:?Usage : scripts/vercel-setup.sh <scope-de-l-equipe>}"
VERCEL=(pnpm dlx --allow-build=esbuild vercel@59)
PROJECTS=(seal seal-staging)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$(dirname "$0")/../vercel.json" "$work/"

for project in "${PROJECTS[@]}"; do
  echo "== $project"
  # « project add » échoue si le projet existe déjà : on le garde tel quel.
  "${VERCEL[@]}" project add "$project" --scope "$SCOPE" ||
    echo "   (déjà présent, conservé)"
  rm -rf "$work/.vercel"
  (cd "$work" && "${VERCEL[@]}" link --yes --project "$project" --scope "$SCOPE" >/dev/null)
  node -e '
    const p = require(process.argv[1]);
    console.log(`   VERCEL_PROJECT_ID = ${p.projectId}`);
    console.log(`   VERCEL_ORG_ID     = ${p.orgId}`);
  ' "$work/.vercel/project.json"
done

cat <<'TXT'

Secrets GitHub, par environnement (aliby00/seal → Settings → Environments →
« production » pour seal, « staging » pour seal-staging) :
  VERCEL_TOKEN       token créé sur le compte de l'équipe (Account Settings → Tokens)
  VERCEL_ORG_ID      affiché ci-dessus (identique pour les deux projets)
  VERCEL_PROJECT_ID  affiché ci-dessus, celui du projet de l'environnement
Variable de l'environnement :
  PUBLIC_URL         adresse publique du site (lue par les smoke tests)

Variables Vercel, à créer sur chaque projet, environnement « Production »
(les deux projets lisent Production au build) :
  SEAL_ENV              production (seal) / staging (seal-staging)
  RPC_URL               nœud RPC pour les appels simples
  ANTHROPIC_API_KEY     clé Anthropic (sans elle : explication hors-ligne)
  NEXT_PUBLIC_SITE_URL  domaine public (seal uniquement)
  LOGS_RPC_URL          facultatif, vide = RPC public
  BLOCKSCOUT_API_KEY    facultatif, couvre les tokens très actifs
Ne pas créer ANTHROPIC_MODEL : le code choisit le modèle.
TXT
