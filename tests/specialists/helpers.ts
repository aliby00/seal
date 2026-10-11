import type { TokenReport } from '../../src/lib/contracts';
import { MarketIndex, type IndexedMarket } from '../../src/lib/chain/pools';
import markets from './fixtures/markets.json';

/**
 * Les 17 marchés de `fixtures/markets.json` ont été relevés sur la chaîne le
 * 11/10/2026 (blocs 86 100 020 – 86 130 020), noms lus par `name()`/`symbol()`.
 * Onze partagent le rulebook 0x4e34…a544 ; « HOOD » a un rulebook upgradable.
 */
export const MARKETS = markets as IndexedMarket[];

export const REUSED_HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
/** Le hook du marché « HOOD » : un proxy EIP-1967, implémentation 0x3690…eb17. */
export const HOOD_HOOK = '0x4eb1976978756bd56802d8162f2271844924e0cc';
export const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54';
export const STOCK_BEACON = '0xe10b6f6b275de231345c20d14ab812db62151b00';

export function market(predicate: (m: IndexedMarket) => boolean): IndexedMarket {
  const found = MARKETS.find(predicate);
  if (!found) throw new Error('fixture market not found');
  return structuredClone(found);
}

export const freshIndex = (): MarketIndex => new MarketIndex(structuredClone(MARKETS));

const at = '2026-10-11T00:00:00.000Z';

/** Un rapport complet, à modifier cas par cas. */
export function makeReport(token: string, patch: (r: TokenReport) => void = () => {}): TokenReport {
  const report: TokenReport = {
    token,
    collectedAt: at,
    completeness: 'full',
    creator: {
      completeness: 'full',
      sources: [{ name: 'robinhood-rpc', fetchedAt: at }],
      data: {
        creator: '0xe06289fde414ee521aba50db0cf0a60816faa523',
        tokens: [],
        counts: {
          launched: 1,
          graduated: 0,
          abandoned: 0,
          undetermined: 0,
          liquidityPulled: 0,
          creatorDumped: 0,
        },
        scannedRange: { fromBlock: 0, toBlock: 86_130_020 },
      },
    },
    holders: {
      completeness: 'full',
      sources: [{ name: 'blockscout', fetchedAt: at }],
      data: {
        token,
        countedSupply: '1000',
        holderCount: 120,
        top: [],
        concentration: { top1: 0.04, top10: 0.18 },
        distinctTraders: 60,
      },
    },
    market: {
      completeness: 'full',
      sources: [{ name: 'dexscreener', fetchedAt: at }],
      data: {
        token,
        pair: null,
        priceUsd: 0.01,
        liquidityUsd: 5000,
        pairedEth: 1,
        graduation: null,
        volumeUsd: { m5: 0, h1: 100, h6: 400, h24: 1000 },
        txns: { h1: { buys: 5, sells: 4 }, h24: { buys: 40, sells: 30 } },
        fdvUsd: 10000,
        pairCreatedAt: at,
      },
    },
  };
  patch(report);
  return report;
}
