/**
 * Vérifie les deux faits gênants sur Blockscout :
 *  - l'instance publique est derrière Cloudflare (403 côté serveur)
 *  - l'API PRO exige une clé, même sur le tier gratuit (402 sinon)
 *
 * Avec BLOCKSCOUT_API_KEY dans l'environnement, tente aussi un appel réel
 * et affiche la forme de la pagination — le point resté non confirmé.
 *
 * node --experimental-strip-types scripts/probe-blockscout.ts [adresse]
 */
const PUBLIC_INSTANCE = 'https://robinhoodchain.blockscout.com';
const PRO = 'https://api.blockscout.com/4663/api/v2';
const token = process.argv[2] ?? '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const key = process.env.BLOCKSCOUT_API_KEY;

console.log('\nInstance publique (attendu : 403 Cloudflare)\n');
const pub = await fetch(`${PUBLIC_INSTANCE}/api/v2/tokens/${token}`, {
  headers: { 'user-agent': 'seal-probe' },
});
console.log(`  HTTP ${pub.status}  ${pub.headers.get('server') ?? ''}`);

console.log('\nAPI PRO sans clé (attendu : 402)\n');
const noKey = await fetch(`${PRO}/tokens/${token}/holders`);
console.log(`  HTTP ${noKey.status}  ${(await noKey.text()).slice(0, 120)}`);

if (!key) {
  console.log('\n  BLOCKSCOUT_API_KEY absente — le test avec clé est ignoré.');
  console.log('  Clé gratuite sur https://dev.blockscout.com (5 req/s, 100 000 crédits/jour)\n');
} else {
  console.log('\nAPI PRO avec clé — forme de la pagination\n');
  const res = await fetch(`${PRO}/tokens/${token}/holders?apikey=${key}`);
  console.log(`  HTTP ${res.status}`);
  if (res.ok) {
    const body = (await res.json()) as { items?: unknown[]; next_page_params?: unknown };
    console.log(`  items sur la page 1 : ${body.items?.length ?? 0}`);
    console.log(`  next_page_params    : ${JSON.stringify(body.next_page_params)}`);
  }
  console.log('');
}

export {};
