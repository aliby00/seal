import { DatabaseSync } from 'node:sqlite';
import type { LaunchRow, MarketRow } from './abi.ts';
import type { FunderKind, FunderProfile } from './funder-kind.ts';

/**
 * Stockage SQLite (WAL). Toutes les insertions sont idempotentes sur
 * (txHash, logIndex) : relire une fenêtre après un redémarrage ne double rien,
 * c'est ce qui permet aux curseurs d'être simples.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  stream TEXT PRIMARY KEY,
  block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS block_times (
  block INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS launches (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  token TEXT NOT NULL,
  creator TEXT NOT NULL,
  pool TEXT NOT NULL,
  factory TEXT NOT NULL,
  dex_factory TEXT NOT NULL,
  pair_token TEXT NOT NULL,
  position_id TEXT NOT NULL,
  initial_buy TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER,
  launchpad TEXT NOT NULL DEFAULT 'pons',
  PRIMARY KEY (tx_hash, log_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS launches_token ON launches (token);
CREATE INDEX IF NOT EXISTS launches_creator ON launches (creator, block);
CREATE INDEX IF NOT EXISTS launches_pool ON launches (pool);
CREATE INDEX IF NOT EXISTS launches_block ON launches (block);
CREATE TABLE IF NOT EXISTS pool_token0 (
  pool TEXT PRIMARY KEY,
  token0 TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS swaps (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  pool TEXT NOT NULL,
  token TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  origin TEXT,
  amount0 TEXT NOT NULL,
  amount1 TEXT NOT NULL,
  side TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS swaps_token_ts ON swaps (token, ts);
CREATE TABLE IF NOT EXISTS markets (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  id TEXT NOT NULL,
  currency0 TEXT NOT NULL,
  currency1 TEXT NOT NULL,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hook TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER,
  PRIMARY KEY (tx_hash, log_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS markets_c0 ON markets (currency0);
CREATE INDEX IF NOT EXISTS markets_c1 ON markets (currency1);
CREATE TABLE IF NOT EXISTS funding (
  creator TEXT PRIMARY KEY,
  -- 'found' : un premier versement entrant a été trouvé ;
  -- 'none'  : Blockscout a répondu, aucun versement entrant de valeur.
  -- Pas de ligne = pas encore lu.
  status TEXT NOT NULL,
  funder TEXT,
  tx_hash TEXT,
  block INTEGER,
  kind TEXT,
  checked_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS funding_funder ON funding (funder);
CREATE TABLE IF NOT EXISTS funders (
  address TEXT PRIMARY KEY,
  -- 'service' | 'tool' | 'wallet' | 'unknown', from funder-kind.ts.
  kind TEXT NOT NULL,
  name TEXT,
  is_contract INTEGER NOT NULL,
  tx_count INTEGER,
  checked_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

export type SwapInsert = {
  txHash: string;
  logIndex: number;
  pool: string;
  token: string;
  block: number;
  ts: number;
  sender: string;
  recipient: string;
  origin: string | null;
  amount0: string;
  amount1: string;
  side: 'buy' | 'sell';
};

export type FundingInsert = {
  creator: string;
  status: 'found' | 'none';
  funder: string | null;
  txHash: string | null;
  block: number | null;
  kind: 'tx' | 'internal' | null;
};

export type FunderRow = {
  address: string;
  kind: FunderKind;
  name: string | null;
  is_contract: number;
  tx_count: number | null;
  checked_at: number;
};

export type FundingRow = {
  creator: string;
  status: 'found' | 'none';
  funder: string | null;
  tx_hash: string | null;
  block: number | null;
  kind: 'tx' | 'internal' | null;
  /** The sender of the funding transaction, read when the funder is a batch-sending tool. */
  origin: string | null;
  /** The address the funding is grouped by: the funder, or the sender behind a tool. */
  effective: string | null;
  checked_at: number;
};

export type Db = ReturnType<typeof openDb>;

/**
 * Brings a database created before a column existed up to the schema. Only
 * additions, each with a default, so every row already there keeps its
 * meaning: a launch indexed before launchpads existed is a pons launch.
 */
