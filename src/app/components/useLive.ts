'use client';

import { useEffect, useRef, useState } from 'react';
import type { LiveHolders, LiveMarket } from '@/lib/live';

/** The market every 4 s, the holders every 20 s, while the tab is visible. */
export const MARKET_EVERY_MS = 4_000;
export const HOLDERS_EVERY_MS = 20_000;
/** After failed polls the wait doubles, up to this. */
export const MAX_BACKOFF_MS = 60_000;
/** A page nobody has touched for this long stops polling, until someone does. */
export const IDLE_AFTER_MS = 30 * 60_000;

export type Live = {
  market: LiveMarket | null;
  holders: LiveHolders | null;
  /** Polling stopped: the page was left untouched, or the live read keeps failing. */
  paused: boolean;
};

/** The wait before the next poll: 4 s, then doubled per failed poll in a row, 60 s at most. */
export function nextDelay(failures: number): number {
  if (failures <= 0) return MARKET_EVERY_MS;
  return Math.min(MAX_BACKOFF_MS, MARKET_EVERY_MS * 2 ** Math.min(failures, 10));
}

/** Whether a page last touched at `lastActivity` is idle at `now`. */
export function isIdle(lastActivity: number, now: number): boolean {
  return now - lastActivity >= IDLE_AFTER_MS;
}

/** The live reads laid over the previous ones: a part the poll did not bring is kept. */
export function mergeLive(before: Live, body: Partial<Pick<Live, 'market' | 'holders'>>): Live {
  return {
    market: body.market ?? before.market,
    holders: body.holders ?? before.holders,
    paused: false,
  };
}

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'touchstart'];

/**
 * Polls /api/live for `token` while the page is visible, and stops when the
 * tab is hidden: a report left open in a background tab costs nothing. A
 * failed poll waits twice as long before the next; a page left untouched for
 * half an hour stops until it is touched again.
 */
export function useLive(token: string, creator: string | null, enabled = true): Live {
  const [live, setLive] = useState<Live>({ market: null, holders: null, paused: false });
  const lastHolders = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let idle = false;
    let failures = 0;
    let lastActivity = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      if (stopped) return;
      if (isIdle(lastActivity, Date.now())) {
        idle = true;
        setLive((before) => ({ ...before, paused: true }));
        return;
      }
      if (document.visibilityState !== 'visible') return; // resumed by visibilitychange
      const holders = Date.now() - lastHolders.current >= HOLDERS_EVERY_MS;
      const params = new URLSearchParams({ token });
      if (holders) {
        params.set('holders', '1');
        if (creator) params.set('creator', creator);
      }
      try {
        const response = await fetch(`/api/live?${params}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as Partial<Live>;
        if (holders) lastHolders.current = Date.now();
        // A poll the server could not serve (upstream down, bucket empty) counts as a miss.
        failures = body.market ? 0 : failures + 1;
        if (!stopped) setLive((before) => mergeLive(before, body));
      } catch {
        // A missed poll is said by the age of the last one.
        failures += 1;
      }
      schedule(nextDelay(failures));
    };
    const wake = () => {
      lastActivity = Date.now();
      if (idle && document.visibilityState === 'visible') {
        idle = false;
        failures = 0;
        setLive((before) => ({ ...before, paused: false }));
        schedule(0);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        clearTimeout(timer);
        return;
      }
      lastActivity = Date.now();
      idle = false;
      schedule(0);
    };
    for (const name of ACTIVITY) window.addEventListener(name, wake, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    // The report's own figures are seconds old: the first poll waits one beat.
    schedule(MARKET_EVERY_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const name of ACTIVITY) window.removeEventListener(name, wake);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [token, creator, enabled]);
  return live;
}

/** "2 s ago", "1 min ago". */
export function agoWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}
