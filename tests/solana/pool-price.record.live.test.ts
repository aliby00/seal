import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchSolanaPairs, pickSolanaPair } from '../../src/lib/market/solana';
import { forgetPoolShapes, readPoolPrice } from '../../src/lib/solana/pool-price';
import { createSolanaRpc, type RecordedCall } from '../../src/lib/solana/rpc';
import { SOLANA_FIXTURES } from './fixtures';
import { LIVE_PRICE_TOKENS, type LivePriceCase } from './live-price-tokens';

/**
 * Records the pool reads of the live price on mainnet:
 * `SEAL_RECORD=1 pnpm vitest run tests/solana/pool-price.record.live.test.ts`.
 * Skipped otherwise: no other test reaches the network. Each token's calls go
 * to tests/fixtures/solana/live-price/<slug>.json, and what DexScreener said
 * in the same second to cases.json, the independent figure the tests compare
 * the chain's price with.
 */
const RECORD = process.env.SEAL_RECORD === '1';
const DIR = join(SOLANA_FIXTURES, 'live-price');

describe.skipIf(!RECORD)('record the live price reads on mainnet', () => {
  it('records every token', async () => {
    const cases: LivePriceCase[] = [];
    for (const { slug, mint } of LIVE_PRICE_TOKENS) {
      const pair = pickSolanaPair(mint, await fetchSolanaPairs(mint));
      expect(pair?.pairAddress).toBeTruthy();
      const pool = pair!.pairAddress!;
      const calls: RecordedCall[] = [];
      const rpc = createSolanaRpc({ maxCalls: 4, record: (entry) => calls.push(entry) });
      forgetPoolShapes();
      const now = new Date();
      const read = await readPoolPrice(rpc, mint, pool);
      mkdirSync(DIR, { recursive: true });
      writeFileSync(join(DIR, `${slug}.json`), `${JSON.stringify(calls, null, 1)}\n`);
      cases.push({
        slug,
        mint,
        pool,
        dex: pair!.dexId ?? '',
        now: now.toISOString(),
        kind: read?.kind ?? null,
        dexscreener: {
          priceUsd: Number(pair!.priceUsd ?? NaN),
          priceNative: Number(pair!.priceNative ?? NaN),
          liquidityUsd: pair!.liquidity?.usd ?? null,
          marketCapUsd: pair!.marketCap ?? null,
        },
      });
    }
    writeFileSync(join(DIR, 'cases.json'), `${JSON.stringify(cases, null, 1)}\n`);
  }, 120_000);
});
