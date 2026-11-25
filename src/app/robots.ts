import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

// Read at request time, from SEAL_ENV as the running site sees it (the value
// /api/health reports and the smoke tests check), not frozen at build.
export const dynamic = 'force-dynamic';

/**
 * Production is open to search engines, the API aside. Staging and local
 * runs are not: a copy of the site indexed under another address would
 * compete with the real one.
 */
export default function robots(): MetadataRoute.Robots {
  if (process.env.SEAL_ENV !== 'production') {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: new URL('/sitemap.xml', siteUrl()).toString(),
  };
}
