import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { decodeLaunch } from '../src/abi.ts';
import { createApi } from '../src/api.ts';
import { openDb, type Db } from '../src/db.ts';
import type { FunderKind } from '../src/funder-kind.ts';
import { createNetwork, MAX_DEPTH, NETWORK_CAP } from '../src/network.ts';
import { addressUrl, firstIncoming, fundingStream, sentBy } from '../src/streams/funding.ts';
import { fakeRpc, fixedClock, launchLog, memoryDb } from './helpers.ts';

const FACTORY = '0x00000000000000000000000000000000000000f1';
const POOL = '0x00000000000000000000000000000000000000c1';
const SECRET = 'test-token-0123456789abcdefghij';
const silent = () => undefined;

/** A distinct address per label, readable in failures. */
const addr = (n: number, prefix = 'a') => `0x${prefix}${n.toString(16).padStart(39, '0')}`;
const CREATOR = addr(1, 'c');
const W1 = addr(1, 'e');
const W2 = addr(2, 'e');
const W3 = addr(3, 'e');
const W4 = addr(4, 'e');
const EXCHANGE = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';
const GASLITE = '0xe68d0bbc023de3febda04f413db23ce9c5ea1934';

let tokenSeq = 1;
function launch(db: Db, creator: string, count = 1, ts = 1_700_000_000): void {
  for (let i = 0; i < count; i += 1) {
    const token = addr(tokenSeq, 'b');
    tokenSeq += 1;
    db.insertLaunches([
      {
        ...decodeLaunch(
          launchLog({ factory: FACTORY, token, creator, pool: POOL, block: tokenSeq }),
        ),
        ts: ts + i,
      },
    ]);
  }
}

function fund(db: Db, creator: string, funder: string, txHash = `0x${creator.slice(2)}`): void {
  db.setFunding({ creator, status: 'found', funder, txHash, block: 1, kind: 'tx' });
}

function profile(db: Db, address: string, kind: FunderKind, txCount = 10, name?: string): void {
  db.setFunder(
    { address, isContract: kind !== 'wallet', name: name ?? null, txCount, tags: [] },
    kind,
  );
}

