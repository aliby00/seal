import { beforeEach, describe, expect, it } from 'vitest';
import {
  allow,
  bucketOf,
  clientKey,
  crossSite,
  guardedJson,
  MAX_BODY_BYTES,
  resetRateLimits,
  type RateLimit,
} from '../../src/lib/guard';

const LIMIT: RateLimit = { capacity: 2, perMinute: 6 };

function req(init: { body?: string; headers?: Record<string, string> } = {}): Request {
  return new Request('https://seal.example/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body ?? '{"token":"0x"}',
  });
}

beforeEach(() => resetRateLimits());

describe('allow', () => {
  it('lets a burst through, then refuses, then refills over time', () => {
    expect(allow('a', LIMIT, 0)).toBe(true);
    expect(allow('a', LIMIT, 0)).toBe(true);
    expect(allow('a', LIMIT, 0)).toBe(false);
    // 6 per minute: one more after ten seconds.
    expect(allow('a', LIMIT, 10_000)).toBe(true);
  });

  it('counts each caller separately', () => {
    allow('a', LIMIT, 0);
    allow('a', LIMIT, 0);
    expect(allow('b', LIMIT, 0)).toBe(true);
  });
});

describe('crossSite', () => {
  it('refuses a browser request from another site', () => {
    expect(crossSite(req({ headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(true);
    expect(crossSite(req({ headers: { origin: 'https://evil.example' } }))).toBe(true);
  });

  it('accepts the page itself and server-to-server calls', () => {
    expect(crossSite(req({ headers: { 'sec-fetch-site': 'same-origin' } }))).toBe(false);
    expect(crossSite(req({ headers: { origin: 'https://seal.example' } }))).toBe(false);
    expect(crossSite(req())).toBe(false);
  });
});

describe('guardedJson', () => {
  it('parses a well-formed request', async () => {
    const out = await guardedJson(req(), LIMIT, 't');
    expect(out).toEqual({ body: { token: '0x' } });
  });

  // A text/plain POST is what another site can send without a preflight.
  it('refuses anything but JSON', async () => {
    const out = await guardedJson(req({ headers: { 'content-type': 'text/plain' } }), LIMIT, 't');
    expect('response' in out && out.response.status).toBe(415);
  });

  it('refuses an oversized body even without content-length', async () => {
    const out = await guardedJson(req({ body: `"${'x'.repeat(MAX_BODY_BYTES)}"` }), LIMIT, 't');
    expect('response' in out && out.response.status).toBe(413);
  });

  it('answers 429 with Retry-After past the limit', async () => {
    await guardedJson(req(), LIMIT, 't');
    await guardedJson(req(), LIMIT, 't');
    const out = await guardedJson(req(), LIMIT, 't');
    expect('response' in out && out.response.status).toBe(429);
    expect('response' in out && out.response.headers.get('retry-after')).toBe('60');
  });

  it('refuses a cross-site request before counting it', async () => {
    const out = await guardedJson(req({ headers: { origin: 'https://evil.example' } }), LIMIT, 't');
    expect('response' in out && out.response.status).toBe(403);
  });
});

describe('clé de limitation par appelant', () => {
  const req = (headers: Record<string, string>) =>
    new Request('https://sealauth.dev/api/analyze', { method: 'POST', headers });

  it('préfère l’en-tête posé par Vercel à x-forwarded-for', () => {
    expect(
      clientKey(req({ 'x-vercel-forwarded-for': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' })),
    ).toBe('1.2.3.4');
    expect(clientKey(req({ 'x-real-ip': '5.6.7.8', 'x-forwarded-for': '9.9.9.9' }))).toBe(
      '5.6.7.8',
    );
  });

  it('regroupe une adresse IPv6 par /64', () => {
    expect(bucketOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(bucketOf('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(bucketOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(bucketOf('1.2.3.4')).toBe('1.2.3.4');
  });

  it('range les appels sans adresse dans un seul seau', () => {
    expect(clientKey(req({}))).toBe('unknown');
  });
});

describe('corps sans longueur honnête', () => {
  it('refuse un corps trop gros même sans content-length', async () => {
    const big = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"token":"${'a'.repeat(10_000)}"}`));
        controller.close();
      },
    });
    const request = new Request('https://sealauth.dev/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '7.7.7.7' },
      body: big,
      duplex: 'half',
    } as RequestInit);
    const result = await guardedJson(request, { capacity: 10, perMinute: 10 }, 'test');
    expect('response' in result && result.response.status).toBe(413);
  });
});
