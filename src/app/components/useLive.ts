'use client';

import { useEffect, useRef, useState } from 'react';
import type { LiveHolders, LiveMarket } from '@/lib/live';

/** The market every 4 s, the holders every 20 s, while the tab is visible. */
export const MARKET_EVERY_MS = 4_000;
export const HOLDERS_EVERY_MS = 20_000;

export type Live = {
  market: LiveMarket | null;
  holders: LiveHolders | null;
};

/**
 * Polls /api/live for `token` while the page is visible, and stops when the
 * tab is hidden: a report left open in a background tab costs nothing.
 */
export function useLive(token: string, creator: string | null, enabled = true): Live {
  const [live, setLive] = useState<Live>({ market: null, holders: null });
  const lastHolders = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        const holders = Date.now() - lastHolders.current >= HOLDERS_EVERY_MS;
        const params = new URLSearchParams({ token });
        if (holders) {
          params.set('holders', '1');
          if (creator) params.set('creator', creator);
        }
        try {
          const response = await fetch(`/api/live?${params}`, { cache: 'no-store' });
          if (response.ok) {
            const body = (await response.json()) as Live;
            if (holders) lastHolders.current = Date.now();
            if (!stopped) {
              setLive((before) => ({
                market: body.market ?? before.market,
                holders: body.holders ?? before.holders,
              }));
            }
          }
        } catch {
          // A missed poll is said by the age of the last one.
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), MARKET_EVERY_MS);
    };
    // The report's own figures are seconds old: the first poll waits one beat.
    timer = setTimeout(() => void tick(), MARKET_EVERY_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token, creator, enabled]);
  return live;
}

/** "2 s ago", "1 min ago". */
export function agoWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}
