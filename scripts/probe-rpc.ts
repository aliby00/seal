/**
 * Sonde le RPC Robinhood Chain et re-vérifie ce qui est consigné dans RESEARCH.md.
 * Aucune dépendance : node --experimental-strip-types scripts/probe-rpc.ts
 *
 * Ce script existe pour que les chiffres du document soient rejouables plutôt
 * que crus sur parole. Il ne modifie rien.
 */
const RPC = process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const TOPIC_TOKEN_LAUNCHED = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';

type RpcResult = { result?: unknown; error?: { code: number; message: string } };

async function rpc(method: string, params: unknown[]): Promise<RpcResult> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) return { error: { code: res.status, message: `HTTP ${res.status}` } };
  return (await res.json()) as RpcResult;
}

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(28)} ${String(value)}`);
}

console.log(`\nRPC ${RPC}\n`);

const chainId = await rpc('eth_chainId', []);
line('eth_chainId', chainId.result);
line('  attendu', '0x1237 (4663)');

const client = await rpc('web3_clientVersion', []);
line('web3_clientVersion', client.result);

const head = await rpc('eth_blockNumber', []);
const latest = Number(head.result);
line('bloc courant', latest.toLocaleString('fr-FR'));

// Temps de bloc, mesuré sur 1 M de blocs.
const [a, b] = await Promise.all([
  rpc('eth_getBlockByNumber', ['0x' + (latest - 1_000_000).toString(16), false]),
  rpc('eth_getBlockByNumber', ['0x' + latest.toString(16), false]),
]);
const tA = Number((a.result as { timestamp: string } | undefined)?.timestamp ?? 0);
const tB = Number((b.result as { timestamp: string } | undefined)?.timestamp ?? 0);
if (tA && tB) {
  const blockTime = (tB - tA) / 1_000_000;
  line('temps de bloc', `${blockTime.toFixed(4)} s`);
  line('blocs par jour', Math.round(86_400 / blockTime).toLocaleString('fr-FR'));
  line('âge de la chaîne', `${((latest * blockTime) / 86_400).toFixed(1)} jours`);
}

// La limite de eth_getLogs. Deux modes d'échec coexistent : le dépassement du
// nombre de résultats, et un timeout de la requête. On resserre la fenêtre
// jusqu'à obtenir une réponse exploitable.
console.log('\n  --- limite eth_getLogs ---');
const spans = [latest, 20_000_000, 5_000_000, 1_000_000, 250_000];
let limitFound: string | undefined;

for (const span of spans) {
  const from = Math.max(0, latest - span);
  const probe = await rpc('eth_getLogs', [
    { fromBlock: '0x' + from.toString(16), toBlock: 'latest', topics: [TOPIC_TOKEN_LAUNCHED] },
  ]);
  const label = `${span.toLocaleString('fr-FR')} blocs`.padEnd(20);

  if (probe.error) {
    const max = /limit of (\d+)/.exec(probe.error.message)?.[1];
    if (max) {
      limitFound = max;
      console.log(`  ${label} limite atteinte : ${max} logs`);
      break;
    }
    console.log(`  ${label} ${probe.error.message}`);
    continue; // timeout ou rate limit : on resserre
  }

  const logs = probe.result as unknown[];
  console.log(`  ${label} ${logs.length} logs (sous la limite)`);
  break;
}

if (limitFound && limitFound !== '10000') {
  console.log(`\n  ATTENTION : limite ${limitFound}, RESEARCH.md dit 10000.`);
} else if (!limitFound) {
  console.log('\n  Limite non atteinte sur cette exécution — le RPC public');
  console.log("  time out ou rate-limite avant. C'est en soi un résultat.");
}

console.log('');

export {};