function migrate(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info(launches)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!columns.includes('launchpad')) {
    db.exec("ALTER TABLE launches ADD COLUMN launchpad TEXT NOT NULL DEFAULT 'pons'");
  }
  // Funder profiles came later: the rows already there are grouped once
  // their funder is profiled (`effective` stays NULL until then).
  const funding = (db.prepare('PRAGMA table_info(funding)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!funding.includes('origin')) db.exec('ALTER TABLE funding ADD COLUMN origin TEXT');
  if (!funding.includes('effective')) db.exec('ALTER TABLE funding ADD COLUMN effective TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS funding_effective ON funding (effective)');
}

export function openDb(path: string, now: () => number = Date.now) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Le cache de pages reste petit : la mémoire du conteneur sert au reste.
  db.exec('PRAGMA cache_size = -32000');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);

  const getCursor = db.prepare('SELECT block FROM cursors WHERE stream = ?');
  const setCursor = db.prepare(
    `INSERT INTO cursors (stream, block, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (stream) DO UPDATE SET block = excluded.block, updated_at = excluded.updated_at`,
  );
  const insertLaunch = db.prepare(
    `INSERT OR IGNORE INTO launches
       (tx_hash, log_index, token, creator, pool, factory, dex_factory, pair_token, position_id, initial_buy, block, ts, launchpad)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSwap = db.prepare(
    `INSERT OR IGNORE INTO swaps
       (tx_hash, log_index, pool, token, block, ts, sender, recipient, origin, amount0, amount1, side)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMarket = db.prepare(
    `INSERT OR IGNORE INTO markets
       (tx_hash, log_index, id, currency0, currency1, fee, tick_spacing, hook, block, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFunding = db.prepare(
    `INSERT INTO funding (creator, status, funder, tx_hash, block, kind, checked_at, origin, effective)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT (creator) DO UPDATE SET status = excluded.status, funder = excluded.funder,
       tx_hash = excluded.tx_hash, block = excluded.block, kind = excluded.kind,
       checked_at = excluded.checked_at, origin = NULL, effective = NULL`,
  );
  const getFunding = db.prepare('SELECT * FROM funding WHERE creator = ?');
  const getFunder = db.prepare('SELECT * FROM funders WHERE address = ?');
  const upsertFunder = db.prepare(
    `INSERT INTO funders (address, kind, name, is_contract, tx_count, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET kind = excluded.kind, name = excluded.name,
       is_contract = excluded.is_contract, tx_count = excluded.tx_count,
       checked_at = excluded.checked_at`,
  );
  // A tool groups by the sender behind it (NULL until read); anything else by itself.
  const regroup = db.prepare(
    `UPDATE funding SET effective = CASE WHEN ? = 'tool' THEN origin ELSE funder END
     WHERE funder = ? AND status = 'found'`,
  );
  const setOrigin = db.prepare(
    'UPDATE funding SET origin = ?, effective = ? WHERE creator = ? AND status = ?',
  );
  // Swaps are read for pons launch pools only: another launchpad's row names
  // a curve or nothing, never a Uniswap V3 pool of the token.
  const poolInfo = db.prepare(
    "SELECT token, pair_token FROM launches WHERE pool = ? AND launchpad = 'pons' LIMIT 1",
  );
  const getToken0 = db.prepare('SELECT token0 FROM pool_token0 WHERE pool = ?');
  const setToken0 = db.prepare('INSERT OR REPLACE INTO pool_token0 (pool, token0) VALUES (?, ?)');
  const getTime = db.prepare('SELECT ts FROM block_times WHERE block = ?');
  const setTime = db.prepare('INSERT OR REPLACE INTO block_times (block, ts) VALUES (?, ?)');
  const below = db.prepare(
    'SELECT block, ts FROM block_times WHERE block <= ? ORDER BY block DESC LIMIT 1',
  );
  const above = db.prepare(
    'SELECT block, ts FROM block_times WHERE block >= ? ORDER BY block ASC LIMIT 1',
  );
  const poolsPage = db.prepare(
    "SELECT DISTINCT pool FROM launches WHERE pool > ? AND block <= ? AND launchpad = 'pons' ORDER BY pool LIMIT ?",
  );

  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    raw: db,
    transaction,
    close: () => db.close(),

    cursor(stream: string): number | undefined {
      const row = getCursor.get(stream) as { block: number } | undefined;
      return row?.block;
    },
    setCursor(stream: string, block: number): void {
      setCursor.run(stream, block, now());
    },
    cursors(): { stream: string; block: number; updated_at: number }[] {
      return db.prepare('SELECT stream, block, updated_at FROM cursors ORDER BY stream').all() as {
        stream: string;
        block: number;
        updated_at: number;
      }[];
    },

    /** Insère, renvoie le nombre de lignes réellement nouvelles. */
    insertLaunches(rows: readonly (LaunchRow & { ts: number | null })[]): number {
      let inserted = 0;
      for (const r of rows) {
        inserted += Number(
          insertLaunch.run(
            r.txHash,
            r.logIndex,
            r.token,
            r.creator,
            r.pool,
            r.factory,
            r.dexFactory,
            r.pairToken,
            r.positionId,
            r.initialBuyAmount,
            r.block,
            r.ts,
            r.launchpad ?? 'pons',
          ).changes,
        );
      }
      return inserted;
    },
    insertSwaps(rows: readonly SwapInsert[]): number {
      let inserted = 0;
      for (const r of rows) {
        inserted += Number(
          insertSwap.run(
            r.txHash,
            r.logIndex,
            r.pool,
            r.token,
            r.block,
            r.ts,
            r.sender,
            r.recipient,
            r.origin,
            r.amount0,
            r.amount1,
            r.side,
          ).changes,
        );
      }
      return inserted;
    },
    insertMarkets(rows: readonly (MarketRow & { ts: number | null })[]): number {
      let inserted = 0;
      for (const r of rows) {
        inserted += Number(
          insertMarket.run(
            r.txHash,
            r.logIndex,
            r.id,
            r.currency0,
            r.currency1,
            r.fee,
            r.tickSpacing,
            r.hook,
            r.block,
            r.ts,
          ).changes,
        );
      }
      return inserted;
    },
    setFunding(row: FundingInsert): void {
      transaction(() => {
        insertFunding.run(
          row.creator,
          row.status,
          row.funder,
          row.txHash,
          row.block,
          row.kind,
          now(),
        );
        // A funder already profiled groups the new row at once.
        const known = row.funder ? (getFunder.get(row.funder) as FunderRow | undefined) : undefined;
        if (known && row.funder) regroup.run(known.kind, row.funder);
      });
    },
    funding(address: string): FundingRow | undefined {
      return getFunding.get(address) as FundingRow | undefined;
    },
    funder(address: string): FunderRow | undefined {
      const row = getFunder.get(address) as FunderRow | undefined;
      // Profiled before every contract was a service: a contract is never "a
      // wallet that funded others", whatever was stored.
      return row && row.kind === 'wallet' && row.is_contract === 1
        ? { ...row, kind: 'service' }
        : row;
    },
    /** Stores a funder's profile and regroups every funding it made. */
    setFunder(profile: FunderProfile, kind: FunderKind): void {
      transaction(() => {
        upsertFunder.run(
          profile.address,
          kind,
          profile.name,
          profile.isContract ? 1 : 0,
          profile.txCount,
          now(),
        );
        regroup.run(kind, profile.address);
      });
    },
    /** The sender behind a funding sent through a batch-sending tool. */
    setOrigin(creator: string, origin: string): void {
      setOrigin.run(origin, origin, creator, 'found');
    },

    poolInfo(pool: string): { token: string; pair_token: string } | undefined {
      return poolInfo.get(pool) as { token: string; pair_token: string } | undefined;
    },
    token0(pool: string): string | undefined {
      return (getToken0.get(pool) as { token0: string } | undefined)?.token0;
    },
    setToken0(pool: string, token0: string): void {
      setToken0.run(pool, token0);
    },
    blockTime(block: number): number | undefined {
      return (getTime.get(block) as { ts: number } | undefined)?.ts;
    },
    setBlockTime(block: number, ts: number): void {
      setTime.run(block, ts);
    },
    anchorBelow(block: number): { block: number; ts: number } | undefined {
      return below.get(block) as { block: number; ts: number } | undefined;
    },
    anchorAbove(block: number): { block: number; ts: number } | undefined {
      return above.get(block) as { block: number; ts: number } | undefined;
    },
    /** Pools lancés jusqu'à `maxBlock`, par pages, sans tout charger en mémoire. */
    poolsAfter(after: string, maxBlock: number, limit: number): string[] {
      return (poolsPage.all(after, maxBlock, limit) as { pool: string }[]).map((r) => r.pool);
    },
    count(table: 'launches' | 'swaps' | 'markets' | 'funding' | 'funders'): number {
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    },
  };
}
