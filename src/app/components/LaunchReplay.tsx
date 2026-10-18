'use client';

import { useEffect, useState } from 'react';
import type { LaunchMove, LaunchReplayData } from '@/lib/contracts/launch';
import {
  addressesWord,
  BUYERS_LISTED,
  buildStory,
  type Buyer,
  roundTripsExcludedWords,
  type LaunchStory,
} from '@/lib/launch-story';

/**
 * The first minutes of the token, replayed. Every dot is one move read from
 * the token's transfers: when it happened, what it was, how much of the supply
 * it carried, and whether the address still holds today. Nothing is named
 * sniper or insider; the reader sees who moved first and judges.
 */

const EXPLORER = 'https://robinhoodchain.blockscout.com';

const KIND_WORD: Record<LaunchMove['kind'], string> = {
  mint: 'Created for',
  allocation: 'Passed on to',
  buy: 'Bought by',
  sell: 'Sold by',
  provide: 'Liquidity added by',
  withdraw: 'Liquidity removed by',
};

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function pct(value: number): string {
  if (value === 0) return '0%';
  if (value < 0.0001) return '<0.01%';
  if (value < 0.01) return `${(value * 100).toFixed(2)}%`;
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

/** "the first 10 minutes", "the first 40 seconds", "the first minute". */
function span(seconds: number): string {
  if (seconds < 90) {
    const s = Math.max(1, Math.round(seconds));
    return s === 1 ? 'second' : `${s} seconds`;
  }
  const m = Math.round(seconds / 60);
  return m === 1 ? 'minute' : `${m} minutes`;
}

function when(seconds: number): string {
  if (seconds < 1) return 'launch';
  if (seconds < 60) return `+${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `+${m} min ${s} s` : `+${m} min`;
}

function holding(move: LaunchMove): 'holds' | 'reduced' | 'gone' | 'unknown' {
  if (move.heldNow === null) return 'unknown';
  if (move.heldNow === 0) return 'gone';
  if (move.actorKind === 'pool') return 'holds';
  return move.heldNow < move.share * 0.99 ? 'reduced' : 'holds';
}

const HOLDING_WORD = {
  holds: 'Still holds',
  reduced: 'Holds less',
  gone: 'Holds nothing',
  unknown: 'Unknown',
} as const;

function Story({ story }: { story: LaunchStory }) {
  const { early } = story;
  const items: { tone: string; figure: string; label: string }[] = [];
  if (story.creatorAtLaunch > 0) {
    items.push({
      tone: story.creatorAtLaunch >= 0.05 ? 'attention' : 'neutral',
      figure: pct(story.creatorAtLaunch),
      label: 'taken by the creator in the launch block itself',
    });
  }
  // Delivered by the creator's own launch transaction to other addresses:
  // linked to the creator by that transaction, whoever controls them.
  if (story.creatorTx && story.creatorTx.share >= 0.01) {
    const n = story.creatorTx.addresses;
    items.push({
      tone: story.creatorTx.share >= 0.05 ? 'attention' : 'neutral',
      figure: pct(story.creatorTx.share),
      label: `delivered by the creator’s own launch transaction to ${n} ${addressesWord(n, story.creatorTx.contracts)} other than the creator’s wallet`,
    });
  }
  // An old replay counted the moves listed only: said, so it is not read as a total.
  const among = story.counted === 'shown' && story.partial ? ' among the moves shown' : '';
  if (early.wallets > 0) {
    items.push({
      tone: early.share >= 0.05 ? 'attention' : 'neutral',
      figure: pct(early.share),
      label: `bought by ${early.wallets} ${addressesWord(early.wallets, early.contracts)} ${
        early.within < 1 ? 'in the first second' : `within ${Math.round(early.within)} s of launch`
      }${among}${
        story.bundle && story.bundle.share >= 0.01
          ? `, ${pct(story.bundle.share)} through one single transaction to ${story.bundle.wallets} ${addressesWord(story.bundle.wallets, story.bundle.contracts)}`
          : ''
      }`,
    });
    items.push(
      early.heldNow === null
        ? {
            tone: 'neutral',
            figure: '?',
            label: 'what those first buyers hold today could not be read',
          }
        : {
            tone: early.heldNow < early.share * 0.1 ? 'attention' : 'calm',
            figure: pct(early.heldNow),
            label:
              early.heldNow === 0
                ? 'still held by them today: they sold everything'
                : `still held by them today${early.unread ? ` (${early.unread} not read)` : ''}`,
          },
    );
  } else {
    items.push({ tone: 'calm', figure: '0', label: 'wallets bought in the first minute' });
  }
  if (story.creatorSold > 0) {
    items.push({
      tone: 'attention',
      figure: pct(story.creatorSold),
      label: `sold by the creator in these first minutes${among}`,
    });
  }
  // The round trips, with those left out of the count and why (RH: 25
  // counted, 3 more excluded, which the text never said).
  const trips = story.roundTrips;
  if (trips && trips.wallets > 0) {
    items.push({
      tone: 'neutral',
      figure: String(trips.wallets),
      label: `${trips.wallets === 1 ? 'address' : 'addresses'} bought and sold back within these first minutes${roundTripsExcludedWords(trips.excluded ?? undefined)}`,
    });
  }
  return (
    <ul className="launch-story">
      {items.slice(0, 5).map((item) => (
        <li key={item.label} data-tone={item.tone}>
          <strong>{item.figure}</strong>
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

const PLOT = { left: 52, top: 24, bottom: 236 };

/** A ceiling the eye can read: 1, 2, 5, 10, 20, 50 or 100% of supply. */
function niceMax(value: number): number {
  for (const step of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]) if (value <= step) return step;
  return 1;
}

/** The chart is drawn at its real width, so its labels stay readable on a phone. */
function useWidth(fallback: number) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(300, Math.round(entry.contentRect.width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [width, setNode] as const;
}

function Curve({
  story,
  window,
  run,
  width,
}: {
  story: LaunchStory;
  window: number;
  run: number;
  width: number;
}) {
  const right = width - 16;
  const top = niceMax(Math.max(0.001, ...story.curve.map((p) => p.bought)));
  const sx = (seconds: number) =>
    PLOT.left + Math.sqrt(Math.max(0, seconds) / window) * (right - PLOT.left);
  const sy = (share: number) => PLOT.bottom - (share / top) * (PLOT.bottom - PLOT.top);
  // Steps, not slopes: supply changes hands at an instant.
  const path = (key: 'bought' | 'held') =>
    story.curve
      .map((p, i) => {
        const y = sy(p[key]).toFixed(1);
        return i === 0 ? `M${sx(p.seconds).toFixed(1)},${y}` : `H${sx(p.seconds).toFixed(1)}V${y}`;
      })
      .join('') + `H${sx(window).toFixed(1)}`;
  const area = (key: 'bought' | 'held') => `${path(key)}V${PLOT.bottom}H${PLOT.left}Z`;
  // A tick too close to the previous one is left out rather than overlapping it.
  const ticks = [0, 10, 60, 300, 600]
    .filter((t) => t <= window)
    .filter((t, i, all) => i === 0 || sx(t) - sx(all[i - 1]!) >= 44);
  const levels = [0, top / 2, top];
  const end = story.curve.at(-1)!;
  return (
    <svg
      key={run}
      className="story-chart"
      viewBox={`0 0 ${width} 280`}
      role="img"
      aria-label={`Share of supply bought over the first ${span(window)}: ${pct(end.bought)} bought, ${pct(end.held)} still held by those buyers today.`}
    >
      {levels.map((level) => (
        <g key={level}>
          <line className="story-grid" x1={PLOT.left} x2={right} y1={sy(level)} y2={sy(level)} />
          <text className="story-axis" x={PLOT.left - 10} y={sy(level) + 4} textAnchor="end">
            {pct(level)}
          </text>
        </g>
      ))}
      {ticks.map((t) => (
        <text key={t} className="story-axis" x={sx(t)} y={PLOT.bottom + 22} textAnchor="middle">
          {t === 0 ? 'launch' : t < 60 ? `${t} s` : `${t / 60} min`}
        </text>
      ))}
      <g className="story-draw">
        <path className="story-area story-bought" d={area('bought')} />
        <path className="story-line story-bought" d={path('bought')} />
        <path className="story-area story-held" d={area('held')} />
        <path className="story-line story-held" d={path('held')} />
      </g>
      {story.creatorSales.slice(0, 6).map((sale, i) => (
        <g key={`${sale.seconds}-${i}`} className="story-sale">
          <line x1={sx(sale.seconds)} x2={sx(sale.seconds)} y1={PLOT.top} y2={PLOT.bottom} />
          <path d={`M${sx(sale.seconds) - 6},${PLOT.top - 10}h12l-6,9z`} />
          <title>{`${when(sale.seconds)} · the creator sold ${pct(sale.share)} of the supply`}</title>
        </g>
      ))}
      <text className="story-end story-bought" x={right} y={sy(end.bought) - 8} textAnchor="end">
        {pct(end.bought)} bought
      </text>
      {end.held < end.bought * 0.85 && (
        <text
          className="story-end story-held"
          x={right}
          y={Math.min(PLOT.bottom - 8, sy(end.held) - 8)}
          textAnchor="end"
        >
          {pct(end.held)} still held
        </text>
      )}
    </svg>
  );
}

/** Bought against still held, on one scale: the whole supply. */
function Compare({ story }: { story: LaunchStory }) {
  const end = story.curve.at(-1)!;
  const rows = [
    { key: 'bought', label: 'Bought in the first second', value: end.bought },
    { key: 'held', label: 'Still held by those buyers today', value: end.held },
  ];
  return (
    <div
      className="story-compare"
      role="img"
      aria-label={rows.map((r) => `${r.label}: ${pct(r.value)}`).join('; ')}
    >
      {rows.map((r) => (
        <div key={r.key} className="story-compare-row" data-key={r.key}>
          <span className="story-compare-label">{r.label}</span>
          <span className="story-compare-track">
            <span
              className="story-compare-fill"
              style={{ width: `${Math.max(0.6, r.value * 100)}%` }}
            />
          </span>
          <strong>{pct(r.value)}</strong>
        </div>
      ))}
      <p className="story-note">
        Out of the whole supply. Nearly every purchase happened in the very first second.
      </p>
    </div>
  );
}

function Buyers({ buyers, bundle }: { buyers: Buyer[]; bundle: string | null }) {
  const shown = buyers.slice(0, BUYERS_LISTED);
  const widest = Math.max(...shown.map((b) => b.bought), 0.0001);
  return (
    <ol className="first-buyers" aria-label="The first buyers, in the order they bought">
      {shown.map((b, i) => {
        const kept = b.heldNow === null ? null : Math.min(b.heldNow, b.bought);
        const status =
          kept === null
            ? 'Not read'
            : kept === 0
              ? 'Sold everything'
              : kept >= b.bought * 0.99
                ? 'Still holds it all'
                : `Still holds ${pct(kept)}`;
        const tone =
          kept === null
            ? 'unknown'
            : kept === 0
              ? 'gone'
              : kept >= b.bought * 0.99
                ? 'holds'
                : 'reduced';
        return (
          <li key={b.address} data-tone={tone}>
            <span className="buyer-rank">{i + 1}</span>
            <span className="buyer-who">
              <a href={`${EXPLORER}/address/${b.address}`} target="_blank" rel="noreferrer">
                {short(b.address)}
              </a>
              {b.isCreator && <span className="launch-flag">creator</span>}
              {bundle && b.transaction === bundle && (
                <span className="launch-role">same transaction</span>
              )}
              <small>{when(b.firstAt)}</small>
            </span>
            <span className="buyer-bar" aria-hidden="true">
              <span className="buyer-bought" style={{ width: `${(b.bought / widest) * 100}%` }}>
                <span
                  className="buyer-kept"
                  style={{ width: `${kept === null ? 0 : (kept / b.bought) * 100}%` }}
                />
              </span>
            </span>
            <span className="buyer-share">{pct(b.bought)}</span>
            <span className="buyer-status">{status}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function LaunchReplay({
  launch,
  index = '03',
}: {
  launch: LaunchReplayData;
  /** Section number in the report. */
  index?: string;
}) {
  const [run, setRun] = useState(0);
  const [all, setAll] = useState(false);
  const firstSpan = span(launch.windowSeconds);
  const rows = all ? launch.moves : launch.moves.slice(0, 8);
  const story = buildStory(launch);
  const [chartWidth, setChartNode] = useWidth(900);

  return (
    <section className="launch-replay" aria-labelledby="launch-title">
      <div className="report-section-head">
        <p className="report-kicker">
          {index} — The first {firstSpan}
        </p>
        <h3 id="launch-title">Who got in first, and who is still there.</h3>
        <p className="questions-intro">
          Read from the token’s own transfers, from the moment it was created.
        </p>
      </div>
      <Story story={story} />
      <div className="launch-stage">
        {!story.frontLoaded && (
          <div className="launch-stage-top">
            <span className="story-key">
              <i className="story-key-bought" aria-hidden="true" /> Bought
              <i className="story-key-held" aria-hidden="true" /> Still held today
              {story.creatorSales.length > 0 && (
                <>
                  <i className="story-key-sale" aria-hidden="true" /> Creator sold
                </>
              )}
            </span>
            <button
              type="button"
              className="launch-replay-button"
              onClick={() => setRun((n) => n + 1)}
            >
              Replay <span aria-hidden="true">↻</span>
            </button>
          </div>
        )}
        {story.frontLoaded ? (
          <Compare story={story} />
        ) : (
          <div className="launch-chart-box" ref={setChartNode}>
            <Curve
              story={story}
              window={Math.max(1, launch.windowSeconds)}
              run={run}
              width={chartWidth}
            />
          </div>
        )}
        {story.partial && (
          <p className="story-note">
            Drawn from the {launch.moves.length} largest moves and every move of the creator, out of{' '}
            {launch.movesInWindow.toLocaleString('en-US')} in the window
            {story.counted === 'all'
              ? '; the figures above count all of them.'
              : '; the figures above count only the moves drawn.'}
          </p>
        )}
      </div>
      {story.buyers.length > 0 && (
        <div className="first-buyers-block">
          <h4>The first buyers</h4>
          <p className="story-note">
            In the order they bought. The bright part of each bar is what they still hold today.
          </p>
          <Buyers buyers={story.buyers} bundle={story.bundle?.transaction ?? null} />
        </div>
      )}
      <details className="launch-all">
        <summary>Every move, one by one</summary>
        <div className="launch-table-scroll">
          <table className="launch-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Move</th>
                <th scope="col">Address</th>
                <th scope="col">Share</th>
                <th scope="col">Today</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((move) => {
                const state = holding(move);
                return (
                  <tr key={`${move.transaction}-${move.actor}-${move.kind}`} data-kind={move.kind}>
                    <td>{when(move.seconds)}</td>
                    <td>
                      <span className="launch-kind">{KIND_WORD[move.kind]}</span>
                      {move.counterpartyIsCreator && (
                        <span className="launch-flag">from the creator</span>
                      )}
                    </td>
                    <td>
                      <a
                        href={`${EXPLORER}/address/${move.actor}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {short(move.actor)}
                      </a>
                      {move.actorIsCreator ? (
                        <span className="launch-flag">creator</span>
                      ) : (
                        move.actorKind !== 'wallet' && (
                          <span className="launch-role">{move.actorKind}</span>
                        )
                      )}
                    </td>
                    <td>{pct(move.share)}</td>
                    <td data-holding={state}>
                      {move.heldNow === null ? '—' : pct(move.heldNow)}
                      <small>{HOLDING_WORD[state]}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {launch.moves.length > 8 && (
          <p className="launch-more">
            <button type="button" className="text-link" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${launch.moves.length} moves`}
            </button>
          </p>
        )}
      </details>
    </section>
  );
}
