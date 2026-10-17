import { createApi, serve } from './api.ts';
import { createClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { logLine, runLoop, type Stream } from './loop.ts';
import { createRpc } from './rpc.ts';
import { fundingStream } from './streams/funding.ts';
import { launchStream } from './streams/launches.ts';
import { marketStream } from './streams/markets.ts';
import { swapStream } from './streams/swaps.ts';

/**
 * Point d'entrée : une base, un client RPC partagé (donc un seul budget de
 * requêtes pour toutes les boucles), cinq boucles et l'API.
 */
const config = loadConfig();
const db = openDb(config.dbPath);
const rpc = createRpc({ url: config.rpcUrl, rate: config.rpcRate });
const clock = createClock(rpc, db);
const log = logLine;
const stop = new AbortController();

const head: Stream = {
  name: 'head',
  async step() {
    await clock.observeHead();
    return false;
  },
};

// The head comes first: every other loop reads up to it.
await clock.observeHead().catch((error: unknown) => log('head-error', { error: String(error) }));

const swaps = swapStream({ rpc, db, clock, log, backfillDays: config.backfillDays });
const funding = config.blockscoutApiKey
  ? fundingStream({ db, apiKey: config.blockscoutApiKey, log })
  : undefined;
const streams: Stream[] = [
  head,
  launchStream({ rpc, db, clock, log }),
  marketStream({ rpc, db, clock, log }),
  swaps.forward,
  swaps.back,
  ...(funding ? [funding] : []),
];

const handle = createApi({
  db,
  clock,
  rpc,
  token: config.token,
  fundingEnabled: Boolean(funding),
  prioritizeFunding: funding?.prioritize,
});
const server = serve(handle, config.port);

log('started', {
  port: config.port,
  rpcRate: config.rpcRate,
  backfillDays: config.backfillDays,
  funding: funding ? 'enabled' : 'disabled: no BLOCKSCOUT_API_KEY',
  head: clock.head(),
});

const loops = streams.map((s) => runLoop(s, { pollMs: config.pollMs, log, signal: stop.signal }));

// Memory, once a minute: the container is capped at 2 GB.
const memory = setInterval(() => {
  const m = process.memoryUsage();
  log('memory', {
    rssMb: Math.round(m.rss / 1_048_576),
    heapMb: Math.round(m.heapUsed / 1_048_576),
  });
}, 60_000);
memory.unref();

function shutdown(signal: string): void {
  log('stopping', { signal });
  stop.abort();
  server.close();
  // Loops finish their current batch at most; the cursors are already saved.
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 1_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// A stray rejection is logged, never fatal: the loops resume from their cursors.
process.on('unhandledRejection', (error) => {
  log('unhandled', { error: String(error).slice(0, 300) });
});

await Promise.allSettled(loops);
