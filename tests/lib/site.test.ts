import { describe, expect, it } from 'vitest';
import { siteUrl } from '@/lib/site';

describe('siteUrl', () => {
  it('uses the configured domain first', () => {
    expect(
      siteUrl({
        NEXT_PUBLIC_SITE_URL: 'https://seal.example',
        VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app',
      }).href,
    ).toBe('https://seal.example/');
  });

  it("falls back to Vercel's production domain, then localhost", () => {
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }).href).toBe(
      'https://x.vercel.app/',
    );
    expect(siteUrl({}).href).toBe('http://localhost:3000/');
  });

  it('ignores a malformed value', () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: 'not a url' }).href).toBe('http://localhost:3000/');
  });
});
