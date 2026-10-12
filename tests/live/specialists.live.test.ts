import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readTokenMetas } from '../../src/lib/chain/facts';
import { MarketIndex, scanMarkets, tokenSide } from '../../src/lib/chain/pools';
import { createRpcClient } from '../../src/lib/chain/rpc';
import { compileAgent, gatherContext, runAgent } from '../../src/lib/specialists';

/**
 * Contre la vraie chaîne. Ne tourne qu'avec SEAL_LIVE=1 — jamais en CI, où le
 * RPC public coupe vite et où un test ne doit pas dépendre du réseau.
 *
 *   SEAL_LIVE=1 SEAL_LIVE_OUT=/tmp/index.json npx vitest run tests/live
 */
const live = process.env.SEAL_LIVE === '1';

describe.skipIf(!live)('spécialistes sur la chaîne', () => {
  it(
    'indexe les marchés récents et fait tourner les dix spécialistes',
    { timeout: 120_000 },
    async () => {
      const rpc = createRpcClient();
      const latest = Number(await rpc.call<string>('eth_blockNumber', []));
      const { markets, scanned } = await scanMarkets(rpc, {
        fromBlock: latest - 30_000,
        toBlock: latest,
      });
      const tokens = markets.map((m) => tokenSide(m));
      const metas = await readTokenMetas(rpc, tokens);
      const index = new MarketIndex(
        markets.map((m, i) => {
          const token = tokens[i] as string;
          return { ...m, token, ...(metas.get(token) ?? {}) };
        }),
      );
      console.log(`marchés: ${index.size} sur les blocs ${scanned.fromBlock}–${scanned.toBlock}`);
      console.log('rulebooks les plus réutilisés:', index.topHooks(5));
      if (process.env.SEAL_LIVE_OUT) {
        writeFileSync(process.env.SEAL_LIVE_OUT, JSON.stringify(index.toJSON(), null, 1));
      }
      expect(index.size).toBeGreaterThan(0);

      const busiest = index.topHooks(1)[0];
      const sample = busiest ? index.onHook(busiest.hook).at(-1) : index.all().at(-1);
      expect(sample).toBeDefined();

      const agent = compileAgent({
        name: 'live check',
        specialists: [
          'code-reuse',
          'wallet-age',
          'funding-trace',
          'name-clone',
          'holder-spread',
          'creator-history',
          'sell-path',
          'volume-reality',
          'liquidity-move',
          'rule-change',
        ],
      });
      const context = await gatherContext(rpc, sample!.token, undefined, index);
      const { findings } = runAgent(agent, context);
      for (const f of findings) console.log(f.specialist, f.signal, f.facts, f.limits);
      expect(findings).toHaveLength(10);

      // Les noms qui empruntent « Robinhood » : vrais tokens actions et usurpations.
      const borrowed = index.all().filter((m) => /hood/i.test(`${m.name} ${m.symbol}`));
      const nameOnly = compileAgent({ name: 'names', specialists: ['name-clone'] });
      for (const m of borrowed.slice(0, 6)) {
        const ctx = await gatherContext(rpc, m.token, undefined, index);
        const [f] = runAgent(nameOnly, ctx).findings;
        console.log(m.token, f?.signal, f?.facts.join(' '));
      }
    },
  );
});
