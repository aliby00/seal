/**
 * Vérifie le slug de chaîne DexScreener et la forme de la réponse.
 * node --experimental-strip-types scripts/probe-dexscreener.ts [adresse]
 */
const BASE = 'https://api.dexscreener.com';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const token = process.argv[2] ?? WETH;

async function pairsFor(chain: string, address: string): Promise<unknown[]> {
  const res = await fetch(`${BASE}/token-pairs/v1/${chain}/${address}`);
  if (!res.ok) return [];
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? body : [];
}

console.log('\nSlugs de chaîne testés — seul `robinhood` doit répondre\n');
for (const slug of ['robinhood', 'robinhoodchain', 'rhc', '4663']) {
  const pairs = await pairsFor(slug, WETH);
  console.log(`  ${slug.padEnd(16)} ${pairs.length} paire(s)`);
}

console.log(`\nDétail pour ${token}\n`);
const pairs = (await pairsFor('robinhood', token)) as Record<string, unknown>[];
if (pairs.length === 0) {
  console.log('  aucune paire indexée (token trop récent ?)');
} else {
  const p = pairs[0]!;
  for (const key of [
    'chainId',
    'dexId',
    'labels',
    'pairAddress',
    'priceUsd',
    'liquidity',
    'volume',
    'txns',
    'fdv',
    'pairCreatedAt',
  ]) {
    console.log(`  ${key.padEnd(14)} ${JSON.stringify(p[key])}`);
  }
}
console.log('');

export {};
