'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { agoWords } from './useLive';

/** When each part of a report was last read: live reads, and the report itself. */
export type LiveTimes = {
  collectedAt: string;
  marketAt: string | null;
  /** The slot the live price was read at on chain; `null` or absent: DexScreener's. */
  marketSlot?: number | null;
  holdersAt: string | null;
  paused: boolean;
};

/** "14:02:11", in the reader's own time. */
export function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
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
