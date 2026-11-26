'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clockOf, holdersStamp, marketStamp, type MarketRead, type Stamp } from './live-labels';
import { agoWords } from './useLive';

export { clockOf };

/** When each part of a report was last read: live reads, and the report itself. */
export type LiveTimes = {
  collectedAt: string;
  marketAt: string | null;
  /** The last live market read, for where its figures come from; absent: none yet. */
  market?: MarketRead | null;
  holdersAt: string | null;
  paused: boolean;
};

/** The time now, ticking every second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function StampLine({ stamp }: { stamp: Stamp }) {
  return stamp.live ? (
    <p className="card-stamp live-badge">
      <span className="live-dot" aria-hidden="true" /> {stamp.text}
    </p>
  ) : (
    <p className="card-stamp">{stamp.text}</p>
  );
}

/** The market card's stamp: the price's slot on chain, or DexScreener's delay. */
export function MarketStamp({ live }: { live: LiveTimes }) {
  const now = useNow();
  return <StampLine stamp={marketStamp(live.market ?? null, live.collectedAt, live.paused, now)} />;
}

/** The holders' stamp: read on chain with the report, refreshed every 20 s. */
export function HoldersLiveStamp({ live }: { live: LiveTimes }) {
  const now = useNow();
  return <StampLine stamp={holdersStamp(live.holdersAt, live.collectedAt, live.paused, now)} />;
}

/** A value that flashes when it changes, so a live move is seen. */
export function Flash({ value, children }: { value: string; children?: ReactNode }) {
  const before = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (before.current === value) return;
    before.current = value;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 900);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <span className="live-value" data-flash={flash || undefined}>
      {children ?? value}
    </span>
  );
}

function Since({ at }: { at: string }) {
  const now = useNow();
  return <>{agoWords(now - Date.parse(at))}</>;
}

/**
 * A card's freshness: "Live · updated 2 s ago" while its live read runs,
 * "Refreshed 14:02:11" once polling stopped, "As of 14:00:03" for a card
 * nothing refreshes.
 */
export function LiveStamp({
  at,
  collectedAt,
  paused = false,
}: {
  at: string | null;
  collectedAt: string;
  paused?: boolean;
}) {
  if (!at) return <p className="card-stamp">As of {clockOf(collectedAt)}</p>;
  if (paused) return <p className="card-stamp">Refreshed {clockOf(at)} · live paused</p>;
  return (
    <p className="card-stamp live-badge">
      <span className="live-dot" aria-hidden="true" /> Live · updated <Since at={at} />
    </p>
  );
}
