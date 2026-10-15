/**
 * The site's public address, used for absolute URLs in the page metadata (the
 * share image, the canonical link). Set NEXT_PUBLIC_SITE_URL to the domain;
 * without it, Vercel's production domain, then localhost for development.
 * Nothing in the code names a deployment address, so a domain change is a
 * variable change.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): URL {
  const configured = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured);
    } catch {
      // A malformed value falls through to the next source rather than break the build.
    }
  }
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return new URL(`https://${vercel}`);
  return new URL('http://localhost:3000');
}
