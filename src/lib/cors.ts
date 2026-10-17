/**
 * Cross-origin access for the browser extension's endpoint. A wildcard such
 * as `chrome-extension://*` is not a valid Access-Control-Allow-Origin value:
 * the request's own Origin is echoed back, and only when it is an extension
 * or the site itself. No credentials are ever allowed.
 */

const SITE_ORIGINS = new Set(['https://sealauth.dev', 'https://www.sealauth.dev']);
const EXTENSION_ORIGIN = /^(?:chrome-extension|moz-extension):\/\/[a-z0-9-]{1,64}$/i;

export function allowedOrigin(origin: string | null, ownOrigin?: string): boolean {
  if (!origin) return false;
  return EXTENSION_ORIGIN.test(origin) || SITE_ORIGINS.has(origin) || origin === ownOrigin;
}

/** The CORS headers for a response to `request`: none when its origin is not allowed. */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  const own = new URL(request.url).origin;
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && allowedOrigin(origin, own)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

/**
 * A page on another website may send a GET it cannot read: refused before
 * anything is spent. Requests without an Origin (curl, the smoke tests, a
 * link opened by hand) are let through to the rate limit.
 */
export function foreignOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin) return !allowedOrigin(origin, new URL(request.url).origin);
  const site = request.headers.get('sec-fetch-site');
  const mode = request.headers.get('sec-fetch-mode');
  return site === 'cross-site' && mode !== 'navigate';
}
