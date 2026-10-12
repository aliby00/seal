import { describe, expect, it } from 'vitest';
import {
  MarketIndex,
  NATIVE,
  WETH,
  decodeInitialize,
  tokenSide,
  type V4Market,
} from '../../src/lib/chain/pools';
import { MARKETS, REUSED_HOOK } from '../specialists/helpers';
import initialize from './fixtures/initialize.json';

describe('decodeInitialize — log réel du PoolManager', () => {
  const market = decodeInitialize(initialize);

  it('lit le hook dans les données, pas dans les topics', () => {
    expect(market.hook).toBe('0x99a670d2103e1e4ebd53a483f725dd651a08eae0');
  });

  it('lit les deux monnaies indexées et les paramètres du pool', () => {
    expect(market.currency0).toBe('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
    expect(market.currency1).toBe('0x9b578c02d32c81b654e3118075e60290857fde18');
    expect(market.fee).toBe(0);
    expect(market.tickSpacing).toBe(1);
    expect(market.blockNumber).toBe(0x521ba50);
  });
});

describe('tokenSide', () => {
  const base: V4Market = {
    id: '0x1',
    currency0: NATIVE,
    currency1: '0x00000000000000000000000000000000000000aa',
    fee: 0,
    tickSpacing: 1,
    hook: NATIVE,
    blockNumber: 1,
    transactionHash: '0x',
  };

  it('ignore la monnaie native', () => {
    expect(tokenSide(base)).toBe(base.currency1);
  });

  // Régression réelle : sans WETH dans les monnaies de cotation, dix marchés
  // sur 167 étaient indexés comme si leur token était WETH.
  it('ignore WETH quand il est currency0', () => {
    const quoted = {
      ...base,
      currency0: WETH,
      currency1: '0xd58387abfe21c72203cbed48e4409bbb34571326',
    };
    expect(tokenSide(quoted)).toBe('0xd58387abfe21c72203cbed48e4409bbb34571326');
  });
});

describe('MarketIndex', () => {
  const index = new MarketIndex(MARKETS);

  it('regroupe les marchés par rulebook', () => {
    expect(index.onHook(REUSED_HOOK)).toHaveLength(11);
    expect(index.topHooks(1)[0]).toEqual({ hook: REUSED_HOOK, markets: 11 });
  });

  it("ne compte pas l'absence de hook comme un rulebook partagé", () => {
    expect(index.topHooks(50).map((h) => h.hook)).not.toContain(NATIVE);
  });

  it('retrouve les marchés d’un token, y compris plusieurs pools', () => {
    expect(index.ofToken('0x12F190A9F9D7D37A250758B26824B97CE941BF54')).toHaveLength(3);
  });

  it('ignore un marché déjà indexé', () => {
    const copy = new MarketIndex(MARKETS);
    copy.add(MARKETS[0]!);
    expect(copy.size).toBe(MARKETS.length);
  });

  it('se sérialise et se recharge à l’identique', () => {
    const reloaded = MarketIndex.fromJSON(JSON.parse(JSON.stringify(index)));
    expect(reloaded.all()).toEqual(index.all());
  });
});
