import type { CSSProperties } from 'react';
import type { ReportFacts, TimelineLaunch } from '@/lib/facts';

/**
 * The measured numbers, drawn. Three cards — creator, holders, market — each
 * showing only what its source observed. There is no overall score: the
 * cards sit side by side and the reader weighs them.
 */

function pct(value: number): string {
  if (value > 0 && value < 0.001) return '<0.1%';
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

/**
 * Source notes are written for the logs ("402", "TokenLaunched"). On a card
 * they are said in plain words; an unknown note is shown as is rather than
 * hidden.
 */
export function plainNote(note: string | undefined): string | undefined {
  if (!note) return undefined;
  if (/not a pons launch/i.test(note))
    return 'Not launched through pons: there is no launch record to trace a creator from.';
  if (/402|no api key/i.test(note)) return 'Not available for this token yet.';
  if (/rate-limit|request limit|could not be read/i.test(note))
    return 'The chain node was busy. Try again in a minute.';
  if (/no pair indexed/i.test(note)) return 'No trading pair listed on DexScreener.';
  if (/too many transfers/i.test(note))
    return 'Too much trading history to rebuild here. This token needs the Blockscout source.';
  if (/start of this token/i.test(note)) return 'The start of this token’s history was not found.';
  return note;
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

export function usd(value: number | null): string {
  if (value === null) return '—';
  if (value >= 999_500) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 999.95) return `$${(value / 1_000).toFixed(1)}k`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value <= 0) return '$0';
  if (value >= 0.0001) return `$${Number(value.toPrecision(4))}`;
  // Memecoin prices: $0.0₆1234 reads where $1.234e-7 does not. The subscript
  // counts the zeros after the decimal point.
  const zeros = -Math.floor(Math.log10(value)) - 1;
  const digits = Math.round(value * 10 ** (zeros + 4))
    .toString()
    .replace(/0+$/, '');
  const count = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)])
    .join('');
  return `$0.0${count}${digits}`;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** A ring: one or two filled arcs over a track. Values are shares from 0 to 1. */
