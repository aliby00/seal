import { describe, expect, it, vi } from 'vitest';
import { ext } from './ext';
import { SAMPLE } from './sample';

const TOKEN = '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b';
const POOL = `0x${'7f'.repeat(32)}`;

function setup(responses: (() => Response)[] = [() => Response.json(SAMPLE)]) {
  let clock = 1_000_000;
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return next();
  });
  const client = ext.client.createClient({
    fetch,
    apiBase: () => 'https://sealauth.dev/',
    now: () => clock,
  });
  return { client, fetch, advance: (ms: number) => (clock += ms) };
}

describe('the glance client', () => {
  it('sends the address only, without credentials', async () => {
    const { client, fetch } = setup();
    const reply = await client.get({ kind: 'token', address: TOKEN });
    expect(reply.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://sealauth.dev/api/glance?token=${TOKEN}`);
    expect(init?.credentials).toBe('omit');
    expect(init?.method).toBe('GET');
  });

  it('asks for a DexScreener pair by its own parameter', async () => {
    const { client, fetch } = setup();
    await client.get({ kind: 'pair', address: POOL });
    expect(fetch.mock.calls[0]![0]).toBe(`https://sealauth.dev/api/glance?pair=${POOL}`);
  });

  it('keeps an answer five minutes, then asks again', async () => {
    const { client, fetch, advance } = setup();
    await client.get({ kind: 'token', address: TOKEN });
    advance(4 * 60_000);
    const again = await client.get({
      kind: 'token',
      address: TOKEN.toUpperCase().replace('0X', '0x'),
    });
    expect(again).toMatchObject({ ok: true, cached: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(61_000);
    await client.get({ kind: 'token', address: TOKEN });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('knows a pair’s answer under its token too', async () => {
    const { client, fetch } = setup();
    await client.get({ kind: 'pair', address: POOL });
    await client.get({ kind: 'token', address: SAMPLE.token });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends one request per token, however many ask at once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = vi.fn(async () => {
      await gate;
      return Response.json(SAMPLE);
    });
    const client = ext.client.createClient({ fetch, apiBase: () => 'https://sealauth.dev' });
    const asks = [1, 2, 3].map(() => client.get({ kind: 'token', address: TOKEN }));
    await vi.waitFor(() => expect(client.pending()).toBe(1));
    release();
    const replies = await Promise.all(asks);
    expect(replies.every((r) => r.ok)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.pending()).toBe(0);
  });

  it('backs off after a 429 for the time the server asks', async () => {
    const { client, fetch, advance } = setup([
      () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
      () => Response.json(SAMPLE),
    ]);
    const first = await client.get({ kind: 'token', address: TOKEN });
    expect(first).toMatchObject({ ok: false, status: 429 });
    const other = await client.get({ kind: 'token', address: `0x${'1'.repeat(40)}` });
    expect(other).toMatchObject({ ok: false, status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(31_000);
    expect((await client.get({ kind: 'token', address: TOKEN })).ok).toBe(true);
  });

  it('backs off a minute when the 429 says nothing', async () => {
    const { client, advance } = setup([() => new Response('{}', { status: 429 })]);
    await client.get({ kind: 'token', address: TOKEN });
    advance(59_000);
    expect((await client.get({ kind: 'token', address: TOKEN })).ok).toBe(false);
  });

  it('says failures in plain English and does not keep them', async () => {
    const { client, fetch } = setup([
      () => new Response('{}', { status: 502 }),
      () => new Response('{}', { status: 404 }),
      () => Response.json({ unexpected: true }),
    ]);
    const failed = await client.get({ kind: 'token', address: TOKEN });
    expect(failed).toEqual({
      ok: false,
      status: 502,
      message: 'SEAL could not read this token right now.',
    });
    const unknown = await client.get({ kind: 'token', address: TOKEN });
    expect(unknown.ok ? '' : unknown.message).toMatch(/found nothing/);
    const malformed = await client.get({ kind: 'token', address: TOKEN });
    expect(malformed.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('turns a network failure into the same message', async () => {
    const client = ext.client.createClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      apiBase: () => 'https://sealauth.dev',
    });
    expect(await client.get({ kind: 'token', address: TOKEN })).toEqual({
      ok: false,
      status: 0,
      message: 'SEAL could not read this token right now.',
    });
  });

  it('accepts only this machine as a development server', () => {
    const local = ext.config.LOCAL_API;
    expect(local.test('http://127.0.0.1:3100')).toBe(true);
    expect(local.test('http://localhost:3000')).toBe(true);
    expect(local.test('https://evil.example')).toBe(false);
    expect(local.test('http://127.0.0.1.evil.example')).toBe(false);
  });
});
