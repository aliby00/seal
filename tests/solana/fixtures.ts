import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSolanaRpc, type FakeSolanaRpc } from '../../src/lib/solana/fake-rpc';
import type { RecordedCall } from '../../src/lib/solana/rpc';

/** tests/fixtures/solana: one folder per zone, recorded answers of mainnet. */
export const SOLANA_FIXTURES = fileURLToPath(new URL('../fixtures/solana/', import.meta.url));

/**
 * The recordings of a zone: every `*.json` of `tests/fixtures/solana/<zone>/`,
 * or only the files named. A file holds one entry or an array of entries.
 */
export function loadRecordings(zone: string, files?: readonly string[]): RecordedCall[] {
  const dir = join(SOLANA_FIXTURES, zone);
  const names = files ?? readdirSync(dir).filter((name) => name.endsWith('.json'));
  return names.flatMap((name) => {
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as
      RecordedCall | RecordedCall[];
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

/** A fake node answering from a zone's recordings. */
export function fakeRpcFor(zone: string, files?: readonly string[]): FakeSolanaRpc {
  return createFakeSolanaRpc(loadRecordings(zone, files));
}
