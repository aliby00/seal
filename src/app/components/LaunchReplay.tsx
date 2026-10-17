'use client';

import { useState, type CSSProperties } from 'react';
import type { LaunchMove, LaunchReplayData } from '@/lib/contracts/launch';

/**
 * The first minutes of the token, replayed. Every dot is one move read from
 * the token's transfers: when it happened, what it was, how much of the supply
 * it carried, and whether the address still holds today. Nothing is named
 * sniper or insider; the reader sees who moved first and judges.
 */

const EXPLORER = 'https://robinhoodchain.blockscout.com';

type Lane = 'mint' | 'allocation' | 'buy' | 'sell' | 'liquidity';

const LANES: { lane: Lane; label: string }[] = [
  { lane: 'mint', label: 'Created' },
  { lane: 'allocation', label: 'Passed on' },
  { lane: 'buy', label: 'Bought' },
  { lane: 'sell', label: 'Sold' },
  { lane: 'liquidity', label: 'Liquidity' },
];

/** Liquidity put in and taken out share one lane: neither is a trade. */
const laneOf = (kind: LaunchMove['kind']): Lane =>
  kind === 'provide' || kind === 'withdraw' ? 'liquidity' : kind;

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

const CHART_LEFT = 120;
const CHART_WIDTH = 850;

/** Square-root time: the launch block gets room, the tenth minute still fits. */
function x(seconds: number, window: number): number {
  return CHART_LEFT + Math.sqrt(Math.max(0, seconds) / Math.max(1, window)) * CHART_WIDTH;
}

function radius(share: number): number {
  return Math.max(4.5, Math.min(22, Math.sqrt(share) * 44));
}

function holding(move: LaunchMove): 'holds' | 'reduced' | 'gone' | 'unknown' {
  if (move.heldNow === null) return 'unknown';
  if (move.heldNow === 0) return 'gone';
  if (move.actorKind === 'pool') return 'holds';
  return move.heldNow < move.share * 0.99 ? 'reduced' : 'holds';
}

/**
 * A burst — the same kind of move from the same source within a few seconds,
 * such as one wallet seeding twenty-seven others — is drawn as one dot with
 * its count, so the chart shows the pattern instead of a tower of dots.
 */
type Burst = {
  first: LaunchMove;
  moves: LaunchMove[];
  share: number;
  state: ReturnType<typeof holding>;
};

const BURST_SECONDS = 5;

function bursts(moves: readonly LaunchMove[]): Burst[] {
  const out: Burst[] = [];
  for (const move of moves) {
    const open = out.find(
      (b) =>
        b.first.kind === move.kind &&
        b.first.counterparty === move.counterparty &&
        b.first.actorIsCreator === move.actorIsCreator &&
        move.seconds - b.first.seconds <= BURST_SECONDS &&
        move.kind !== 'mint',
    );
    if (open) {
      open.moves.push(move);
      open.share += move.share;
    } else {
      out.push({ first: move, moves: [move], share: move.share, state: 'unknown' });
    }
  }
  for (const burst of out) {
    const states = burst.moves.map(holding);
    burst.state = states.every((s) => s === 'gone')
      ? 'gone'
      : states.some((s) => s === 'holds')
        ? 'holds'
        : states.some((s) => s === 'reduced')
          ? 'reduced'
          : states.includes('gone')
            ? 'gone'
            : 'unknown';
  }
  return out;
}

const HOLDING_WORD = {
  holds: 'Still holds',
  reduced: 'Holds less',
  gone: 'Holds nothing',
  unknown: 'Unknown',
} as const;

