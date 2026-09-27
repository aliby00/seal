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

describe("résolution du créateur depuis l'adresse du token", () => {
  const TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
  const DEPLOYER = '0xe06289fde414ee521aba50db0cf0a60816faa523';
  const DATA =
    '0x0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73' +
    '000000000000000000000000668942551affd4ee3a2e570366aaef28b56c3a97' +
    '0000000000000000000000000000000000000000000000000000000000000000'.repeat(4) +
    '00000000000000000000000000000000000000000000000000005af3107a4000';

  function launchLog(token: string) {
    return {
      address: '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75',
      topics: [
        TOPIC,
        `0x000000000000000000000000${token.slice(2)}`,
        `0x000000000000000000000000${DEPLOYER.slice(2)}`,
        '0x0000000000000000000000001f7d7550b1b028f7571e69a784071f0205fd2efa',
      ],
      data: DATA,
      blockNumber: '0x1000',
      transactionHash: '0xabc',
      logIndex: '0x0',
    };
  }

  // Le bug corrigé : on filtrait TokenLaunched sur l'adresse du TOKEN comme si
  // c'était celle du DEPLOYER, ce qui ne renvoyait évidemment jamais rien.
  it("interroge l'historique avec le deployer, pas avec le token", async () => {
    const topicsSeen: unknown[][] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('robinhood.com')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          method: string;
          params: [{ topics?: unknown[] }];
        };
        if (body.method === 'eth_blockNumber') {
          return new Response(JSON.stringify({ result: '0x1100' }), { status: 200 });
        }
        if (body.method === 'eth_getLogs') {
          topicsSeen.push(body.params[0].topics ?? []);
          return new Response(JSON.stringify({ result: [launchLog(TOKEN)] }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: '0x' }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });

    const report = await collect(TOKEN, { now: at });

    const padded = (a: string) => `0x000000000000000000000000${a.slice(2)}`;
    const filters = topicsSeen.map((t) => JSON.stringify(t));
    // Une requête cherche le lancement du token…
    expect(filters.some((f) => f.includes(padded(TOKEN)))).toBe(true);
    // …et une autre l'historique du deployer qu'on en a tiré.
    expect(filters.some((f) => f.includes(padded(DEPLOYER)))).toBe(true);
    expect(report.creator.data.creator.toLowerCase()).toBe(DEPLOYER);
  });

  it('le signale proprement si le lancement est introuvable', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('robinhood.com')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
        if (body.method === 'eth_blockNumber') {
          return new Response(JSON.stringify({ result: '0x1100' }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: [] }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    const report = await collect(TOKEN, { now: at });
    expect(report.creator.completeness).toBe('unavailable');
    expect(report.creator.sources[0]?.note).toMatch(/not found/);
  });
});
