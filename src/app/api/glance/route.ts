import { getAddress, isAddress } from 'viem';
import { NextResponse } from 'next/server';
import { corsHeaders, foreignOrigin } from '@/lib/cors';
import { SealError } from '@/lib/errors';
import { allowShared, clientKey, GLANCE_LIMIT } from '@/lib/guard';
import {
  deepLink,
  glanceOf,
  GlanceUnavailableError,
  PAIR_PATTERN,
  tokenOfPair,
  type GlanceResponse,
} from '@/lib/glance-service';
import { log } from '@/lib/logger';
import { siteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/glance?token=0x… (or ?pair=0x… for a DexScreener pair)
 *
 * The "In short" of a token for the browser extension, worked out from the
 * collected facts alone: no model is called, nothing is paid per request.
 *
 * GET rather than POST: it is a read, the same for every caller, and a GET
 * without custom headers is a "simple" cross-origin request — the extension
 * gets its answer without a preflight round trip.
 */

const PUBLIC_MESSAGE: Record<string, string> = {
  'rate-limit': 'A data source is rate-limiting requests. Try again in a minute.',
  'not-found': 'Nothing was found for this address',
  timeout: 'A data source did not answer in time',
};

function reply(request: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      // Answers are already cached server side; a browser keeps its own copy briefly.
      'Cache-Control': status === 200 ? 'private, max-age=120' : 'no-store',
      ...extra,
    },
  });
}

const fail = (request: Request, status: number, error: string, extra?: Record<string, string>) =>
  reply(request, { error }, status, extra);

/** The deep link opens on the deployment that answered, or on the configured site. */
function linkBase(request: Request): string | URL {
  return process.env.NEXT_PUBLIC_SITE_URL?.trim() ? siteUrl() : new URL(request.url).origin;
}

export function OPTIONS(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request): Promise<Response> {
  if (foreignOrigin(request)) return fail(request, 403, 'Cross-site requests are not accepted');

  const params = new URL(request.url).searchParams;
  const tokenParam = params.get('token')?.trim() ?? '';
  const pairParam = params.get('pair')?.trim() ?? '';
  if (tokenParam ? !isAddress(tokenParam) : !PAIR_PATTERN.test(pairParam)) {
    return fail(request, 400, 'Invalid token address');
  }

  if (!(await allowShared(`glance:${clientKey(request)}`, GLANCE_LIMIT))) {
    return fail(request, 429, 'Too many requests from this address. Try again in a minute.', {
      'retry-after': '60',
    });
  }

  try {
    let token = tokenParam;
    if (!token) {
      // A DexScreener URL names the pair; it can also carry the token itself.
      const traded = await tokenOfPair(pairParam);
      if (traded) token = traded;
      else if (isAddress(pairParam)) token = pairParam;
      else return fail(request, 404, 'Nothing was found for this address');
    }
    const checksummed = getAddress(token);
    const started = Date.now();
    const { cached, ...glance } = await glanceOf(checksummed);
    log.info('aperçu servi', { token: checksummed, cached, ms: Date.now() - started });
    return reply(request, {
      ...glance,
      url: deepLink(linkBase(request), checksummed),
      cached,
    } satisfies GlanceResponse);
  } catch (error) {
    if (error instanceof SealError) {
      const status = error.kind === 'rate-limit' ? 429 : error.kind === 'not-found' ? 404 : 502;
      log.warn('aperçu en échec', { kind: error.kind, message: error.message });
      return fail(request, status, PUBLIC_MESSAGE[error.kind] ?? 'A data source failed');
    }
    if (error instanceof GlanceUnavailableError) {
      return fail(request, 502, 'Too little could be read on this token to sum it up');
    }
    log.error('aperçu en échec', { error: String(error) });
    return fail(request, 500, 'The token could not be read');
  }
}
