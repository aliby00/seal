import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINT, PAIR, solanaReport } from '../helpers/solana-report';

const collect = vi.hoisted(() => vi.fn());

vi.mock('@/lib/collect', () => ({ collect }));

const { GET, OPTIONS } = await import('../../src/app/api/glance/route');
const { RateLimitError, NotFoundError } = await import('../../src/lib/errors');
const { resetRateLimits, GLANCE_LIMIT } = await import('../../src/lib/guard');
const { analysisCache } = await import('../../src/lib/analysis-cache');
const { resetGlanceState } = await import('../../src/lib/glance-service');

const TOKEN = MINT;
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AT = '2026-10-01T00:00:00.000Z';

/** A token whose creator sold some of it; holders not read. */
function report(notes: { creator?: string } = {}) {
  const base = solanaReport();
  return solanaReport({
    collectedAt: AT,
    completeness: 'partial',
    creator: {
      ...base.creator,
      sources: [
        { name: 'solana-rpc', fetchedAt: AT, ...(notes.creator ? { note: notes.creator } : {}) },
      ],
    },
    creatorOnToken: base.creatorOnToken && {
      ...base.creatorOnToken,
      data: { ...base.creatorOnToken.data, bought: '120000000000000', sold: '120000000000000' },
    },
    holders: {
      ...base.holders,
      completeness: 'unavailable',
      sources: [{ name: 'solana-rpc', fetchedAt: AT, note: 'not a token mint' }],
      data: { ...base.holders.data, top: [], setAside: [], holderCount: null, pooledShare: null },
    },
  });
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

  // Solana only: an EVM address, or an EVM pair, is refused before anything is read.
  it('rejects an EVM address as a token or as a pair', async () => {
    expect((await GET(get('token=0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9'))).status).toBe(400);
    expect((await GET(get(`pair=0x${'7f'.repeat(32)}`))).status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });

  it('returns the In short, the name and a deep link, without any model call', async () => {
    collect.mockResolvedValue(report());
    const res = await GET(get(`token=${TOKEN}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      glance: { headline: string; items: { id: string; tone: string }[]; unseen: string[] };
    };
    // The address keeps its case: base58 is case-sensitive.
    expect(body.token).toBe(TOKEN);
    // Name and symbol come from the mint's own metadata, read with the mint.
    expect(body.name).toBe('Test Token');
    expect(body.symbol).toBe('TEST');
    expect(body.collectedAt).toBe(AT);
    expect(body.glance.headline.length).toBeGreaterThan(0);
    expect(body.glance.unseen).toContain('who holds it');
    expect(body.url).toBe(`http://localhost/?token=${TOKEN}#analysis`);
    expect(body.cached).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/score|safe|risky|scam|rug/i);
  });

  it('links to the configured site when one is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://sealauth.dev');
    collect.mockResolvedValue(report());
    const body = (await (await GET(get(`token=${TOKEN}`))).json()) as { url: string };
    expect(body.url).toBe(`https://sealauth.dev/?token=${TOKEN}#analysis`);
  });

  it('serves the second request from the cache', async () => {
    collect.mockResolvedValue(report());
    await GET(get(`token=${TOKEN}`));
    const body = (await (await GET(get(`token=${TOKEN}`))).json()) as {
      cached: boolean;
    };
    expect(body.cached).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('does not cache a read that a source cut short', async () => {
    collect.mockResolvedValue(report({ creator: 'timeout : node did not answer' }));
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
          note: 'the first minutes after the launch could not be read this time (rate-limit : solana-rpc : request limit reached)',
        },
      ],
    });
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
      token: TOKEN,
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
    const res = await GET(get(`pair=${PAIR}`));
    expect(res.status).toBe(200);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain(
      `/latest/dex/pairs/solana/${PAIR}`,
    );
    expect(collect.mock.calls[0]?.[0]).toBe(TOKEN);
  });

  // A DexScreener URL may carry the mint itself: a pool and a mint look alike on Solana.
  it('treats an unknown pair as the token itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ pairs: null })),
    );
    collect.mockResolvedValue(report());
    expect((await GET(get(`pair=${TOKEN}`))).status).toBe(200);
    expect(collect.mock.calls[0]?.[0]).toBe(TOKEN);
  });

  it('answers 404 for an unknown pair that holds no mint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ pairs: null })),
    );
    collect.mockRejectedValue(new NotFoundError('solana-rpc', 'token mint'));
    expect((await GET(get(`pair=${PAIR}`))).status).toBe(404);
  });

  it('translates upstream failures into plain JSON errors', async () => {
    collect.mockRejectedValueOnce(new RateLimitError('solana-rpc'));
    expect((await GET(get(`token=${TOKEN}`))).status).toBe(429);
    collect.mockRejectedValueOnce(new NotFoundError('solana-rpc', 'token mint'));
    expect((await GET(get(`token=${TOKEN}`))).status).toBe(404);
    collect.mockRejectedValueOnce(new Error('stack trace interne'));
    const res = await GET(get(`token=${TOKEN}`));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).not.toContain('stack');
  });

  it('applies its own per-address budget', async () => {
    collect.mockResolvedValue(report());
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
