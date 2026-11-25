import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { collect } from '../../src/lib/collect';
import { recordingKey } from '../../src/lib/solana/fake-rpc';
import {
  createSolanaRpc,
  solanaRpcFrom,
  solanaRpcNodes,
  type RecordedCall,
} from '../../src/lib/solana/rpc';
import {
  COLLECT_FIXTURES,
  COLLECT_TOKENS,
  LONG_TIMEOUTS,
  NO_TIME_LIMIT,
  RECORDING_MAX_CALLS,
  type CollectRecording,
} from './recording';

/**
 * Records the end-to-end fixtures on mainnet: `SEAL_RECORD=1 pnpm vitest run
 * tests/collect/record.live.test.ts`. Skipped otherwise: no other test
 * reaches the network. Each token's calls and DexScreener answers go to
 * tests/fixtures/solana/collect/<slug>.json.gz with the report they gave.
 */
const RECORD = process.env.SEAL_RECORD === '1';

describe.skipIf(!RECORD)('record a collection on mainnet', () => {
  for (const { slug, mint } of COLLECT_TOKENS) {
    it(
      slug,
      async () => {
        const now = new Date();
        const rpcCalls: RecordedCall[] = [];
        const dex: CollectRecording['dex'] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const response = await realFetch(input, init);
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (new URL(url).hostname === 'api.dexscreener.com') {
            const body: unknown = await response
              .clone()
              .json()
              .catch(() => null);
            dex.push({ url, status: response.status, body });
          }
          return response;
        }) as typeof fetch;
        try {
          const node = createSolanaRpc({
            maxCalls: RECORDING_MAX_CALLS,
            // The public node refuses bursts of one method for 10 s: a
            // recording goes slowly, and is not refused.
            rate: () => 1,
            record: (entry) => rpcCalls.push(entry),
          });
          // Each call waits its turn, SEAL_RECORD_GAP_MS apart (1 s by default).
          // A call asked again (two readers paging the same busy history) gets
          // the first answer: the recording is one snapshot of the chain, and
          // its replay does not depend on which reader asked first.
          const gap = Number(process.env.SEAL_RECORD_GAP_MS) || 1_000;
          let turn = Promise.resolve();
          const asked = new Map<string, Promise<unknown>>();
          const rpc = solanaRpcFrom(
            <T>(method: string, params: readonly unknown[], signal?: AbortSignal) => {
              const key = recordingKey(method, params);
              const known = asked.get(key);
              if (known) return known as Promise<T>;
              const mine = turn.then(() => new Promise<void>((r) => setTimeout(r, gap)));
              turn = mine;
              const answer = mine.then(() => node.call<T>(method, params, signal));
              asked.set(key, answer);
              answer.catch(() => asked.delete(key));
              return answer;
            },
          );
          const report = await collect(mint, {
            rpc,
            now: () => now,
            deadlineMs: NO_TIME_LIMIT,
            timeouts: LONG_TIMEOUTS,
          });
          const recording: CollectRecording = {
            slug,
            mint,
            now: now.toISOString(),
            node: solanaRpcNodes()[0]?.label ?? 'public',
            rpc: rpcCalls,
            dex,
            report: JSON.parse(JSON.stringify(report)) as CollectRecording['report'],
          };
          mkdirSync(COLLECT_FIXTURES, { recursive: true });
          writeFileSync(
            join(COLLECT_FIXTURES, `${slug}.json.gz`),
            gzipSync(JSON.stringify(recording), { level: 9 }),
          );
          // A read cut by the node's rate or by time would be replayed as that
          // failure: record again. (A method the public node does not serve is
          // a fact of that node, and stays.)
          const flaky = (report.failedReads ?? []).filter((f) =>
            /rate-limit|request limit|timed out|time cap|time allowance/i.test(f.note),
          );
          expect(flaky).toEqual([]);
        } finally {
          globalThis.fetch = realFetch;
        }
      },
      NO_TIME_LIMIT,
    );
  }
});
