import { afterEach, describe, expect, it } from 'vitest';
import type { CachedAnalysis } from '../../src/lib/analysis-cache';
import { cardCache, rememberCard, resetGlanceState } from '../../src/lib/glance-service';
import { setSharedRedis } from '../../src/lib/store';
import { GET } from '../../src/app/api/card/route';

/**
 * A shared reading shows its own card on X: the token and the first line of
 * its summary. Prod reports are often partial and never cached as answers, so
 * the card keeps the summary that was served, whatever its completeness.
 */

const TOKEN = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';

const analysis = (failed: boolean): CachedAnalysis =>
  ({
    token: TOKEN,
    name: 'Rubricat',
    symbol: 'RBCAT',
    explanation: '',
    completeness: failed ? 'partial' : 'full',
    sources: [],
    collectedAt: '2026-11-16T17:00:00.000Z',
    offline: true,
    facts: {
      creator: {
        measured: false,
        address: 'D234v6HgjNdTfS8vYa3ZfJAF5sSoTVzrKCDmQ2ypCnQK',
        launched: 0,
        detailed: 0,
        graduated: 0,
        abandoned: 0,
        undetermined: 0,
        active: 0,
        checked: 0,
        soldIntoPool: 0,
        liquidityPulled: 0,
        salesChecked: 0,
        liquidityChecked: 0,
        source: null,
        role: null,
        launchContract: null,
        launchesListed: false,
        transactionCount: null,
      },
      holders: { measured: false, holderCount: null, pooled: null, top1: 0, top10: 0, top: [] },
      market: {
        measured: true,
        priceUsd: 2.303e-10,
        liquidityUsd: 0.39,
        volume24hUsd: 1.93,
        buys24h: 1,
        sells24h: 1,
        fdvUsd: 23,
        graduation: null,
      },
    },
  }) as unknown as CachedAnalysis;

afterEach(() => {
  resetGlanceState();
  setSharedRedis(undefined);
});

describe('share card', () => {
  it('keeps the summary of a partial analysis for the card', async () => {
    setSharedRedis(null);
    await rememberCard(analysis(true));
    // The key is the address as given: Solana addresses are case-sensitive.
    const card = await cardCache.get(TOKEN);
    expect(card?.name).toBe('Rubricat');
    expect(card?.glance.headline).toMatch(/^Its market is all but empty: \$0\.39 of liquidity/);
  });

  it('refuses what is not a Solana address, an EVM one included', async () => {
    for (const token of ['0x12', '0xd58387ABfE21c72203CBED48E4409BBb34571326', 'bonjour']) {
      const response = await GET(new Request(`http://localhost/api/card?token=${token}`));
      expect(response.status).toBe(400);
    }
  });

  it('draws the card of a reading just served, cached for crawlers', async () => {
    setSharedRedis(null);
    await rememberCard(analysis(false));
    const response = await GET(new Request(`http://localhost/api/card?token=${TOKEN}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=180, s-maxage=180');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  });

  it('draws the flags the page opens on, when the reading has them', async () => {
    setSharedRedis(null);
    await rememberCard({
      ...analysis(false),
      flagInputs: {
        launchpad: 'pump.fun',
        livePowers: [],
        mintFreezeOff: true,
        dev: null,
        bundle: { wallets: 3, share: 0.419, heldNow: 0, where: 'creation slot' },
        snipers: null,
        noBundle: false,
        serial: null,
        noOtherLaunch: false,
        market: {
          mcap: 2000,
          liquidity: 11,
          onCurve: true,
          ratio: 0.0055,
          volume24h: 38_500,
          quietHours: null,
        },
        holders: null,
        lp: null,
        linkedBought: null,
        nameClone: null,
        freshWallet: null,
      },
    });
    const card = await cardCache.get(TOKEN);
    expect(card?.flags?.map((f) => f.label)).toEqual([
      'Bundle',
      'Chart dead',
      'Mint and freeze revoked',
    ]);
    const response = await GET(new Request(`http://localhost/api/card?token=${TOKEN}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('an empty card served to one caller past its limit is kept out of the shared cache', async () => {
    setSharedRedis(null);
    await rememberCard(analysis(false));
    const ask = () =>
      GET(
        new Request(`http://localhost/api/card?token=${TOKEN}`, {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
      );
    let response = await ask();
    for (let i = 0; i < 30 && response.headers.get('cache-control')?.startsWith('public'); i++) {
      response = await ask();
    }
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }, 60_000);
});
