'use client';

import { useEffect, useRef, useState } from 'react';
import type { Figure } from '@/lib/figures';
import type { Flag } from '@/lib/flags';
import { Flags } from './Flags';
import { agoWords } from './useLive';

/** "14:02:11", in the reader's own time. */
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** A value that flashes when it changes, so a live move is seen. */
function FigureValue({ value }: { value: string }) {
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
    <strong className="figure-value" data-flash={flash || undefined}>
      {value}
    </strong>
  );
}

/** Seconds since the last live read, ticking. */
function Since({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{agoWords(now - Date.parse(at))}</>;
}

/**
 * The report's first screen: SEAL's flags, one fact each, red, orange or
 * green by fixed rules; the figures row, its market live; and at most two
 * sentences from the model tying the flags together. Nothing here is a score:
 * each flag judges its own fact.
 */
export function TopRead({
  flags,
  figures,
  sentence,
  collectedAt,
  marketAt,
  chain = null,
  dexAt = null,
  holdersAt,
  partial,
}: {
  flags: Flag[];
  figures: Figure[];
  sentence: string | null;
  collectedAt: string;
  marketAt: string | null;
  /** The slot the live price was read at, when it was read on chain. */
  chain?: { slot: number; at: string } | null;
  /** When DexScreener's figures (volume, trades) were last read. */
  dexAt?: string | null;
  holdersAt: string | null;
  partial: string | null;
}) {
  return (
    <section className="top-read" aria-labelledby="top-read-title">
      <h3 id="top-read-title" className="glance-kicker">
        In short
      </h3>
      <Flags flags={flags} />
      {sentence && <p className="top-sentence">{sentence}</p>}
      {figures.length > 0 && (
        <ul className="figures-row" aria-label="Key figures">
          {figures.map((f) => (
            <li key={f.id} data-figure={f.id}>
              <span className="figure-label">{f.label}</span>
              <FigureValue value={f.value} />
              {f.sub && <span className="figure-sub">{f.sub}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="freshness">
        {chain ? (
          <>
            <span className="live-badge">
              <span className="live-dot" aria-hidden="true" /> Price live from the chain · slot{' '}
              {chain.slot.toLocaleString('en-US')} · <Since at={chain.at} />
            </span>
            <span>
              Volume and trades via DexScreener (~30 s behind) · read{' '}
              <Since at={dexAt ?? chain.at} />
            </span>
          </>
        ) : marketAt ? (
          <span className="live-badge">
            <span className="live-dot" aria-hidden="true" /> Market via DexScreener (~30 s behind
            the chain) · read <Since at={dexAt ?? marketAt} />
          </span>
        ) : (
          <span>Market as of {clock(collectedAt)} (DexScreener)</span>
        )}
        <span>Holders and dev read from the chain · as of {clock(holdersAt ?? collectedAt)}</span>
        <span>Launch and creator history as of {clock(collectedAt)}</span>
      </p>
      {partial && (
        <p className="glance-partial" role="status">
          {partial}
        </p>
      )}
    </section>
  );
}
