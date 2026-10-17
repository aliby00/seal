import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { PONS_FACTORIES } from './abi.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import type { Rpc } from './rpc.ts';
import { tokenStats } from './stats.ts';
import { launchFrontier } from './streams/launches.ts';
import { BACK, FORWARD, TARGET } from './streams/swaps.ts';
import { MARKETS } from './streams/markets.ts';

/**
 * L'API JSON de l'indexeur. Tout sauf `/health` exige
 * `Authorization: Bearer <INDEXER_TOKEN>`. Chaque réponse porte `indexedTo` :
 * le dernier bloc lu par le flux qui la nourrit, pour que l'application juge
 * elle-même de la fraîcheur.
 */
export type ApiDeps = {
  db: Db;
  clock: Clock;
  rpc: Pick<Rpc, 'stats'>;
  token: string;
  fundingEnabled: boolean;
  prioritizeFunding?: (creator: string) => void;
  nowSec?: () => number;
  startedAt?: number;
};

export type ApiResponse = { status: number; body: unknown; headers: Record<string, string> };

/** Les listes renvoyées sont bornées : un créateur-robot peut avoir lancé des milliers de tokens. */
const MAX_ROWS = 1_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const iso = (ts: number | null | undefined): string | null =>
  ts === null || ts === undefined ? null : new Date(ts * 1000).toISOString();

/** Comparaison en temps constant, même quand les longueurs diffèrent. */
export function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function json(status: number, body: unknown, cache = 'private, max-age=10'): ApiResponse {
  return {
    status,
    body,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  };
}

const notFound = (indexedTo: number) => json(404, { error: 'not found', indexedTo });

