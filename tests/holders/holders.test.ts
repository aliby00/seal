import { afterEach, describe, expect, it, vi } from 'vitest';
import page from './fixtures/holders-page.json' with { type: 'json' };
import {
  classifyHolder,
  computeDistribution,
  fetchHolderDistribution,
  holdersUrl,
  type BlockscoutHolder,
} from '../../src/lib/holders';
import { IncompleteDataError } from '../../src/lib/errors';

const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';
const POOL = '0x668942551AffD4Ee3a2E570366aaEF28b56c3A97';
const at = () => new Date('2026-09-25T00:00:00.000Z');

afterEach(() => vi.unstubAllGlobals());

describe('holdersUrl', () => {
  it("vise l'API PRO avec le chain id 4663", () => {
    expect(holdersUrl(TOKEN)).toBe(
      `https://api.blockscout.com/4663/api/v2/tokens/${TOKEN}/holders`,
    );
  });

  it('reporte les paramètres de pagination', () => {
    expect(holdersUrl(TOKEN, { items_count: 50, value: '123' })).toContain('items_count=50');
  });
});

describe('classifyHolder', () => {
  it('reconnaît le pool', () => {
    expect(classifyHolder(POOL, true, POOL)).toBe('pool');
  });

  it('reconnaît les adresses de burn, quelle que soit la casse', () => {
    expect(classifyHolder('0x000000000000000000000000000000000000dEaD', false)).toBe('burn');
    expect(classifyHolder('0x0000000000000000000000000000000000000000', false)).toBe('burn');
  });

  it("distingue un contrat d'un wallet", () => {
    expect(classifyHolder('0xabc', true)).toBe('contract');
    expect(classifyHolder('0xabc', false)).toBe('wallet');
  });
});

describe('computeDistribution', () => {
  const data = computeDistribution(TOKEN, page.items as BlockscoutHolder[], {
    poolAddress: POOL,
  });

  // Sans cette exclusion, le pool ressortirait à 60 % et la concentration
  // mesurerait la liquidité au lieu de la position d'un acteur.
  it('exclut le pool du calcul des parts', () => {
    const pool = data.top.find((h) => h.kind === 'pool');
    expect(pool?.share).toBe(0);
  });

  it('exclut les adresses de burn', () => {
    expect(data.top.find((h) => h.kind === 'burn')?.share).toBe(0);
  });

  it("calcule les parts sur l'offre hors pool et hors burn", () => {
    // 160 + 120 + 80 = 360 M en circulation ; le plus gros en détient 160/360.
    expect(data.concentration.top1).toBeCloseTo(0.4444, 3);
  });

  it('somme le top 10 sans compter le pool ni le burn', () => {
    expect(data.concentration.top10).toBeCloseTo(1, 3);
  });

  it('classe les détenteurs par part décroissante', () => {
    const shares = data.top.map((h) => h.share);
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
  });

  it('ignore une entrée sans adresse plutôt que de planter', () => {
    const out = computeDistribution(TOKEN, [{ value: '100' }] as BlockscoutHolder[]);
    expect(out.top).toHaveLength(0);
  });

  it('ne divise pas par zéro sur une liste vide', () => {
    const out = computeDistribution(TOKEN, []);
    expect(out.concentration).toEqual({ top1: 0, top10: 0 });
  });
});

describe('fetchHolderDistribution', () => {
  // Le brief veut qu'un échec partiel n'empêche pas l'analyse : c'est à l'agent
  // de signaler la source manquante, pas au pipeline de renoncer.
  it('sans clé, renvoie unavailable au lieu de lever', async () => {
    const result = await fetchHolderDistribution(TOKEN, { now: at });
    expect(result.completeness).toBe('unavailable');
    expect(result.sources[0]?.note).toMatch(/402/);
  });

  it('avec clé, construit la distribution', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(page), { status: 200 }));
    const result = await fetchHolderDistribution(TOKEN, {
      apiKey: 'test',
      poolAddress: POOL,
      now: at,
    });
    expect(result.completeness).toBe('full');
    expect(result.data.concentration.top1).toBeCloseTo(0.4444, 3);
  });

  it('signale partial quand la pagination est coupée au plafond', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ items: page.items, next_page_params: { items_count: 50 } }), {
          status: 200,
        }),
    );
    const result = await fetchHolderDistribution(TOKEN, {
      apiKey: 'test',
      maxPages: 2,
      now: at,
    });
    expect(result.completeness).toBe('partial');
    expect(result.sources[0]?.note).toMatch(/2 pages/);
  });

  it("lève si la réponse n'a pas le champ items", async () => {
    vi.stubGlobal('fetch', async () => new Response('{"oops":1}', { status: 200 }));
    await expect(fetchHolderDistribution(TOKEN, { apiKey: 'test' })).rejects.toBeInstanceOf(
      IncompleteDataError,
    );
  });
});
