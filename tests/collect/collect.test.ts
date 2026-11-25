import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, marketCompleteness } from '../../src/lib/collect';
import { NotFoundError } from '../../src/lib/errors';
import { createFakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import { solanaRpcFrom, type RecordedCall } from '../../src/lib/solana/rpc';
import {
  COLLECT_FIXTURES,
  COLLECT_TOKENS,
  dexFetch,
  LONG_TIMEOUTS,
  loadCollectRecording,
  NO_TIME_LIMIT,
} from './recording';

/**
 * `collect` from end to end, on three reference tokens recorded on mainnet
 * (record.live.test.ts): every Solana call answered by the fake node, every
 * DexScreener answer by a fake `fetch`. The replay must give the report the
 * recording gave, block for block; then each token is checked on what the
 * chain showed for it.
 */

afterEach(() => vi.unstubAllGlobals());

async function replay(slug: string) {
  const recording = loadCollectRecording(slug);
  vi.stubGlobal('fetch', dexFetch(recording));
  const rpc = createFakeSolanaRpc(recording.rpc, { sequential: true });
  const report = await collect(recording.mint, {
    rpc,
    now: () => new Date(recording.now),
    deadlineMs: NO_TIME_LIMIT,
    timeouts: LONG_TIMEOUTS,
  });
  return { recording, report, rpc };
}

describe.each(COLLECT_TOKENS.map((t) => t.slug))('collect, replayed: %s', (slug) => {
  it.skipIf(!existsSync(join(COLLECT_FIXTURES, `${slug}.json.gz`)))(
    'gives the report the recording gave, from the recorded answers alone',
    async () => {
      const { recording, report } = await replay(slug);
      expect(JSON.parse(JSON.stringify(report))).toEqual(recording.report);
    },
  );
});

describe('collect, what each reference token shows', () => {
  it('pump.fun, creator sold: creator from the curve, holders with the curve set aside', async () => {
    const { report } = await replay('pump-creator-sold');
    expect(report.chain).toBe('solana');
    expect(report.token).toBe('FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump');
    expect(report.mint.data?.program).toBe('token-2022');
    expect(report.creator.data.from).toBe('pump-curve');
    expect(report.creator.data.creator).toMatch(/^D234v6Hg/);
    expect(report.launchpad.data.launchpad?.id).toBe('pump.fun');
    expect(report.graduation?.data.launchpad).toBe('pump.fun');
    // What the creator did with this token: it bought at launch and sold.
    expect(report.creatorOnToken?.data.sold).not.toBe('0');
    expect(report.creatorHistory?.data.creator).toBe(report.creator.data.creator);
    expect(report.linkedWallets?.data.creator).toBe(report.creator.data.creator);
    expect(report.holders.data.method).not.toBe('none');
    // Addresses keep their case.
    expect(report.holders.data.top.every((h) => h.address === h.address.trim())).toBe(true);
    expect(report.launch.data.creation?.payer).toBeDefined();
    expect(report.powers.length).toBeGreaterThan(0);
  });

  it('Meteora DBC: the launchpad is read from its pool', async () => {
    const { report } = await replay('meteora-dbc');
    expect(report.token).toBe('8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx');
    expect(report.launchpad.data.launchpad?.id).toBe('meteora-dbc');
    expect(report.graduation).not.toBeNull();
  });

  it('a token still on its curve, read on chain, is not partial for DexScreener’s missing liquidity alone', async () => {
    // pump.fun (The Poor Bull) and Meteora DBC (CLARYX), recorded on 25/11/2026:
    // mint, creator and holders read in full; DexScreener gives no liquidity
    // figure for a curve, whose reserves SEAL read itself.
    for (const slug of ['pump-creator-sold', 'meteora-dbc']) {
      const { report } = await replay(slug);
      expect(report.market.completeness).toBe('partial');
      expect(report.market.sources[0]?.note).toMatch(/no liquidity figure/);
      expect(report.graduation?.data.graduated).toBe(false);
      expect(report.graduation?.data.account).toBe(report.market.data.pair);
      expect(report.completeness).toBe('full');
    }
  });

  it('PYUSD: no launchpad, and the powers its Token-2022 extensions give', async () => {
    const { report } = await replay('pyusd');
    expect(report.mint.data?.program).toBe('token-2022');
    expect(report.launchpad.data.launchpad).toBeNull();
    expect(report.graduation).toBeNull();
    const powers = new Set(report.powers.map((p) => p.power));
    expect(powers.has('permanent-delegate')).toBe(true);
    expect(powers.has('transfer-hook')).toBe(true);
    expect(report.powers.every((p) => p.sentence.length > 0)).toBe(true);
    // Its creation was not reached and its holders not listed: still partial.
    expect(report.completeness).toBe('partial');
  });
});

describe('the market’s part in the report’s completeness', () => {
  const CURVE = 'NYquJDUKYAXvRBptxagxQJBXwRi9MZpFZVoApxYQnb2';
  async function curveMarket() {
    const { report } = await replay('pump-creator-sold');
    return {
      market: report.market,
      launch: report.launchpad,
      graduation: report.graduation,
      liquidity: report.liquidity,
    };
  }

  it('counts the curve read on chain in place of DexScreener’s liquidity figure', async () => {
    const read = await curveMarket();
    expect(read.market.data.pair).toBe(CURVE);
    expect(marketCompleteness(read)).toBe('full');
  });

  it('stays partial when the curve was not read, has graduated, or is not the main pair', async () => {
    const read = await curveMarket();
    const graduation = read.graduation!;
    expect(marketCompleteness({ ...read, graduation: null })).toBe('partial');
    expect(
      marketCompleteness({ ...read, graduation: { ...graduation, completeness: 'unavailable' } }),
    ).toBe('partial');
    expect(
      marketCompleteness({
        ...read,
        graduation: { ...graduation, data: { ...graduation.data, graduated: true } },
      }),
    ).toBe('partial');
    expect(
      marketCompleteness({
        ...read,
        graduation: { ...graduation, data: { ...graduation.data, raised: null } },
      }),
    ).toBe('partial');
    expect(
      marketCompleteness({
        ...read,
        market: { ...read.market, data: { ...read.market.data, pair: 'OtherPool111' } },
      }),
    ).toBe('partial');
    // A price missing too is not the curve's doing.
    expect(
      marketCompleteness({
        ...read,
        market: { ...read.market, data: { ...read.market.data, priceUsd: null } },
      }),
    ).toBe('partial');
  });
});

/** A node that refuses every method SEAL asks, for its rate. */
const REFUSING: RecordedCall[] = [
  'getAccountInfo',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getTokenLargestAccounts',
  'getTokenAccountsByOwner',
  'getSignaturesForAddress',
  'getTransaction',
  'getSlot',
  'getBlock',
  'getEpochInfo',
].map((method) => ({ method, error: { code: 429, message: 'Too many requests' } }));

describe('collect when the sources fail', () => {
  it('refuses what is not a Solana address, an EVM one included, without a call', async () => {
    const rpc = createFakeSolanaRpc([]);
    for (const token of ['0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9', 'bonjour', '']) {
      await expect(collect(token, { rpc })).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(rpc.calls).toEqual([]);
  });

  it('says an address that holds no mint is not found', async () => {
    vi.stubGlobal('fetch', async () => Response.json([]));
    const rpc = createFakeSolanaRpc([
      { method: 'getMultipleAccounts', result: { context: { slot: 1 }, value: [null, null] } },
      ...REFUSING,
    ]);
    await expect(
      collect('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', { rpc }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('never throws when every read fails: each block unavailable, each failure named', async () => {
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 429 }));
    const rpc = createFakeSolanaRpc(REFUSING);
    const report = await collect('FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump', {
      rpc,
      deadlineMs: NO_TIME_LIMIT,
    });
    expect(report.mint.completeness).toBe('unavailable');
    expect(report.creator.completeness).toBe('unavailable');
    expect(report.creator.data.creator).toBeNull();
    // Without a creator, its later reads are not made: null, never an empty finding.
    expect(report.creatorHistory).toBeNull();
    expect(report.creatorOnToken).toBeNull();
    expect(report.linkedWallets).toBeNull();
    expect(report.holders.completeness).toBe('unavailable');
    expect(report.market.completeness).toBe('unavailable');
    expect(report.completeness).toBe('partial');
    const failed = new Set(report.failedReads?.map((f) => f.read));
    for (const read of ['token', 'creator', 'holders', 'market'] as const) {
      expect(failed.has(read)).toBe(true);
    }
    expect(JSON.stringify(report)).not.toMatch(/\bscore\b|\bsafe\b|\bscam\b|\brug\b/i);
  });

  it('is cut at its deadline, the requests in flight aborted, and still gives a report', async () => {
    vi.stubGlobal('fetch', (_: unknown, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });
    const seen: (AbortSignal | undefined)[] = [];
    const rpc = solanaRpcFrom(<T>(_m: string, _p: readonly unknown[], signal?: AbortSignal) => {
      seen.push(signal);
      return new Promise<T>(() => {});
    });
    const started = Date.now();
    const report = await collect('FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump', {
      rpc,
      deadlineMs: 1_200,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s?.aborted)).toBe(true);
    expect(report.completeness).not.toBe('full');
    expect(report.failedReads?.length).toBeGreaterThan(0);
  });

  it('stops when the caller gives up', async () => {
    const rpc = solanaRpcFrom(<T>() => new Promise<T>(() => {}));
    // A request that never answers, until its signal aborts it (as fetch does).
    vi.stubGlobal('fetch', (_: unknown, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });
    const giveUp = new AbortController();
    const cut = collect('FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump', {
      rpc,
      deadlineMs: NO_TIME_LIMIT,
      signal: giveUp.signal,
    });
    setTimeout(() => giveUp.abort(), 50);
    const report = await cut;
    expect(report.mint.completeness).toBe('unavailable');
  });
});
