'use client';

import { useEffect, useRef, useState } from 'react';
import type { Figure } from '@/lib/figures';
import type { Flag } from '@/lib/flags';
import { Flags } from './Flags';
import {
  clockOf as clock,
  figureSource,
  holdersLine,
  marketLines,
  SOURCE_WORDS,
  type MarketRead,
} from './live-labels';
import { useNow } from './LiveStamp';

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
  market,
  holdersAt,
  partial,
}: {
  flags: Flag[];
  figures: Figure[];
  sentence: string | null;
  collectedAt: string;
  /** The last live market read: its chain slot when the pool was read on chain. */
  market: MarketRead | null;
  holdersAt: string | null;
  partial: string | null;
}) {
  const now = useNow();
  return (
    <section className="top-read" aria-labelledby="top-read-title">
      <h3 id="top-read-title" className="glance-kicker">
        In short
      </h3>
      <Flags flags={flags} />
      {sentence && <p className="top-sentence">{sentence}</p>}
      {figures.length > 0 && (
        <ul className="figures-row" aria-label="Key figures">
          {figures.map((f) => {
            const source = figureSource(f, market);
            return (
              <li key={f.id} data-figure={f.id}>
                <span className="figure-label">{f.label}</span>
                <FigureValue value={f.value} />
                {f.sub && <span className="figure-sub">{f.sub}</span>}
                {source && (
                  <span className="figure-source" data-source={source}>
                    {SOURCE_WORDS[source]}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="freshness">
        {marketLines(market, collectedAt, now).map((line) =>
          line.live ? (
            <span key={line.text.slice(0, 12)} className="live-badge">
              <span className="live-dot" aria-hidden="true" /> {line.text}
            </span>
          ) : (
            <span key={line.text.slice(0, 12)}>{line.text}</span>
          ),
        )}
        <span>{holdersLine(holdersAt, collectedAt, now)}</span>
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
