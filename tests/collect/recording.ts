import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { CollectTimeouts } from '../../src/lib/collect';
import type { TokenReport } from '../../src/lib/contracts';
import type { RecordedCall } from '../../src/lib/solana/rpc';

/**
 * A whole collection recorded on mainnet: every Solana call `collect` made
 * (createSolanaRpc({ record })), every DexScreener answer it read, the clock
 * it ran at, and the report it produced. Replayed through the fake node and a
 * fake `fetch`, `collect` must produce the same report without the network.
 */
export type CollectRecording = {
  slug: string;
  mint: string;
  /** ISO time the collection ran at: the replay runs at the same clock. */
  now: string;
  /** The Solana node it was read from, by label (never its URL). */
  node: string;
  rpc: RecordedCall[];
  dex: { url: string; status: number; body: unknown }[];
  report: TokenReport;
};

export const COLLECT_FIXTURES = fileURLToPath(
  new URL('../fixtures/solana/collect/', import.meta.url),
);

/** The three reference tokens of the end-to-end collection (tests/fixtures/solana/REFERENCE.md). */
export const COLLECT_TOKENS = [
  { slug: 'pump-creator-sold', mint: 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump' },
  { slug: 'meteora-dbc', mint: '8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx' },
  { slug: 'pyusd', mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' },
] as const;

/**
 * Long enough that no reader stops for time, recording or replaying: only
 * the call caps end a read, and they do not depend on the node's speed.
 */
export const NO_TIME_LIMIT = 10 * 60_000;
export const LONG_TIMEOUTS: CollectTimeouts = {
  mint: NO_TIME_LIMIT,
  market: NO_TIME_LIMIT,
  creator: NO_TIME_LIMIT,
  creatorReads: NO_TIME_LIMIT,
  holders: NO_TIME_LIMIT,
  launch: NO_TIME_LIMIT,
};
/** Above any call the collection makes: the readers' own caps decide, never the global one. */
export const RECORDING_MAX_CALLS = 5_000;

export function loadCollectRecording(slug: string): CollectRecording {
  const raw = readFileSync(join(COLLECT_FIXTURES, `${slug}.json.gz`));
  return JSON.parse(gunzipSync(raw).toString('utf8')) as CollectRecording;
}

/** A `fetch` answering DexScreener's URLs from a recording; any other URL is refused. */
export function dexFetch(recording: Pick<CollectRecording, 'dex'>): typeof fetch {
  const byUrl = new Map(recording.dex.map((d) => [d.url, d]));
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hit = byUrl.get(url);
    if (!hit) throw new Error(`no recorded answer for ${url}`);
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
