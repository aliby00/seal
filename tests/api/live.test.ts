import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINT } from '../helpers/solana-report';

const reads = vi.hoisted(() => ({ market: vi.fn(), holders: vi.fn() }));

vi.mock('@/lib/live', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/live')>();
  return { ...actual, readLiveMarket: reads.market, readLiveHolders: reads.holders };
});

const { GET } = await import('../../src/app/api/live/route');
const { liveMarketCache, liveHoldersCache } = await import('../../src/lib/live');
const { resetRateLimits } = await import('../../src/lib/guard');
const { encodeBase58 } = await import('../../src/lib/solana/address');

const AT = '2026-11-26T12:00:00.000Z';
const CREATOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function market(priceUsd: number) {
  return {
    token: MINT,
    at: AT,
    priceUsd,
    marketCapUsd: 100_000,
    fdvUsd: 100_000,
    liquidityUsd: 20_000,
    liquidityToMarketCap: 0.2,
    volume24hUsd: 50_000,
    buys24h: 10,
    sells24h: 5,
    perTradeUsd24h: 3_333,
  };
}

const holders = {
  token: MINT,
  at: AT,
  holderCount: 420,
  top1OfSupply: 0.05,
  top10OfSupply: 0.3,
  devHolds: 0.02,
};

const get = (query: string, ip = '203.0.113.7') =>
  GET(new Request(`http://localhost/api/live?${query}`, { headers: { 'x-real-ip': ip } }));

// Each test uses its own tokens: the shared caches need no reset between them.
afterEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
});

describe('GET /api/live', () => {
  it('rejects what is not a Solana mint before any read', async () => {
    for (const token of ['bonjour', `0x${'ab'.repeat(20)}`, '1'.repeat(31), '']) {
      const res = await get(`token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(400);
    }
    expect(reads.market).not.toHaveBeenCalled();
    expect(reads.holders).not.toHaveBeenCalled();
  });

  it('reads the market once, then serves the shared copy to every caller', async () => {
    const token = 'So11111111111111111111111111111111111111112';
    reads.market.mockResolvedValue({ ...market(1), token });
    const first = await (await get(`token=${token}`, '198.51.100.1')).json();
    const second = await (await get(`token=${token}`, '198.51.100.2')).json();
    expect(first.market.priceUsd).toBe(1);
    expect(second.market.priceUsd).toBe(1);
    expect(reads.market).toHaveBeenCalledTimes(1);
  });

  it('does not charge a cache hit against the caller’s bucket', async () => {
    const token = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    await liveMarketCache.set(token, { ...market(2), token });
    // Far more polls than the bucket holds: every one is served from the cache.
    for (let i = 0; i < 60; i += 1) {
      const body = await (await get(`token=${token}`)).json();
      expect(body.market.priceUsd).toBe(2);
    }
    expect(reads.market).not.toHaveBeenCalled();
  });

  it('stops reading upstream for a caller past its bucket, and says nothing rather than fail', async () => {
    reads.market.mockImplementation(async (token: string) => ({ ...market(3), token }));
    // Distinct valid mints, so each one misses the cache.
    const tokens = Array.from({ length: 40 }, (_, i) =>
      encodeBase58(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i + 1 : 7))),
    );
    let served = 0;
    for (const token of tokens) {
      const res = await get(`token=${token}`, '192.0.2.9');
      expect(res.status).toBe(200);
      if ((await res.json()).market) served += 1;
    }
    expect(served).toBe(30);
    expect(reads.market).toHaveBeenCalledTimes(30);
  });

  it('reads the holders and the creator’s balance only when asked, kept per token and creator', async () => {
    const token = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    reads.market.mockResolvedValue({ ...market(4), token });
    reads.holders.mockResolvedValue({ ...holders, token });
    const plain = await (await get(`token=${token}`)).json();
    expect(plain.holders).toBeNull();
    expect(reads.holders).not.toHaveBeenCalled();
    const asked = await (await get(`token=${token}&holders=1&creator=${CREATOR}`)).json();
    expect(asked.holders.devHolds).toBe(0.02);
    expect(reads.holders).toHaveBeenCalledWith(token, CREATOR);
    await get(`token=${token}&holders=1&creator=${CREATOR}`, '198.51.100.77');
    expect(reads.holders).toHaveBeenCalledTimes(1);
    expect(await liveHoldersCache.get(`${token}:${CREATOR}`)).toBeDefined();
  });

  it('ignores a creator that is not an address', async () => {
    const token = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    reads.market.mockResolvedValue({ ...market(5), token });
    reads.holders.mockResolvedValue({ ...holders, token, devHolds: null });
    await get(`token=${token}&holders=1&creator=nope`);
    expect(reads.holders).toHaveBeenCalledWith(token, null);
  });
});
