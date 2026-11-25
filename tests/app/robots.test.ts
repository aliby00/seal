import { afterEach, describe, expect, it, vi } from 'vitest';
import robots, { dynamic } from '../../src/app/robots';

afterEach(() => vi.unstubAllEnvs());

describe('robots.txt', () => {
  it('lets search engines read production, the API aside, with its sitemap', () => {
    vi.stubEnv('SEAL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://sealauth.dev');
    expect(robots()).toEqual({
      rules: { userAgent: '*', allow: '/', disallow: '/api/' },
      sitemap: 'https://sealauth.dev/sitemap.xml',
    });
  });

  it.each(['staging', 'development', undefined])(
    'keeps every page of %s out of search engines, without a sitemap',
    (env) => {
      vi.stubEnv('SEAL_ENV', env as string);
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://seal-staging.vercel.app');
      const rules = robots();
      expect(rules).toEqual({ rules: { userAgent: '*', disallow: '/' } });
      expect(rules.sitemap).toBeUndefined();
    },
  );

  it('is read when asked, from the environment the site runs in', () => {
    expect(dynamic).toBe('force-dynamic');
  });
});