function Ring({
  value,
  inner,
  label,
  caption,
  center,
}: {
  value: number;
  inner?: number;
  label: string;
  caption: string;
  center?: string;
}) {
  const r = 42;
  const arc = (share: number) => `${Math.max(0, Math.min(1, share)) * 100} 100`;
  return (
    <figure className="gauge">
      <div className="gauge-dial">
        <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${caption}`}>
          <circle className="gauge-track" cx="50" cy="50" r={r} pathLength={100} />
          {inner !== undefined && (
            <circle
              className="gauge-soft"
              cx="50"
              cy="50"
              r={r}
              pathLength={100}
              style={{ '--arc': arc(inner) } as CSSProperties}
            />
          )}
          <circle
            className="gauge-value"
            cx="50"
            cy="50"
            r={r}
            pathLength={100}
            style={{ '--arc': arc(value) } as CSSProperties}
          />
        </svg>
        {center && (
          <span className="gauge-center" aria-hidden="true">
            {center}
          </span>
        )}
      </div>
      <figcaption>
        <strong>{label}</strong>
        <span>{caption}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Where the counted supply sits: the largest holder, the next nine, everyone
 * else. Three plain shares of one whole — no threshold is drawn on it.
 */
function Donut({ top1, top10, count }: { top1: number; top10: number; count: number | null }) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const first = clamp(top1);
  const next = clamp(top10 - top1);
  const rest = clamp(1 - first - next);
  const parts = [
    { name: 'Largest holder', share: first, tone: 'accent' },
    { name: 'Holders 2 to 10', share: next, tone: 'soft' },
    { name: 'Everyone else', share: rest, tone: 'faint' },
  ];
  let offset = 0;
  const label = parts.map((p) => `${p.name} ${pct(p.share)}`).join(', ');
  return (
    <figure className="donut">
      <div className="donut-dial">
        <svg viewBox="0 0 100 100" role="img" aria-label={`Counted supply: ${label}`}>
          <circle className="donut-track" cx="50" cy="50" r="40" pathLength={100} />
          {parts.map((p) => {
            const segment = (
              <circle
                key={p.name}
                className={`donut-part donut-${p.tone}`}
                cx="50"
                cy="50"
                r="40"
                pathLength={100}
                style={
                  {
                    '--arc': `${p.share * 100} 100`,
                    strokeDashoffset: -offset * 100,
                  } as CSSProperties
                }
              />
            );
            offset += p.share;
            return segment;
          })}
        </svg>
        <span className="donut-center" aria-hidden="true">
          <strong>{count ?? '—'}</strong>
          <span>holders</span>
        </span>
      </div>
      <figcaption>
        <ul className="donut-legend">
          {parts.map((p) => (
            <li key={p.name}>
              <i className={`donut-key donut-${p.tone}`} aria-hidden="true" />
              <span>{p.name}</span>
              <strong>{pct(p.share)}</strong>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

const OUTCOME_LABEL: Record<TimelineLaunch['outcome'], string> = {
  graduated: 'graduated',
  active: 'active',
  abandoned: 'abandoned',
  undetermined: 'undetermined',
};

/**
 * The creator's launches on one line, oldest on the left. Each mark keeps its
 * own outcome; a sale into the pool or a liquidity removal is marked on the
 * launch it happened to. The token being read is ringed.
 */
function Timeline({ launches }: { launches: TimelineLaunch[] }) {
  if (launches.length < 2) return null;
  const first = launches[0]!.block;
  const last = launches.at(-1)!.block;
  const span = Math.max(1, last - first);
  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
  const from = date(launches[0]!.launchedAt);
  const to = date(launches.at(-1)!.launchedAt);
  return (
    <figure className="timeline">
      <figcaption className="timeline-caption">
        Launches read in detail, in time order{from && to ? ` · ${from} → ${to}` : ''}
      </figcaption>
      <ol className="timeline-track">
        {launches.map((l, i) => {
          const x = 2 + ((l.block - first) / span) * 96;
          const events = [
            l.sold ? 'creator sold into the pool' : '',
            l.pulled ? 'liquidity removed' : '',
          ]
            .filter(Boolean)
            .join(', ');
          return (
            <li
              key={l.address}
              className="timeline-mark"
              data-outcome={l.outcome}
              data-current={l.current || undefined}
              style={{ left: `${x}%`, '--i': i } as CSSProperties}
            >
              <span className="sr-only">
                {`${l.current ? 'This token, ' : ''}launch ${i + 1}${date(l.launchedAt) ? ` on ${date(l.launchedAt)}` : ''}: ${OUTCOME_LABEL[l.outcome]}${events ? `, ${events}` : ''}.`}
              </span>
              {l.sold && <span className="timeline-flag timeline-sold" aria-hidden="true" />}
              {l.pulled && <span className="timeline-flag timeline-pulled" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <ul className="timeline-legend" aria-hidden="true">
        <li>
          <i data-outcome="graduated" /> graduated
        </li>
        <li>
          <i data-outcome="active" /> active
        </li>
        <li>
          <i data-outcome="undetermined" /> undetermined
        </li>
        <li>
          <i data-outcome="abandoned" /> abandoned
        </li>
        <li>
          <i className="timeline-sold" /> creator sold
        </li>
        <li>
          <i className="timeline-pulled" /> liquidity removed
        </li>
        <li>
          <i data-current="true" /> this token
        </li>
      </ul>
    </figure>
  );
}

/** A horizontal bar split into labelled parts. */
function Split({
  parts,
  label,
}: {
  parts: { value: number; tone: string; name: string }[];
  label: string;
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  if (total === 0) return null;
  return (
    <div className="split">
      <div className="split-bar" role="img" aria-label={label}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.name}
              className={`split-part tone-${p.tone}`}
              style={{ flexGrow: p.value }}
            />
          ))}
      </div>
      <ul className="split-legend">
        {parts.map((p) => (
          <li key={p.name}>
            <i className={`tone-${p.tone}`} aria-hidden="true" />
            {p.value} {p.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Missing({ note }: { note?: string }) {
  const plain = plainNote(note);
  return <p className="fact-missing">Not measured{plain ? <span> — {plain}</span> : '.'}</p>;
}

/**
 * How the creator was found, said plainly. A first minter only sent the first
 * mint: that does not prove they wrote the token, and the card says so.
 */
export function creatorOrigin(creator: ReportFacts['creator']): string | null {
  const via = creator.launchContract ? ` through ${short(creator.launchContract)}` : '';
  if (creator.source === 'pons') return 'Found from their pons launch record.';
  switch (creator.role) {
    case 'deployer':
      return 'Deployed the token contract.';
    case 'launcher':
      return `Launched the token${via}.`;
    case 'first-minter':
      return 'Sent the first mint. This does not prove who wrote the token.';
    default:
      return null;
  }
}

function CreatorCard({
  creator,
  timeline,
}: {
  creator: ReportFacts['creator'];
  timeline?: TimelineLaunch[];
}) {
  const wide = creator.measured && (timeline?.length ?? 0) >= 2;
  // A report cached before these counts existed carries only `checked`.
  const salesChecked = creator.salesChecked ?? creator.checked;
  const liquidityChecked = creator.liquidityChecked ?? creator.checked;
  return (
    <section className="fact-card" data-wide={wide || undefined} aria-labelledby="fact-creator">
      <h3 id="fact-creator">Creator</h3>
      {!creator.measured ? (
        <Missing note={creator.note} />
      ) : (
        <>
          <p className="fact-big">
            {creator.launchesListed === false && <span>at least </span>}
            {creator.launched}
            <span> token{creator.launched === 1 ? '' : 's'} launched</span>
          </p>
          {creator.address && (
            <p className="fact-mono">
              {short(creator.address)}
              {creator.transactionCount != null &&
                ` · ${creator.transactionCount} transaction${creator.transactionCount === 1 ? '' : 's'} sent`}
            </p>
          )}
          {creatorOrigin(creator) && <p className="fact-line">{creatorOrigin(creator)}</p>}
          <Split
            label={`Outcomes of ${creator.detailed} launches read in detail`}
            parts={[
              { value: creator.graduated, tone: 'calm', name: 'graduated' },
              { value: creator.active, tone: 'neutral', name: 'active' },
              { value: creator.undetermined, tone: 'faint', name: 'undetermined' },
              { value: creator.abandoned, tone: 'warm', name: 'abandoned' },
            ]}
          />
          {timeline && <Timeline launches={timeline} />}
          {salesChecked + liquidityChecked > 0 && (
            <dl className="fact-pairs">
              <div>
                <dt>Sold into the pool</dt>
                <dd>
                  {salesChecked > 0 ? (
                    <>
                      {creator.soldIntoPool} <span>of {salesChecked} checked</span>
                    </>
                  ) : (
                    <span>not measured</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Liquidity removed</dt>
                <dd>
                  {liquidityChecked > 0 ? (
                    <>
                      {creator.liquidityPulled} <span>of {liquidityChecked} checked</span>
                    </>
                  ) : (
                    <span>not measured</span>
                  )}
                </dd>
              </div>
            </dl>
          )}
          {creator.note && <p className="fact-note">{plainNote(creator.note)}</p>}
        </>
      )}
    </section>
  );
}

function HoldersCard({
  holders,
  creator,
}: {
  holders: ReportFacts['holders'];
  creator: string | null;
}) {
  const largest = holders.top[0]?.share ?? 0;
  return (
    <section className="fact-card" aria-labelledby="fact-holders">
      <h3 id="fact-holders">Holders</h3>
      {!holders.measured ? (
        <Missing note={holders.note} />
      ) : (
        <>
          <Donut top1={holders.top1} top10={holders.top10} count={holders.holderCount} />
          <p className="sr-only">{`Concentration: largest ${pct(holders.top1)} · top 10 ${pct(holders.top10)}`}</p>
          {holders.holderCount !== null && (
            <p className="fact-line">
              <strong>{holders.holderCount}</strong> holders outside pools and burn addresses
            </p>
          )}
          {holders.note && <p className="fact-note">{plainNote(holders.note)}</p>}
          {holders.top.length > 0 && (
            <ol className="holder-bars" aria-label="Largest holders">
              {holders.top.map((h) => (
                <li key={h.address}>
                  <span className="fact-mono">
                    {short(h.address)}
                    {creator && h.address.toLowerCase() === creator.toLowerCase()
                      ? ' · creator'
                      : h.kind === 'contract'
                        ? ' · contract'
                        : ''}
                  </span>
                  <span className="holder-track" aria-hidden="true">
                    <span
                      className="holder-fill"
                      style={{ width: `${largest > 0 ? (h.share / largest) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="holder-share">{pct(h.share)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function MarketCard({ market }: { market: ReportFacts['market'] }) {
  const trades = (market.buys24h ?? 0) + (market.sells24h ?? 0);
  return (
    <section className="fact-card" aria-labelledby="fact-market">
      <h3 id="fact-market">Market</h3>
      {market.graduation && (
        <Ring
          value={market.graduation.progress}
          label={market.graduation.graduated ? 'Graduated' : 'Graduation'}
          caption={`${pct(market.graduation.progress)} of ${market.graduation.thresholdEth} ETH`}
          center={pct(market.graduation.progress)}
        />
      )}
      {!market.measured ? (
        <Missing note={market.note} />
      ) : (
        <>
          <dl className="fact-pairs">
            <div>
              <dt>Price</dt>
              <dd>{usd(market.priceUsd)}</dd>
            </div>
            <div>
              <dt>Liquidity</dt>
              <dd>{usd(market.liquidityUsd)}</dd>
            </div>
            <div>
              <dt>Volume 24h</dt>
              <dd>{usd(market.volume24hUsd)}</dd>
            </div>
            <div>
              <dt>FDV</dt>
              <dd>{usd(market.fdvUsd)}</dd>
            </div>
          </dl>
          {trades > 0 && (
            <Split
              label={`${market.buys24h ?? 0} buys and ${market.sells24h ?? 0} sells in 24 hours`}
              parts={[
                { value: market.buys24h ?? 0, tone: 'calm', name: 'buys' },
                { value: market.sells24h ?? 0, tone: 'warm', name: 'sells' },
              ]}
            />
          )}
        </>
      )}
    </section>
  );
}

export function FactsBoard({
  facts,
  timeline,
}: {
  facts: ReportFacts;
  timeline?: TimelineLaunch[];
}) {
  return (
    <section className="facts-section" aria-labelledby="facts-title">
      <div className="report-section-head">
        <p className="report-kicker">01 — Measured</p>
        <h3 id="facts-title">What the chain and the market show.</h3>
      </div>
      <div className="facts-board" role="region" aria-label="Measured facts">
        <CreatorCard creator={facts.creator} timeline={timeline} />
        <HoldersCard holders={facts.holders} creator={facts.creator.address} />
        <MarketCard market={facts.market} />
      </div>
    </section>
  );
}