function Summary({ launch }: { launch: LaunchReplayData }) {
  const people = launch.moves.filter((m) => m.actorKind !== 'pool' && m.actorKind !== 'burn');
  // Created straight into a holder's hands; what is passed on later is drawn, not added again.
  const given = new Set(
    people.filter((m) => m.kind === 'mint' || m.kind === 'allocation').map((m) => m.actor),
  );
  const launchBlock = people.filter((m) => m.kind === 'buy' && m.block === 0);
  const buys = people.filter((m) => m.kind === 'buy');
  const buyers = new Map(buys.map((m) => [m.actor, m]));
  const bought = buys.reduce((sum, m) => sum + m.share, 0);
  const known = [...buyers.values()].filter((m) => m.heldNow !== null);
  const stillHeld = known.reduce((sum, m) => sum + (m.heldNow ?? 0), 0);
  // An unread balance is not a zero: say how many could not be read.
  const unread = buyers.size - known.length;
  const holdToday =
    unread === buyers.size
      ? 'what they hold today could not be read'
      : unread > 0
        ? `the ${known.length} read hold ${pct(stillHeld)} today`
        : `they hold ${pct(stillHeld)} today`;
  const creatorMoves = launch.moves.filter((m) => m.actorIsCreator || m.counterpartyIsCreator);

  const items: { value: string; label: string }[] = [
    {
      value: String(given.size),
      label: `address${given.size === 1 ? '' : 'es'} handed tokens without buying them`,
    },
    {
      value: String(launchBlock.length),
      label: `purchase${launchBlock.length === 1 ? '' : 's'} in the launch block itself${launchBlock.length ? `, ${pct(launchBlock.reduce((s, m) => s + m.share, 0))} of supply` : ''}`,
    },
    {
      value: pct(bought),
      label: `bought by ${buyers.size} address${buyers.size === 1 ? '' : 'es'} ${launch.movesInWindow > launch.moves.length ? 'among the moves shown' : 'in the window'}; ${holdToday}`,
    },
    {
      value: String(creatorMoves.length),
      label: `move${creatorMoves.length === 1 ? '' : 's'} involving the creator`,
    },
  ];
  return (
    <ul className="launch-summary">
      {items.map((item) => (
        <li key={item.label}>
          <strong>{item.value}</strong>
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Chart({ launch, run }: { launch: LaunchReplayData; run: number }) {
  const window = Math.max(1, launch.windowSeconds);
  const ticks = [0, 10, 60, 300, 600].filter((t) => t <= window);
  const laneY = (lane: Lane) => 40 + LANES.findIndex((l) => l.lane === lane) * 52;
  // Moves at the same moment in the same lane are fanned out above and below
  // the line instead of hiding one another.
  const placed: { kind: string; cx: number; r: number }[] = [];
  const dots = bursts(launch.moves).map((burst) => {
    const move = burst.first;
    const cx = x(move.seconds, window);
    const r = radius(burst.share);
    const clashes = placed.filter(
      (p) => p.kind === move.kind && Math.abs(p.cx - cx) < p.r + r,
    ).length;
    placed.push({ kind: move.kind, cx, r });
    // Within the lane's own band: never over the next lane.
    const offset =
      clashes === 0 ? 0 : (clashes % 2 ? -1 : 1) * Math.min(20, Math.ceil(clashes / 2) * 10);
    return { burst, move, cx, cy: laneY(laneOf(move.kind)) + offset, r };
  });
  const labelled: number[] = [];
  return (
    <svg
      key={run}
      className="launch-chart"
      viewBox="0 0 1000 310"
      role="img"
      aria-label={`${launch.moves.length} moves in the first ${span(window)}, listed in the table below`}
    >
      {LANES.map((lane) => (
        <g key={lane.lane}>
          <line
            className="launch-lane"
            x1={CHART_LEFT}
            x2={CHART_LEFT + CHART_WIDTH + 10}
            y1={laneY(lane.lane)}
            y2={laneY(lane.lane)}
          />
          <text className="launch-lane-label" x={0} y={laneY(lane.lane) + 4}>
            {lane.label}
          </text>
        </g>
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line className="launch-tick" x1={x(t, window)} x2={x(t, window)} y1={18} y2={270} />
          <text className="launch-tick-label" x={x(t, window)} y={296} textAnchor="middle">
            {t === 0 ? 'launch' : t < 60 ? `${t} s` : `${t / 60} min`}
          </text>
        </g>
      ))}
      <line
        className="launch-sweep"
        x1={CHART_LEFT}
        x2={CHART_LEFT}
        y1={14}
        y2={274}
        style={{ '--sweep': `${CHART_WIDTH}px` } as CSSProperties}
      />
      {dots.map(({ burst, move, cx, cy, r }, i) => {
        const state = burst.state;
        const count = burst.moves.length;
        const who =
          count > 1
            ? `${count} addresses`
            : move.actorIsCreator
              ? 'the creator'
              : short(move.actor);
        const from = move.counterpartyIsCreator ? ' from the creator' : '';
        // A count sits above its dot, unless it would run into the previous one.
        const label = count > 1 && !labelled.some((lx) => Math.abs(lx - cx) < 34);
        if (label) labelled.push(cx);
        return (
          <g
            key={`${move.transaction}-${move.actor}-${move.kind}`}
            className="launch-dot"
            data-kind={move.kind}
            data-holding={state}
            data-creator={move.actorIsCreator || undefined}
            style={
              {
                '--at': `${(Math.sqrt(move.seconds / window) * 3.2).toFixed(2)}s`,
                '--i': i,
              } as CSSProperties
            }
          >
            <title>
              {`${when(move.seconds)} · ${KIND_WORD[move.kind]} ${who}${from} · ${pct(burst.share)} · ${HOLDING_WORD[state]}`}
            </title>
            <circle cx={cx} cy={cy} r={r} />
            {(move.actorIsCreator || move.counterpartyIsCreator) && (
              <circle className="launch-creator-ring" cx={cx} cy={cy} r={r + 5} />
            )}
            {label && (
              <text className="launch-count" x={cx} y={cy - r - 7} textAnchor="middle">
                ×{count}
              </text>
            )}
          </g>
        );
      })}
    </svg>
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

  return (
    <section className="launch-replay" aria-labelledby="launch-title">
      <div className="report-section-head">
        <p className="report-kicker">
          {index} — The first {firstSpan}
        </p>
        <h3 id="launch-title">Where the supply went when the token was born.</h3>
        <p className="questions-intro">
          Every move read from the token’s own transfers, from the launch block on. Dots are sized
          by the share of supply they carried; a hollow dot is an address that holds none of it
          today.
        </p>
      </div>
      <Summary launch={launch} />
      <div className="launch-stage">
        <div className="launch-stage-top">
          <span>
            Block {launch.launchBlock.toLocaleString('en-US')}
            {launch.launchedAt &&
              ` · ${new Date(launch.launchedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`}
          </span>
          <button
            type="button"
            className="launch-replay-button"
            onClick={() => setRun((n) => n + 1)}
          >
            Replay <span aria-hidden="true">↻</span>
          </button>
        </div>
        <div className="launch-chart-scroll">
          <Chart launch={launch} run={run} />
        </div>
        <ul className="launch-legend" aria-label="Legend">
          <li data-kind="mint">Created</li>
          <li data-kind="allocation">Passed on</li>
          <li data-kind="buy">Bought</li>
          <li data-kind="sell">Sold</li>
          <li data-kind="liquidity">Liquidity</li>
          <li data-legend="creator">Involves the creator</li>
          <li data-legend="gone">Holds nothing today</li>
        </ul>
      </div>
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
                    <a href={`${EXPLORER}/address/${move.actor}`} target="_blank" rel="noreferrer">
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
      {(launch.moves.length > 8 || launch.movesInWindow > launch.moves.length) && (
        <p className="launch-more">
          {launch.moves.length > 8 && (
            <button type="button" className="text-link" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${launch.moves.length} moves`}
            </button>
          )}
          {launch.movesInWindow > launch.moves.length &&
            ` ${launch.movesInWindow - launch.moves.length} other moves in the window are not drawn: every move of the creator and the largest ones are.`}
        </p>
      )}
    </section>
  );
}
