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
 * Token Solana réel (JUP), utilisé uniquement pour vérifier que la route
 * d'analyse répond. Une adresse 0x est refusée en 400 depuis le passage à
 * Solana : la sonde ferait échouer chaque déploiement. Si ce token disparaît des sources, le test signalera une analyse
 * incomplète — ce qui reste une réponse valide et ne doit pas faire échouer
 * le déploiement. On vérifie la FORME de la réponse, pas son contenu.
 */
const PROBE_TOKEN = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

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

/**
 * Un nœud Solana qui ne répond pas laisse le site debout mais incapable de
 * lire quoi que ce soit : la sonde répond alors 503 « degraded ». Un
 * `getSlot` raté une fois peut être passager : la sonde est relue jusqu'à
 * trois fois avant d'échouer.
 */
const HEALTH_TRIES = 3;
const HEALTH_RETRY_MS = Number(process.env.SMOKE_HEALTH_RETRY_MS ?? 10_000);

await check('/api/health répond un JSON valide, et le nœud Solana répond', async () => {
  let body;
  for (let attempt = 1; ; attempt += 1) {
    const res = await get('/api/health');
    // 503 is the probe's own answer for a node down: its body says which and why.
    if (!res.ok && res.status !== 503) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
    if (body.solana?.slotOk === true || attempt >= HEALTH_TRIES) break;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
  }
  if (expectedEnv && body.env !== expectedEnv) {
    throw new Error(`env attendu "${expectedEnv}", reçu "${body.env}"`);
  }
  if (body.config?.chain !== 'solana') {
    throw new Error(`chaîne attendue "solana", reçue ${JSON.stringify(body.config?.chain)}`);
  }
  if (body.solana?.slotOk !== true) {
    throw new Error(
      `le nœud Solana « ${body.solana?.node ?? '?'} » ne répond pas ` +
        `(${body.solana?.error ?? 'aucune raison donnée'}), ${HEALTH_TRIES} essais`,
    );
  }
  if (body.status !== 'ok') throw new Error(`status = ${JSON.stringify(body.status)}`);
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
    // A chain node or an explorer down is not this deployment's fault: the
    // route says so in its own words, and rolling back would not bring the
    // source back. Anything else (a 500, a crash page) fails the deploy.
    if ([429, 502, 504].includes(res.status) && /data source/i.test(body)) {
      console.log(
        `  warn  source tierce indisponible — HTTP ${res.status} : ${body.slice(0, 160)}`,
      );
      return;
    }
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
    // A count ("3/10 launches") is not a score: only a rated number is.
    /\b(?:score|rating|grade|note)\s*[:=]?\s*\d{1,3}\s*\/\s*(?:5|10|20|100)\b/i,
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
