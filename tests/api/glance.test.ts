import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

const collect = vi.hoisted(() => vi.fn());
const readTokenMetas = vi.hoisted(() => vi.fn());

vi.mock('@/lib/collect', () => ({ collect }));
vi.mock('@/lib/chain/facts', () => ({ readTokenMetas }));

const { GET, OPTIONS } = await import('../../src/app/api/glance/route');
const { RateLimitError, NotFoundError } = await import('../../src/lib/errors');
const { resetRateLimits, GLANCE_LIMIT } = await import('../../src/lib/guard');
const { analysisCache } = await import('../../src/lib/analysis-cache');
const { resetGlanceState } = await import('../../src/lib/glance-service');

const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';
const PAIR_V4 = `0x${'7f'.repeat(32)}`;
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const launch = (dumped: boolean, pulled: boolean, i: number) => ({
  address: `0x${String(i).padStart(40, '0')}`,
  pool: '0xpool',
  launchedAtBlock: i,
  launchedAt: null,
  outcome: 'abandoned',
  graduationProgress: 0,
  creatorDumped: dumped,
  liquidityPulled: pulled,
});

function report(notes: { creator?: string } = {}) {
  return {
    token: getAddress(TOKEN),
    collectedAt: '2026-10-01T00:00:00.000Z',
    completeness: 'partial',
    creator: {
      completeness: 'full',
      sources: [{ name: 'robinhood-rpc', fetchedAt: 'x', note: notes.creator }],
      data: {
        creator: '0x00000000000000000000000000000000000000c0',
        tokens: [launch(true, false, 1), launch(true, false, 2), launch(false, false, 3)],
        counts: {
          launched: 3,
          graduated: 0,
          abandoned: 3,
          undetermined: 0,
          liquidityPulled: 0,
          creatorDumped: 2,
        },
        scannedRange: { fromBlock: 0, toBlock: 1 },
      },
    },
    holders: {
      completeness: 'unavailable',
      sources: [{ name: 'blockscout', fetchedAt: 'x', note: 'no API key' }],
      data: {
        token: TOKEN,
        countedSupply: '0',
        holderCount: null,
        top: [],
        concentration: { top1: 0, top10: 0 },
        distinctTraders: null,
      },
    },
    market: {
      completeness: 'unavailable',
      sources: [{ name: 'dexscreener', fetchedAt: 'x' }],
      data: {
        token: TOKEN,
        pair: null,
        priceUsd: null,
        liquidityUsd: null,
        pairedEth: null,
        graduation: null,
        volumeUsd: null,
        txns: null,
        fdvUsd: null,
        pairCreatedAt: null,
      },
    },
  };
}

