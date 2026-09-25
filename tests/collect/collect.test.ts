import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect } from '../../src/lib/collect';
import { NotFoundError } from '../../src/lib/errors';

const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';
const at = () => new Date('2026-09-25T00:00:00.000Z');

afterEach(() => vi.unstubAllGlobals());

/** Réseau simulé : chaque hôte répond ce qu'on lui dit, ou casse. */
function stubNetwork(handlers: {
  rpc?: (method: string) => unknown | Error;
  dexscreener?: unknown | Error;
}) {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('robinhood.com')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
      const out = handlers.rpc?.(body.method);
      if (out instanceof Error) throw out;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: out ?? [] }), {
        status: 200,
      });
    }
    if (url.includes('dexscreener')) {
      if (handlers.dexscreener instanceof Error) throw handlers.dexscreener;
      return new Response(JSON.stringify(handlers.dexscreener ?? []), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

describe('collect', () => {
  it('refuse une adresse invalide sans appeler quoi que ce soit', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(collect('pas-une-adresse')).rejects.toBeInstanceOf(NotFoundError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('produit un rapport même quand toutes les sources échouent', async () => {
    stubNetwork({
      rpc: () => new Error('nœud injoignable'),
      dexscreener: new Error('API injoignable'),
    });
    const report = await collect(TOKEN, { now: at });
    expect(report.token).toBe(TOKEN);
    expect(report.completeness).toBe('partial');
    expect(report.creator.completeness).toBe('unavailable');
    expect(report.market.completeness).toBe('unavailable');
  });

  // Le point du brief : un échec partiel n'empêche pas l'analyse.
  it('garde le marché quand la chaîne échoue', async () => {
    stubNetwork({
      rpc: () => new Error('nœud injoignable'),
      dexscreener: [
        {
          pairAddress: '0xPOOL',
          priceUsd: '0.001',
          liquidity: { usd: 1000, quote: 0.5 },
        },
      ],
    });
    const report = await collect(TOKEN, { now: at });
    expect(report.market.completeness).toBe('full');
    expect(report.market.data.priceUsd).toBeCloseTo(0.001);
    expect(report.creator.completeness).toBe('unavailable');
  });

  it('explique dans la source pourquoi un bloc est indisponible', async () => {
    stubNetwork({ rpc: () => new Error('nœud injoignable'), dexscreener: [] });
    const report = await collect(TOKEN, { now: at });
    expect(report.creator.sources[0]?.note).toBeTruthy();
  });

  it("sans clé Blockscout, la source est unavailable et l'analyse continue", async () => {
    stubNetwork({ rpc: () => [], dexscreener: [] });
    const report = await collect(TOKEN, { now: at });
    expect(report.holders.completeness).toBe('unavailable');
    expect(report.holders.sources[0]?.note).toMatch(/402/);
  });

  it('horodate le rapport une seule fois', async () => {
    stubNetwork({ rpc: () => [], dexscreener: [] });
    const report = await collect(TOKEN, { now: at });
    expect(report.collectedAt).toBe('2026-09-25T00:00:00.000Z');
  });
});
