import { describe, expect, it, vi, afterEach } from 'vitest';
import livePair from './fixtures/pair-live.json' with { type: 'json' };
import {
  fetchMarketState,
  pickPrimaryPair,
  toMarketState,
  tokenPairsUrl,
  volumePerTrade,
  type DexScreenerPair,
} from '../../src/lib/market';
import { UpstreamError } from '../../src/lib/errors';

const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';
const at = () => new Date('2026-09-25T00:00:00.000Z');

afterEach(() => vi.unstubAllGlobals());

describe('tokenPairsUrl', () => {
  it('utilise le slug robinhood, le seul qui réponde', () => {
    expect(tokenPairsUrl(TOKEN)).toBe(
      `https://api.dexscreener.com/token-pairs/v1/robinhood/${TOKEN}`,
    );
  });
});

describe('toMarketState sur la réponse réelle', () => {
  const state = toMarketState(TOKEN, livePair as DexScreenerPair[], { now: at });

  it('extrait prix, liquidité et paire', () => {
    expect(state.completeness).toBe('full');
    expect(state.data.pair).toBe('0x668942551AffD4Ee3a2E570366aaEF28b56c3A97');
    expect(state.data.priceUsd).toBeCloseTo(0.000003654);
    expect(state.data.liquidityUsd).toBeCloseTo(3654.24);
  });

  // Le recoupement vérifié dans RESEARCH.md : liquidity.quote == pairedPrincipal on-chain.
  it('reprend liquidity.quote comme ETH immobilisé', () => {
    expect(state.data.pairedEth).toBeCloseTo(0.002235);
  });

  it('convertit pairCreatedAt en ISO', () => {
    expect(state.data.pairCreatedAt).toBe('2026-09-24T22:08:22.000Z');
  });

  it('compte les transactions par fenêtre', () => {
    expect(state.data.txns?.h24).toEqual({ buys: 4, sells: 3 });
  });
});

describe('graduation', () => {
  it('calcule la progression vers le seuil', () => {
    const state = toMarketState(TOKEN, livePair as DexScreenerPair[], {
      now: at,
      graduation: { thresholdEth: 4.2, pairedEth: 0.002235, graduated: false },
    });
    expect(state.data.graduation?.progress).toBeCloseTo(0.000532, 5);
    expect(state.data.graduation?.graduated).toBe(false);
  });

  // Un pool au-delà du seuil resterait à 100 %, pas à 137 %.
  it('borne la progression à 1', () => {
    const state = toMarketState(TOKEN, livePair as DexScreenerPair[], {
      now: at,
      graduation: { thresholdEth: 4.2, pairedEth: 5.8, graduated: true },
    });
    expect(state.data.graduation?.progress).toBe(1);
  });

  it("reste null si la chaîne n'a pas fourni l'information", () => {
    const state = toMarketState(TOKEN, livePair as DexScreenerPair[], { now: at });
    expect(state.data.graduation).toBeNull();
  });
});

describe('token sans paire indexée', () => {
  const state = toMarketState(TOKEN, [], { now: at });

  // C'est l'état normal d'un token de quelques minutes, pas une erreur.
  it('est unavailable, pas une exception', () => {
    expect(state.completeness).toBe('unavailable');
    expect(state.data.pair).toBeNull();
  });

  it('explique pourquoi dans la source', () => {
    expect(state.sources[0]?.note).toMatch(/trop récent/);
  });
});

describe('pickPrimaryPair', () => {
  it('retient la paire la plus liquide', () => {
    const pairs: DexScreenerPair[] = [
      { pairAddress: '0xA', liquidity: { usd: 100 } },
      { pairAddress: '0xB', liquidity: { usd: 9000 } },
      { pairAddress: '0xC', liquidity: { usd: 42 } },
    ];
    expect(pickPrimaryPair(pairs)?.pairAddress).toBe('0xB');
  });

  it('ne modifie pas le tableau reçu', () => {
    const pairs: DexScreenerPair[] = [
      { pairAddress: '0xA', liquidity: { usd: 1 } },
      { pairAddress: '0xB', liquidity: { usd: 2 } },
    ];
    pickPrimaryPair(pairs);
    expect(pairs[0]?.pairAddress).toBe('0xA');
  });
});

describe('volumePerTrade', () => {
  it('donne le volume moyen par échange', () => {
    const state = toMarketState(TOKEN, livePair as DexScreenerPair[], { now: at });
    // 485,73 $ pour 7 échanges : le genre de chiffre que l'agent doit voir.
    expect(volumePerTrade(state)).toBeCloseTo(69.39, 1);
  });

  it('renvoie null plutôt que de diviser par zéro', () => {
    const state = toMarketState(
      TOKEN,
      [{ pairAddress: '0xA', volume: { h24: 500 }, txns: { h24: { buys: 0, sells: 0 } } }],
      { now: at },
    );
    expect(volumePerTrade(state)).toBeNull();
  });
});

describe('fetchMarketState', () => {
  it("rejette une réponse qui n'est pas un tableau", async () => {
    vi.stubGlobal('fetch', async () => new Response('{"oops":true}', { status: 200 }));
    await expect(fetchMarketState(TOKEN)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("construit l'état depuis une réponse valide", async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(livePair), { status: 200 }));
    const state = await fetchMarketState(TOKEN, { now: at });
    expect(state.data.priceUsd).toBeCloseTo(0.000003654);
  });
});