function get(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/glance?${query}`, { headers });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetRateLimits();
  resetGlanceState();
  analysisCache.clear();
});

describe('GET /api/glance', () => {
  it('rejects an invalid address without collecting anything', async () => {
    const res = await GET(get('token=bonjour'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid token address' });
    expect(collect).not.toHaveBeenCalled();
  });

  it('rejects a transaction hash given as a token', async () => {
    expect((await GET(get(`token=0x${'ab'.repeat(32)}`))).status).toBe(400);
  });

  it('returns the In short, the name and a deep link, without any model call', async () => {
    collect.mockResolvedValue(report());
    readTokenMetas.mockResolvedValue(new Map([[TOKEN, { name: 'Alpha Token', symbol: 'ALP' }]]));
    const res = await GET(get(`token=${TOKEN}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      glance: { headline: string; items: { id: string; tone: string }[]; unseen: string[] };
    };
    expect(body.token).toBe(getAddress(TOKEN));
    expect(body.name).toBe('Alpha Token');
    expect(body.symbol).toBe('ALP');
    expect(body.collectedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(body.glance.items[0]).toMatchObject({ id: 'sales', tone: 'attention' });
    expect(body.glance.headline).toBe(
      'The creator sold into the pool on 2 of 3 launches checked. On its other launches: 2 of its 3 launches on pons.',
    );
    expect(body.glance.unseen).toContain('who holds it');
    expect(body.url).toBe(`http://localhost/?token=${getAddress(TOKEN)}#analysis`);
    expect(body.cached).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/score|safe|risky|scam|rug/i);
  });

  it('links to the configured site when one is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://sealauth.dev');
    collect.mockResolvedValue(report());
    readTokenMetas.mockResolvedValue(new Map());
    const body = (await (await GET(get(`token=${TOKEN}`))).json()) as { url: string };
    expect(body.url).toBe(`https://sealauth.dev/?token=${getAddress(TOKEN)}#analysis`);
  });

  it('serves the second request from the cache', async () => {
    collect.mockResolvedValue(report());
    readTokenMetas.mockResolvedValue(new Map());
    await GET(get(`token=${TOKEN}`));
    const body = (await (await GET(get(`token=${getAddress(TOKEN)}`))).json()) as {
      cached: boolean;
    };
    expect(body.cached).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('does not cache a read that a source cut short', async () => {
    collect.mockResolvedValue(report({ creator: 'timeout : node did not answer' }));
    readTokenMetas.mockResolvedValue(new Map());
    await GET(get(`token=${TOKEN}`));
    await GET(get(`token=${TOKEN}`));
    expect(collect).toHaveBeenCalledTimes(2);
  });

  // GNRG, 18/10/2026: the launch replay rate-limited, no source note saying so.
  it('does not cache a report a failed read left partial, and says it is partial', async () => {
    collect.mockResolvedValue({
      ...report(),
      failedReads: [
        {
          read: 'launch-replay',
          note: 'the first minutes after the launch could not be read this time (rate-limit : robinhood-rpc : request limit reached)',
        },
      ],
    });
    readTokenMetas.mockResolvedValue(new Map());
    const first = (await (await GET(get(`token=${TOKEN}`))).json()) as {
      glance: { partial?: string[] };
    };
    expect(first.glance.partial).toEqual(['the first minutes after its launch']);
    await GET(get(`token=${TOKEN}`));
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('collects a token once when several overlays ask at the same time', async () => {
    let release: (value: unknown) => void = () => {};
    collect.mockReturnValue(new Promise((resolve) => (release = resolve)));
    readTokenMetas.mockResolvedValue(new Map());
    const first = GET(get(`token=${TOKEN}`));
    const second = GET(get(`token=${TOKEN}`));
    await vi.waitFor(() => expect(collect).toHaveBeenCalled());
    release(report());
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('derives the glance from a cached full analysis without collecting', async () => {
    const { toFacts } = await import('../../src/lib/facts');
    await analysisCache.set(TOKEN, {
      token: getAddress(TOKEN),
      explanation: 'x',
      completeness: 'partial',
      sources: [],
      collectedAt: '2026-10-02T00:00:00.000Z',
      offline: false,
      name: 'From Analysis',
      symbol: 'FA',
      facts: toFacts(report() as never),
    });
    const body = (await (await GET(get(`token=${TOKEN}`))).json()) as Record<string, unknown>;
    expect(collect).not.toHaveBeenCalled();
    expect(body).toMatchObject({ name: 'From Analysis', cached: true });
  });

  it('resolves a DexScreener pair to the token it trades', async () => {
    const fetch = vi.fn(async () => Response.json({ pairs: [{ baseToken: { address: TOKEN } }] }));
    vi.stubGlobal('fetch', fetch);
    collect.mockResolvedValue(report());
    readTokenMetas.mockResolvedValue(new Map());
    const res = await GET(get(`pair=${PAIR_V4}`));
    expect(res.status).toBe(200);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain(
      `/latest/dex/pairs/robinhood/${PAIR_V4}`,
    );
    expect(collect.mock.calls[0]?.[0]).toBe(getAddress(TOKEN));
  });

  it('treats an unknown 40-character pair as the token itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ pairs: null })),
    );
    collect.mockResolvedValue(report());
    readTokenMetas.mockResolvedValue(new Map());
    expect((await GET(get(`pair=${TOKEN}`))).status).toBe(200);
    expect(collect.mock.calls[0]?.[0]).toBe(getAddress(TOKEN));
  });

  it('answers 404 for an unknown v4 pool id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ pairs: null })),
    );
    expect((await GET(get(`pair=${PAIR_V4}`))).status).toBe(404);
    expect(collect).not.toHaveBeenCalled();
  });

  it('translates upstream failures into plain JSON errors', async () => {
    readTokenMetas.mockResolvedValue(new Map());
    collect.mockRejectedValueOnce(new RateLimitError('robinhood-rpc'));
    expect((await GET(get(`token=${TOKEN}`))).status).toBe(429);
    collect.mockRejectedValueOnce(new NotFoundError('dexscreener', 'token'));
    expect((await GET(get(`token=${TOKEN}`))).status).toBe(404);
    collect.mockRejectedValueOnce(new Error('stack trace interne'));
    const res = await GET(get(`token=${TOKEN}`));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).not.toContain('stack');
  });

  it('applies its own per-address budget', async () => {
    collect.mockResolvedValue(report());
    readTokenMetas.mockResolvedValue(new Map());
    const headers = { 'x-real-ip': '203.0.113.9' };
    for (let i = 0; i < GLANCE_LIMIT.capacity; i += 1) {
      expect((await GET(get(`token=${TOKEN}`, headers))).status).toBe(200);
    }
    const res = await GET(get(`token=${TOKEN}`, headers));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });
});

describe('CORS', () => {
  it('echoes an extension origin, never with credentials', async () => {
    collect.mockResolvedValue(report());
    readTokenMetas.mockResolvedValue(new Map());
    const res = await GET(get(`token=${TOKEN}`, { origin: EXTENSION }));
    expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('accepts Firefox extensions and the site itself', async () => {
    const firefox = 'moz-extension://1b2c3d4e-0000-4000-8000-123456789abc';
    expect(OPTIONS(get('', { origin: firefox })).headers.get('access-control-allow-origin')).toBe(
      firefox,
    );
    expect(
      OPTIONS(get('', { origin: 'https://sealauth.dev' })).headers.get(
        'access-control-allow-origin',
      ),
    ).toBe('https://sealauth.dev');
  });

  it('refuses another website before spending anything', async () => {
    const res = await GET(get(`token=${TOKEN}`, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(collect).not.toHaveBeenCalled();
    const blind = await GET(
      get(`token=${TOKEN}`, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }),
    );
    expect(blind.status).toBe(403);
  });

  it('does not accept a look-alike extension origin', () => {
    const res = OPTIONS(get('', { origin: 'chrome-extension://x.evil.example/path' }));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
