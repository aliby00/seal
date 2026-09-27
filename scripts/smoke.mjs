#!/usr/bin/env node
/**
 * Smoke tests exécutés APRÈS déploiement, contre l'URL réellement en ligne.
 * Un déploiement qui passe le CI mais ne répond pas doit être détecté ici,
 * pas par un utilisateur.
 *
 *   node scripts/smoke.mjs https://exemple.vercel.app [env attendu]
 */
const [, , rawUrl, expectedEnv] = process.argv;

/**
 * Token pons réel, utilisé uniquement pour vérifier que la route d'analyse
 * répond. Si ce token disparaît des sources, le test signalera une analyse
 * incomplète — ce qui reste une réponse valide et ne doit pas faire échouer
 * le déploiement. On vérifie la FORME de la réponse, pas son contenu.
 */
const PROBE_TOKEN = '0xd0c538e01a22ebf8502b4dc3a92026cec870cec6';

if (!rawUrl) {
  console.error('usage: node scripts/smoke.mjs <url> [env]');
  process.exit(2);
}

const base = rawUrl.replace(/\/+$/, '');
const TIMEOUT_MS = 20_000;
const failures = [];

async function post(path, body) {
  const controller = new AbortController();
  // L'analyse lit trois sources : elle est bien plus lente qu'une page.
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    return await fetch(`${base}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'user-agent': 'seal-smoke' },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

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

// C'est LA route du produit. Sans ce test, elle pourrait renvoyer 500 sur tous
// les tokens et le déploiement partirait quand même en vert.
await check('/api/analyze refuse une adresse invalide', async () => {
  const res = await post('/api/analyze', { token: 'pas-une-adresse' });
  if (res.status !== 400) throw new Error(`HTTP ${res.status} au lieu de 400`);
});

await check('/api/analyze produit une analyse sur un token réel', async () => {
  const res = await post('/api/analyze', { token: PROBE_TOKEN });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const body = await res.json();

  for (const field of ['token', 'explanation', 'completeness', 'sources', 'collectedAt']) {
    if (!(field in body)) throw new Error(`champ « ${field} » absent de la réponse`);
  }
  if (typeof body.explanation !== 'string' || body.explanation.trim().length < 50) {
    throw new Error(`explication vide ou trop courte (${body.explanation?.length ?? 0} car.)`);
  }
  if (!['full', 'partial', 'unavailable'].includes(body.completeness)) {
    throw new Error(`complétude inattendue : ${body.completeness}`);
  }
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    throw new Error('aucune source listée');
  }

  // Les garde-fous du produit s'appliquent aussi à ce qui est réellement servi.
  const forbidden = [
    /\b\d{1,3}\s*\/\s*(?:5|10|20|100)\b/,
    /\bsafe\s+to\s+buy\b/i,
    /\bbon\s+investissement\b/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(body.explanation)) {
      throw new Error(`la sortie contient une formulation interdite : ${pattern}`);
    }
  }

  console.log(
    `        (${body.offline ? 'hors-ligne' : (body.provider ?? 'agent')}, ` +
      `complétude ${body.completeness}, ${body.costUsd} $)`,
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke test(s) en échec : ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\ntous les smoke tests passent');