export function createApi(deps: ApiDeps) {
  const { db } = deps;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const startedAt = deps.startedAt ?? Date.now();

  const launchesOf = db.raw.prepare(
    `SELECT token, pool, factory, pair_token, block, ts FROM launches
     WHERE creator = ? ORDER BY block DESC LIMIT ${MAX_ROWS}`,
  );
  const launchCount = db.raw.prepare('SELECT COUNT(*) AS n FROM launches WHERE creator = ?');
  const launchOf = db.raw.prepare(
    `SELECT token, creator, pool, factory, dex_factory, pair_token, position_id, initial_buy, block, ts, tx_hash
     FROM launches WHERE token = ? ORDER BY block LIMIT 1`,
  );
  const fundingOf = db.raw.prepare(
    'SELECT status, funder, tx_hash, block, kind FROM funding WHERE creator = ?',
  );
  const fundedBy = db.raw.prepare(
    `SELECT creator, tx_hash, block, kind FROM funding
     WHERE funder = ? AND status = 'found' ORDER BY block LIMIT ${MAX_ROWS}`,
  );
  const marketsOf = db.raw.prepare(
    `SELECT id, currency0, currency1, fee, tick_spacing, hook, block, ts, tx_hash FROM markets
     WHERE currency0 = ? OR currency1 = ? ORDER BY block LIMIT ${MAX_ROWS}`,
  );

  const launchesTo = () => {
    const f = launchFrontier(db);
    return Number.isFinite(f) ? f : deps.clock.head();
  };

  function health(): ApiResponse {
    const head = deps.clock.head();
    const streams: Record<string, { cursor: number; lag: number }> = {};
    for (const c of db.cursors()) {
      if (c.stream === TARGET) continue;
      // The backfill moves down: its lag is what is left to read.
      // A closed factory, read to its end, has nothing left: its lag is 0.
      const closed = PONS_FACTORIES.find(
        (f) => c.stream === `launches:${f.address}` && f.toBlock !== undefined,
      );
      const lag =
        c.stream === BACK
          ? Math.max(0, c.block - (db.cursor(TARGET) ?? 0))
          : closed?.toBlock !== undefined
            ? Math.max(0, closed.toBlock - c.block)
            : head - c.block;
      streams[c.stream] = { cursor: c.block, lag };
    }
    return json(
      200,
      {
        status: 'ok',
        head,
        indexedTo: Math.min(launchesTo(), db.cursor(FORWARD) ?? 0),
        streams,
        swapsCoverage: {
          from: db.cursor(BACK) ?? null,
          to: db.cursor(FORWARD) ?? null,
          target: db.cursor(TARGET) ?? null,
        },
        rows: {
          launches: db.count('launches'),
          swaps: db.count('swaps'),
          markets: db.count('markets'),
          funding: db.count('funding'),
        },
        funding: deps.fundingEnabled ? 'enabled' : 'disabled: no BLOCKSCOUT_API_KEY',
        rpc: deps.rpc.stats(),
        rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
        uptimeS: Math.round((Date.now() - startedAt) / 1000),
      },
      'no-store',
    );
  }

  function creator(address: string): ApiResponse {
    const indexedTo = launchesTo();
    const total = (launchCount.get(address) as { n: number }).n;
    if (total === 0) return notFound(indexedTo);
    const launches = (
      launchesOf.all(address) as {
        token: string;
        pool: string;
        factory: string;
        pair_token: string;
        block: number;
        ts: number | null;
      }[]
    ).map((l) => ({
      token: l.token,
      pool: l.pool,
      factory: l.factory,
      pairToken: l.pair_token,
      block: l.block,
      timestamp: iso(l.ts),
    }));
    const row = fundingOf.get(address) as
      | { status: 'found' | 'none'; funder: string; tx_hash: string; block: number; kind: string }
      | undefined;
    let funding: unknown;
    let fundingState: 'found' | 'none' | 'pending' | 'disabled';
    if (!deps.fundingEnabled && !row) {
      fundingState = 'disabled';
    } else if (!row) {
      fundingState = 'pending';
      deps.prioritizeFunding?.(address);
    } else if (row.status === 'none') {
      fundingState = 'none';
      funding = null;
    } else {
      fundingState = 'found';
      const others = (fundedBy.all(row.funder) as { creator: string }[])
        .map((r) => r.creator)
        .filter((c) => c !== address);
      funding = {
        funder: row.funder,
        txHash: row.tx_hash,
        block: row.block,
        kind: row.kind,
        otherCreatorsFunded: others,
      };
    }
    return json(200, {
      creator: address,
      indexedTo,
      launchCount: total,
      truncated: total > launches.length,
      launches,
      fundingState,
      ...(funding !== undefined ? { funding } : {}),
    });
  }

  function token(address: string): ApiResponse {
    const indexedTo = Math.min(db.cursor(FORWARD) ?? 0, launchesTo());
    const launch = launchOf.get(address) as
      | {
          token: string;
          creator: string;
          pool: string;
          factory: string;
          dex_factory: string;
          pair_token: string;
          position_id: string;
          initial_buy: string;
          block: number;
          ts: number | null;
          tx_hash: string;
        }
      | undefined;
    if (!launch) return notFound(indexedTo);
    const token0 =
      db.token0(launch.pool) ??
      (launch.token < launch.pair_token ? launch.token : launch.pair_token);
    const coveredFrom = db.cursor(BACK);
    const stats = tokenStats(db, address, {
      creator: launch.creator,
      tokenIsToken0: token0 === launch.token,
      nowSec: nowSec(),
    });
    const coveredAt = coveredFrom !== undefined ? db.anchorAbove(coveredFrom) : undefined;
    return json(200, {
      token: address,
      indexedTo,
      launch: {
        token: launch.token,
        creator: launch.creator,
        pool: launch.pool,
        factory: launch.factory,
        dexFactory: launch.dex_factory,
        pairToken: launch.pair_token,
        positionId: launch.position_id,
        initialBuyAmount: launch.initial_buy,
        block: launch.block,
        timestamp: iso(launch.ts),
        txHash: launch.tx_hash,
      },
      // Swaps are read from this block on: older trades are not counted.
      coveredFrom: coveredFrom ?? null,
      coveredFromAt: coveredAt ? iso(coveredAt.ts) : null,
      sinceLaunchComplete: coveredFrom !== undefined && launch.block >= coveredFrom,
      tokenIsToken0: token0 === launch.token,
      stats: stats.windows,
      topTraders7d: stats.topTraders7d,
      creatorTraded: stats.creator,
    });
  }

  function funder(address: string): ApiResponse {
    const indexedTo = launchesTo();
    const rows = fundedBy.all(address) as {
      creator: string;
      tx_hash: string;
      block: number;
      kind: string;
    }[];
    if (rows.length === 0) return notFound(indexedTo);
    return json(200, {
      funder: address,
      indexedTo,
      creators: rows.map((r) => ({
        creator: r.creator,
        txHash: r.tx_hash,
        block: r.block,
        kind: r.kind,
      })),
    });
  }

  function markets(address: string): ApiResponse {
    const indexedTo = db.cursor(MARKETS) ?? 0;
    const rows = marketsOf.all(address, address) as {
      id: string;
      currency0: string;
      currency1: string;
      fee: number;
      tick_spacing: number;
      hook: string;
      block: number;
      ts: number | null;
      tx_hash: string;
    }[];
    if (rows.length === 0) return notFound(indexedTo);
    return json(200, {
      token: address,
      indexedTo,
      markets: rows.map((m) => ({
        id: m.id,
        currency0: m.currency0,
        currency1: m.currency1,
        fee: m.fee,
        tickSpacing: m.tick_spacing,
        hook: m.hook,
        block: m.block,
        timestamp: iso(m.ts),
        txHash: m.tx_hash,
      })),
    });
  }

  const routes: Record<string, (address: string) => ApiResponse> = {
    creator,
    token,
    funder,
    markets,
  };

  return function handle(request: {
    method: string;
    url: string;
    authorization?: string;
  }): ApiResponse {
    const path = new URL(request.url, 'http://indexer').pathname;
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' }, 'no-store');
    if (path === '/health') return health();

    const bearer = /^Bearer (.+)$/.exec(request.authorization ?? '')?.[1] ?? '';
    if (!sameToken(bearer, deps.token)) return json(401, { error: 'unauthorized' }, 'no-store');

    const match = /^\/v1\/(creator|token|funder|markets)\/([^/]+)$/.exec(path);
    if (!match) return json(404, { error: 'not found' });
    const address = match[2] as string;
    if (!ADDRESS.test(address)) return json(400, { error: 'invalid address' });
    return (routes[match[1] as string] as (a: string) => ApiResponse)(address.toLowerCase());
  };
}

export function serve(handle: ReturnType<typeof createApi>, port: number): Server {
  const server = createServer((req, res) => {
    let response: ApiResponse;
    try {
      response = handle({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        authorization: req.headers.authorization,
      });
    } catch (error) {
      console.error(JSON.stringify({ event: 'api-error', error: String(error).slice(0, 300) }));
      response = json(500, { error: 'internal error' }, 'no-store');
    }
    res.writeHead(response.status, response.headers);
    res.end(JSON.stringify(response.body));
  });
  server.listen(port);
  return server;
}
