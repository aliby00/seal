#!/usr/bin/env node
/**
 * Smoke tests exécutés APRÈS déploiement, contre l'URL réellement en ligne.
 * Un déploiement qui passe le CI mais ne répond pas doit être détecté ici,
 * pas par un utilisateur.
 *
 *   node scripts/smoke.mjs https://exemple.vercel.app [env attendu]
 */
const [, , rawUrl, expectedEnv] = process.argv;

if (!rawUrl) {
  console.error('usage: node scripts/smoke.mjs <url> [env]');
  process.exit(2);
}

const base = rawUrl.replace(/\/+$/, '');
const TIMEOUT_MS = 20_000;
const failures = [];

async function get(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${base}${path}`, {
      signal: controller.signal,
      headers: { 'user-agent': 'seal-smoke' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

console.log(`smoke → ${base}`);

await check("la page d'accueil répond en 200", async () => {
  const res = await get('/');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('SEAL')) throw new Error('le corps de la page ne contient pas "SEAL"');
});

await check('/api/health répond un JSON valide', async () => {
  const res = await get('/api/health');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error(`status = ${JSON.stringify(body.status)}`);
  if (expectedEnv && body.env !== expectedEnv) {
    throw new Error(`env attendu "${expectedEnv}", reçu "${body.env}"`);
  }
});

await check('une route inexistante renvoie bien 404', async () => {
  const res = await get('/cette-route-nexiste-pas');
  if (res.status !== 404) throw new Error(`HTTP ${res.status} au lieu de 404`);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke test(s) en échec : ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\ntous les smoke tests passent');