describe('funders table and migration', () => {
  it('adds origin and effective to a funding table created before them, rows kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seal-funders-'));
    const path = join(dir, 'old.db');
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE funding (
        creator TEXT PRIMARY KEY, status TEXT NOT NULL, funder TEXT, tx_hash TEXT,
        block INTEGER, kind TEXT, checked_at INTEGER NOT NULL) WITHOUT ROWID;
        CREATE INDEX funding_funder ON funding (funder);`);
      old
        .prepare('INSERT INTO funding VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(CREATOR, 'found', W1, '0x1', 5, 'tx', 1);
      old.close();

      const db = openDb(path);
      const columns = (
        db.raw.prepare('PRAGMA table_info(funding)').all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['origin', 'effective']));
      expect(db.count('funders')).toBe(0);
      // Grouped lazily: nothing until the funder is profiled.
      expect(db.funding(CREATOR)).toMatchObject({ funder: W1, origin: null, effective: null });
      profile(db, W1, 'wallet');
      expect(db.funding(CREATOR)?.effective).toBe(W1);
      db.close();
      // Opening again changes nothing.
      const again = openDb(path);
      expect(again.funding(CREATOR)?.effective).toBe(W1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('groups a tool funding by its sender once read, and a new row at once', () => {
    const db = memoryDb();
    profile(db, GASLITE, 'tool', 1_000_000, 'GasliteDrop');
    fund(db, CREATOR, GASLITE);
    expect(db.funding(CREATOR)?.effective).toBeNull();
    db.setOrigin(CREATOR, W1);
    expect(db.funding(CREATOR)).toMatchObject({ origin: W1, effective: W1 });
  });
});

describe('funding stream: profiles and senders', () => {
  function answers(byUrl: (url: string) => unknown) {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(String(url));
      return Response.json(byUrl(String(url)));
    }) as unknown as typeof globalThis.fetch;
    return { urls, fetch };
  }

  it('profiles the most-used funder first, within the daily budget', async () => {
    const db = memoryDb();
    for (let i = 1; i <= 3; i += 1) {
      launch(db, addr(i, 'c'));
      fund(db, addr(i, 'c'), i < 3 ? EXCHANGE : W1);
    }
    const { urls, fetch } = answers((url) =>
      url.includes('/counters')
        ? { transactions_count: url.includes(EXCHANGE) ? '2266426' : '33' }
        : { is_contract: false, name: null, metadata: null },
    );
    const stream = fundingStream({
      db,
      apiKey: 'k',
      log: silent,
      sleep: async () => undefined,
      fetch,
      dailyCalls: 2,
    });
    expect(await stream.step()).toBe(true);
    expect(urls).toEqual([addressUrl(EXCHANGE, 'k', false), addressUrl(EXCHANGE, 'k', true)]);
    expect(db.funder(EXCHANGE)).toMatchObject({ kind: 'service', tx_count: 2_266_426 });
    expect(stream.usage()).toEqual({ callsToday: 2, dailyCalls: 2 });
    // The budget is spent: the other funder waits for tomorrow.
    stream.prioritizeProfile(W1);
    expect(await stream.step()).toBe(false);
  });

  it('reads the sender behind a batch-sending tool through the RPC, outside the budget', async () => {
    const db = memoryDb();
    launch(db, CREATOR);
    fund(db, CREATOR, GASLITE, '0xfeed');
    profile(db, GASLITE, 'tool', 1_000_000, 'GasliteDrop');
    const rpc = fakeRpc({
      call: ({ method, params }) =>
        method === 'eth_getTransactionByHash' && params[0] === '0xfeed'
          ? { from: W1.toUpperCase().replace('0X', '0x') }
          : null,
    });
    const stream = fundingStream({
      db,
      apiKey: 'k',
      log: silent,
      rpc,
      sleep: async () => undefined,
      fetch: (async () => {
        throw new Error('no Blockscout call expected');
      }) as unknown as typeof fetch,
      dailyCalls: 2,
    });
    stream.prioritizeOrigin(CREATOR);
    expect(await stream.step()).toBe(true);
    expect(db.funding(CREATOR)).toMatchObject({ origin: W1, effective: W1 });
    expect(stream.usage().callsToday).toBe(0);
  });
});

describe('network walk', () => {
  /** creator ← W1 ← W2 ← W3 ← W4, each wallet funding `n` other creators. */
  function chain(n = 2) {
    const db = memoryDb();
    launch(db, CREATOR);
    const wallets = [W1, W2, W3, W4];
    fund(db, CREATOR, W1);
    let seq = 100;
    wallets.forEach((w, i) => {
      profile(db, w, 'wallet', 30 + i);
      if (i + 1 < wallets.length) fund(db, w, wallets[i + 1] as string);
      for (let k = 0; k < n; k += 1) {
        const c = addr(seq, 'd');
        seq += 1;
        launch(db, c, 2);
        fund(db, c, w);
      }
    });
    return db;
  }

  it('walks three wallet levels at most and counts the linked creators and their launches', () => {
    const db = chain(2);
    const net = createNetwork(db).walk(CREATOR);
    expect(MAX_DEPTH).toBe(3);
    expect(net).toMatchObject({
      creators: 6,
      launches: 12,
      launchpads: { pons: 12 },
      depth: 3,
      incomplete: false,
      capped: false,
    });
    expect(net.path.map((s) => [s.level, s.address, s.kind, s.txCount, s.creatorsFunded])).toEqual([
      [1, W1, 'wallet', 30, 2],
      [2, W2, 'wallet', 31, 2],
      [3, W3, 'wallet', 32, 2],
    ]);
    expect(net.firstLaunchAt).toBe('2023-11-14T22:13:20.000Z');
  });

  it('stops at a high-volume service, whose creators are not linked', () => {
    const db = chain(2);
    // W2 is now an exchange: W1's creators count, W2's and above do not.
    profile(db, W2, 'service', 2_266_426);
    const net = createNetwork(db).walk(CREATOR);
    expect(net).toMatchObject({ creators: 2, depth: 1, incomplete: false });
    expect(net.path.map((s) => s.kind)).toEqual(['wallet', 'service']);
  });

  it('says it is incomplete, and asks for it, when a wallet’s own funding is not read', () => {
    const db = chain(1);
    db.raw.prepare('DELETE FROM funding WHERE creator = ?').run(W1);
    const asked: string[] = [];
    const net = createNetwork(db).walk(CREATOR, { funding: (a) => asked.push(a) });
    expect(net).toMatchObject({ creators: 1, depth: 1, incomplete: true });
    expect(net.reason).toMatch(/first funding of 0xe000…0001 has not been read yet/);
    expect(asked).toEqual([W1]);
  });

  it('asks for an unprofiled funder and links nobody through it', () => {
    const db = memoryDb();
    launch(db, CREATOR);
    fund(db, CREATOR, W1);
    const asked: string[] = [];
    const net = createNetwork(db).walk(CREATOR, { profile: (a) => asked.push(a) });
    expect(net).toMatchObject({ creators: 0, incomplete: true });
    expect(net.path).toEqual([
      expect.objectContaining({ address: W1, kind: 'unknown', creatorsFunded: 0 }),
    ]);
    expect(asked).toEqual([W1]);
  });

  it('follows the sender behind a batch-sending tool', () => {
    const db = memoryDb();
    launch(db, CREATOR);
    profile(db, GASLITE, 'tool', 1_000_000, 'GasliteDrop');
    profile(db, W1, 'wallet', 33);
    fund(db, CREATOR, GASLITE, '0x01');
    const sibling = addr(7, 'd');
    launch(db, sibling, 3);
    fund(db, sibling, GASLITE, '0x02');
    const asked: string[] = [];
    const before = createNetwork(db).walk(CREATOR, { origin: (c) => asked.push(c) });
    expect(before).toMatchObject({ creators: 0, incomplete: true });
    expect(before.reason).toMatch(/batch-sending tool/);
    expect(asked).toEqual([CREATOR]);
    db.setOrigin(CREATOR, W1);
    db.setOrigin(sibling, W1);
    const after = createNetwork(db).walk(CREATOR);
    expect(after).toMatchObject({ creators: 1, launches: 3 });
    expect(after.path[0]).toMatchObject({
      address: W1,
      kind: 'wallet',
      via: { address: GASLITE, name: 'GasliteDrop' },
    });
  });

  it('caps the creators collected and says so', () => {
    const db = memoryDb();
    launch(db, CREATOR);
    fund(db, CREATOR, W1);
    profile(db, W1, 'wallet', 600);
    db.transaction(() => {
      for (let i = 0; i < NETWORK_CAP + 2; i += 1) {
        const c = addr(1000 + i, 'd');
        db.insertLaunches([
          {
            ...decodeLaunch(
              launchLog({
                factory: FACTORY,
                token: addr(5000 + i, 'b'),
                creator: c,
                pool: POOL,
                block: 10_000 + i,
              }),
            ),
            ts: 1,
          },
        ]);
        db.raw
          .prepare(
            "INSERT INTO funding (creator, status, funder, tx_hash, block, kind, checked_at, effective) VALUES (?, 'found', ?, ?, 1, 'tx', 1, ?)",
          )
          .run(c, W1, `0x${i}`, W1);
      }
    });
    const net = createNetwork(db).walk(CREATOR);
    expect(net).toMatchObject({ creators: NETWORK_CAP, capped: true });
    expect(net.path[0]?.creatorsFunded).toBe(NETWORK_CAP + 2);
  });
});

describe('API: funding kinds and network', () => {
  function api() {
    const db = memoryDb();
    const asked: string[] = [];
    const handle = createApi({
      db,
      clock: fixedClock(500),
      rpc: { stats: () => ({ requests: 0, rateLimited: 0 }) },
      token: SECRET,
      fundingEnabled: true,
      prioritizeFunding: (a) => asked.push(`funding:${a}`),
      prioritizeProfile: (a) => asked.push(`profile:${a}`),
      prioritizeOrigin: (a) => asked.push(`origin:${a}`),
    });
    const get = (url: string) => handle({ method: 'GET', url, authorization: `Bearer ${SECRET}` });
    return { db, get, asked };
  }

  it('lists no linked creators for an exchange-funded creator', () => {
    const { db, get } = api();
    launch(db, CREATOR);
    launch(db, W1);
    fund(db, CREATOR, EXCHANGE);
    fund(db, W1, EXCHANGE);
    profile(db, EXCHANGE, 'service', 2_266_426);
    expect(get(`/v1/creator/${CREATOR}`).body).toMatchObject({
      fundingState: 'found',
      funding: {
        funder: EXCHANGE,
        funderKind: 'service',
        funderTxCount: 2_266_426,
        effective: EXCHANGE,
        effectiveKind: 'service',
        otherCreatorsFunded: [],
      },
    });
    expect(get(`/v1/funder/${EXCHANGE}`).body).toMatchObject({
      profile: { kind: 'service', txCount: 2_266_426, isContract: true },
      fundedDirectly: 2,
    });
  });

  it('answers the network of a creator, and asks for what is missing', () => {
    const { db, get, asked } = api();
    launch(db, CREATOR);
    fund(db, CREATOR, W1);
    profile(db, W1, 'wallet', 33);
    for (let i = 0; i < 3; i += 1) {
      const c = addr(200 + i, 'd');
      launch(db, c, 2);
      fund(db, c, W1);
    }
    const body = get(`/v1/network/${CREATOR}`).body as Record<string, unknown>;
    expect(body).toMatchObject({
      creator: CREATOR,
      cap: NETWORK_CAP,
      network: {
        creators: 3,
        launches: 6,
        depth: 1,
        incomplete: true,
        reason: expect.stringMatching(/first funding of/),
        path: [{ level: 1, address: W1, kind: 'wallet', txCount: 33, creatorsFunded: 3 }],
      },
    });
    expect(asked).toContain(`funding:${W1}`);
    expect(get(`/v1/network/${addr(9, 'f')}`).status).toBe(404);
  });
});

describe('funders stored before every contract was a service (audit, AGEM)', () => {
  it('reads a contract stored as a wallet as a service, so it links nobody', () => {
    const db = memoryDb();
    const executor = '0xa5166c3e69a933ee547ad908c9f1474f8f61901a';
    // Stored by an older classifier: an 8 KB contract named "Executor", 0 txs, as a wallet.
    db.setFunder(
      { address: executor, isContract: true, name: 'Executor', txCount: 0, tags: [] },
      'wallet',
    );
    expect(db.funder(executor)?.kind).toBe('service');
    launch(db, CREATOR);
    launch(db, W1);
    fund(db, CREATOR, executor);
    fund(db, W1, executor);
    const network = createNetwork(db).walk(CREATOR);
    expect(network.creators).toBe(0);
    expect(network.path[0]?.kind).toBe('service');
  });
});

describe('first funding: an unwrap is not a funding (audit, BONER)', () => {
  it('skips ETH sent by WETH, and value received inside the creator’s own transaction', () => {
    const creator = '0x79aeae6a47ff2e551f60bd87dbd6358efeaf4dc8';
    const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
    const normal = [{ blockNumber: '120', hash: '0xunwrap', from: creator, to: weth, value: '0' }];
    const internal = [
      { blockNumber: '90', transactionHash: '0xolder', from: weth, to: creator, value: '9' },
      { blockNumber: '95', transactionHash: '0xunwrap', from: addr(9), to: creator, value: '9' },
    ];
    expect(firstIncoming(creator, internal, sentBy(creator, normal))).toBeNull();
  });
});
