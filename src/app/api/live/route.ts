import { NextResponse } from 'next/server';
import { allowShared, clientKey, type RateLimit } from '@/lib/guard';
import {
  liveHoldersCache,
  liveMarketCache,
  readLiveHolders,
  readLiveMarket,
  type LiveHolders,
  type LiveMarket,
} from '@/lib/live';
import { log } from '@/lib/logger';
import { isSolanaAddress } from '@/lib/solana/address';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * GET /api/live?token=<mint>[&holders=1&creator=<address>]
 *
 * The figures of a report that move by the second, for the page showing it:
 * the price from the main pool on chain every 2 s (volume and trades from
 * DexScreener), the holders and what the dev holds every twenty. Served from
 * the shared cache when anyone asked in the last seconds, free of charge
 * then; a read that has to go upstream is counted against the caller's own
 * bucket.
 */

/** Upstream reads per caller and minute: a page polls the market every 2 s, holders every 20 s. */
const MARKET_LIMIT: RateLimit = { capacity: 45, perMinute: 45 };
const HOLDERS_LIMIT: RateLimit = { capacity: 6, perMinute: 6 };

/** A token asked by many pages at once is read once. */
const inflight = new Map<string, Promise<unknown>>();

function once<T>(key: string, read: () => Promise<T>): Promise<T> {
  const known = inflight.get(key) as Promise<T> | undefined;
  if (known) return known;
  const pending = read().finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token')?.trim() ?? '';
  if (!isSolanaAddress(token)) return json({ error: 'Invalid token address' }, 400);
  const wantHolders = url.searchParams.get('holders') === '1';
  const creatorParam = url.searchParams.get('creator')?.trim() ?? '';
  const creator = isSolanaAddress(creatorParam) ? creatorParam : null;
  const caller = clientKey(request);

  let market: LiveMarket | null = (await liveMarketCache.get(token).catch(() => undefined)) ?? null;
  if (!market && (await allowShared(`live:${caller}`, MARKET_LIMIT))) {
    try {
      market = await once(`m:${token}`, () => readLiveMarket(token, AbortSignal.timeout(5_000)));
      await liveMarketCache.set(token, market).catch(() => false);
    } catch (error) {
      log.warn('marché en direct indisponible', { token, error: String(error) });
    }
  }

  let holders: LiveHolders | null = null;
  if (wantHolders) {
    const key = `${token}:${creator ?? ''}`;
    holders = (await liveHoldersCache.get(key).catch(() => undefined)) ?? null;
    if (!holders && (await allowShared(`live-holders:${caller}`, HOLDERS_LIMIT))) {
      try {
        holders = await once(`h:${key}`, () => readLiveHolders(token, creator));
        // A read that saw nothing is not kept: the next poll tries again.
        if (holders.top10OfSupply !== null || holders.devHolds !== null) {
          await liveHoldersCache.set(key, holders).catch(() => false);
        }
      } catch (error) {
        log.warn('détenteurs en direct indisponibles', { token, error: String(error) });
      }
    }
  }
  return json({ market, holders });
}
