import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ext } from './ext';

type Manifest = {
  description: string;
  host_permissions: string[];
  content_scripts: { matches: string[] }[];
};

const manifest = JSON.parse(
  readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'),
) as Manifest;

describe('extension manifest', () => {
  it('runs on the Solana sites the detector reads, and asks for nothing else', () => {
    const matches = manifest.content_scripts[0]!.matches;
    expect(matches).toEqual([
      'https://dexscreener.com/solana*',
      'https://solscan.io/*',
      'https://explorer.solana.com/*',
      'https://pump.fun/*',
      'https://www.pump.fun/*',
    ]);
    expect(manifest.host_permissions).toEqual(['https://sealauth.dev/*', ...matches]);
    for (const site of ext.config.SITES) {
      expect(matches.some((m) => m.includes(`//${site.host}/`))).toBe(true);
    }
  });

  it('names Solana, and no other chain', () => {
    const text = JSON.stringify(manifest);
    expect(manifest.description).toMatch(/Solana/);
    expect(text).not.toMatch(/robinhood|blockscout|\bpons\b/i);
  });
});
