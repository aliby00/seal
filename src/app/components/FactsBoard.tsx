import type { ReportFacts } from '@/lib/facts';

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

function usd(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  // Tiny prices: keep four significant digits rather than show $0.00.
  return `$${value.toPrecision(4)}`;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** A ring: one or two filled arcs over a track. Values are shares from 0 to 1. */
function Ring({
  value,
  inner,
  label,
  caption,
}: {
  value: number;
  inner?: number;
  label: string;
  caption: string;
}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const arc = (share: number) => `${Math.max(0, Math.min(1, share)) * c} ${c}`;
  return (
    <figure className="gauge">
      <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${caption}`}>
        <circle className="gauge-track" cx="50" cy="50" r={r} />
        {inner !== undefined && (
          <circle className="gauge-soft" cx="50" cy="50" r={r} strokeDasharray={arc(inner)} />
        )}
        <circle className="gauge-value" cx="50" cy="50" r={r} strokeDasharray={arc(value)} />
      </svg>
      <figcaption>
        <strong>{label}</strong>
        <span>{caption}</span>
      </figcaption>
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

function CreatorCard({ creator }: { creator: ReportFacts['creator'] }) {
  return (
    <section className="fact-card" aria-labelledby="fact-creator">
      <h3 id="fact-creator">Creator</h3>
      {!creator.measured ? (
        <Missing note={creator.note} />
      ) : (
        <>
          <p className="fact-big">
            {creator.launched}
            <span> token{creator.launched === 1 ? '' : 's'} launched</span>
          </p>
          {creator.address && <p className="fact-mono">{short(creator.address)}</p>}
          <Split
            label={`Outcomes of ${creator.detailed} launches read in detail`}
            parts={[
              { value: creator.graduated, tone: 'calm', name: 'graduated' },
              { value: creator.active, tone: 'neutral', name: 'active' },
              { value: creator.undetermined, tone: 'faint', name: 'undetermined' },
              { value: creator.abandoned, tone: 'warm', name: 'abandoned' },
            ]}
          />
          {creator.checked > 0 && (
            <dl className="fact-pairs">
              <div>
                <dt>Sold into the pool</dt>
                <dd>
                  {creator.soldIntoPool} / {creator.checked}
                </dd>
              </div>
              <div>
                <dt>Liquidity removed</dt>
                <dd>
                  {creator.liquidityPulled} / {creator.checked}
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
          <Ring
            value={holders.top1}
            inner={holders.top10}
            label="Concentration"
            caption={`largest ${pct(holders.top1)} · top 10 ${pct(holders.top10)}`}
          />
          {holders.note && <p className="fact-note">{plainNote(holders.note)}</p>}
          {holders.holderCount !== null && (
            <p className="fact-line">
              <strong>{holders.holderCount}</strong> holders outside pools and burn addresses
            </p>
          )}
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
              label={`${market.buys24h} buys and ${market.sells24h} sells in 24 hours`}
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

export function FactsBoard({ facts }: { facts: ReportFacts }) {
  return (
    <section className="facts-board" aria-label="Measured facts">
      <CreatorCard creator={facts.creator} />
      <HoldersCard holders={facts.holders} creator={facts.creator.address} />
      <MarketCard market={facts.market} />
    </section>
  );
}
