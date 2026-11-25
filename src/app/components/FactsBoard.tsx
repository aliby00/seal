import { readableNote } from '@/lib/plain-note';
import type { CSSProperties } from 'react';
import type { ReportFacts, TimelineLaunch } from '@/lib/facts';
import { whereSetAside } from '@/lib/set-aside';
import { creatorFrom } from './creator-from';
import { addressUrl, short } from './explorer';
import type { SolanaView } from './solana-view';

/**
 * The measured numbers, drawn. Three cards — creator, holders, market — each
 * showing only what its source observed. There is no overall score: the
 * cards sit side by side and the reader weighs them.
 */

function pct(value: number): string {
  if (value > 0 && value < 0.001) return '<0.1%';
  // 99.96% rounded would read as the whole supply.
  if (value > 0.999 && value < 1) return '>99.9%';
  // Above 99 %, one decimal: 99.79 % rounded to "100%" would sit next to "the other 0.2%".
  return `${(value * 100).toFixed(value < 0.1 || (value > 0.99 && value < 1) ? 1 : 0)}%`;
}

/**
 * Source notes are written for the logs ("402", "TokenLaunched"). On a card
 * they are said in plain words; an unknown note is shown as is rather than
 * hidden.
 */
export function plainNote(note: string | undefined): string | undefined {
  if (!note) return undefined;
  if (/no launch record found/i.test(note))
    return 'No launch record names a creator, and the transaction that created the mint was not found.';
  if (/402|no api key/i.test(note)) return 'Not available for this token yet.';
  // A large token on a node that refuses the largest accounts (the public one): no list at all.
  if (/largest token accounts not read/i.test(note))
    return 'Too many token accounts to read them all, and the chain node used does not list the largest ones: the holders could not be read this time.';
  if (/rate-limit|request limit|could not be read/i.test(note))
    return 'The chain node was busy. Try again in a minute.';
  if (/no pair indexed/i.test(note)) return 'No trading pair listed on DexScreener.';
  if (/too many transfers/i.test(note)) return 'Too much trading history to rebuild here.';
  if (/start of this token/i.test(note)) return 'The start of this token’s history was not found.';
  return readableNote(note, { sentence: true });
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

/**
 * On Solana, `abandoned` is a token launched over a day ago with no trade in
 * the last 24 hours on any market DexScreener lists: said as such.
 */
const OUTCOME_LABEL: Record<TimelineLaunch['outcome'], string> = {
  graduated: 'graduated',
  active: 'traded in the last 24 h',
  abandoned: 'no trade in the last 24 h',
  undetermined: 'not known',
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
          const events = [l.sold ? 'the creator sold' : '', l.pulled ? 'liquidity removed' : '']
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
          <i data-outcome="active" /> traded in the last 24 h
        </li>
        <li>
          <i data-outcome="undetermined" /> not known
        </li>
        <li>
          <i data-outcome="abandoned" /> no trade in the last 24 h
        </li>
        <li>
          <i className="timeline-sold" /> creator sold
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
 * How the creator was found, said plainly. A fee payer only paid for the
 * transaction that created the mint: that does not prove who made the token,
 * and the card says so, launchpad or not. On Solana, `launch-record` is the
 * `creator` field of the pump.fun bonding curve; an origin the facts do not
 * name (the metadata's update authority) is said by the Solana creator card.
 */
export function creatorOrigin(creator: ReportFacts['creator']): string | null {
  if (creator.creatorFrom === 'launch-record') {
    return creator.launchpad === 'pump.fun'
      ? 'Named as creator by the token’s pump.fun bonding curve.'
      : `Named as creator by its ${creator.launchpad ?? 'launch'} record.`;
  }
  if (creator.creatorFrom === 'transaction') {
    return 'Paid for the transaction that created the mint. A launch service can pay it: this does not prove who made the token.';
  }
  if (creator.launchpad) return null;
  switch (creator.role) {
    case 'deployer':
      return 'Created the token.';
    case 'launcher':
      return `Launched the token${creator.launchContract ? ` through ${short(creator.launchContract)}` : ''}.`;
    case 'first-minter':
      return 'Received the first tokens. This does not prove who made the token.';
    default:
      return null;
  }
}

function Address({ address }: { address: string }) {
  return (
    <a
      className="sol-address"
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {short(address)}
    </a>
  );
}

/**
 * Whether the creator's launches were all listed. `launchesListed` only says
 * the pump.fun curves were; the Solana history also says whether the
 * creator's own transactions were all reached and read.
 */
export function launchesComplete(creator: ReportFacts['creator'], solana?: SolanaView): boolean {
  if (creator.launchesListed === false || (creator.notListed?.length ?? 0) > 0) return false;
  if (!solana) return true;
  const history = solana.history;
  return history !== null && history.read === 'full' && history.data.historyComplete;
}

function CreatorCard({
  creator,
  timeline,
  solana,
}: {
  creator: ReportFacts['creator'];
  timeline?: TimelineLaunch[];
  solana?: SolanaView;
}) {
  const wide = creator.measured && (timeline?.length ?? 0) >= 2;
  // The analysed token is in the counts only when its own curve is complete.
  const ownCounted = solana?.graduation?.data.graduated === true;
  // The facts do not name every origin (the metadata's update authority): the Solana creator does.
  const origin = creatorOrigin(creator) ?? (solana ? creatorFrom(solana.creator.data.from) : null);
  return (
    <section className="fact-card" data-wide={wide || undefined} aria-labelledby="fact-creator">
      <h3 id="fact-creator">Creator</h3>
      {!creator.measured ? (
        <Missing note={creator.note} />
      ) : !creator.address ? (
        // A creator read in full may still find nobody named: no count to draw.
        <p className="fact-line">Nothing on the chain names a creator for this token.</p>
      ) : (
        <>
          <p className="fact-big">
            {creator.launched}
            <span>
              {' '}
              token{creator.launched === 1 ? '' : 's'} launched, this one included
              {launchesComplete(creator, solana) ? '' : ', from what could be listed'}
            </span>
          </p>
          {creator.address && (
            <p className="fact-mono">
              <Address address={creator.address} />
              {creator.transactionCount != null &&
                ` · ${creator.transactionCount} transaction${creator.transactionCount === 1 ? '' : 's'} sent`}
            </p>
          )}
          {origin && <p className="fact-line">{origin}</p>}
          {(creator.graduation ?? 'measured') === 'measured' ? (
            <Split
              label={`Outcomes of the ${creator.detailed} other tokens read in detail${solana && !ownCounted ? '' : ', and this one'}`}
              parts={[
                { value: creator.graduated, tone: 'calm', name: 'graduated' },
                { value: creator.active, tone: 'neutral', name: 'traded in 24 h' },
                { value: creator.undetermined, tone: 'faint', name: 'not known' },
                { value: creator.abandoned, tone: 'warm', name: 'no trade in 24 h' },
              ]}
            />
          ) : (
            <p className="fact-line">{graduationLine(creator)}</p>
          )}
          {timeline && <Timeline launches={timeline} />}
          {creator.salesChecked > 0 && (
            <p className="fact-line">
              {creator.soldIntoPool > 0
                ? 'The creator sold some of this token.'
                : 'The creator sold none of this token, in every move read.'}
            </p>
          )}
          {(creator.notListed?.length ?? 0) > 0 && (
            <p className="fact-note">Not listed: {creator.notListed?.join(', ')}.</p>
          )}
          {creator.note && <p className="fact-note">{plainNote(creator.note)}</p>}
        </>
      )}
    </section>
  );
}

/** Why there is no graduation split: not read here, or no curve for this token. */
export function graduationLine(creator: ReportFacts['creator']): string {
  return creator.graduation === 'not-applicable'
    ? 'Graduation does not apply: no launch curve held this token.'
    : `Graduation is read on pump.fun, Meteora DBC and Raydium LaunchLab curves: not measured${creator.launchpad ? ` on ${creator.launchpad}` : ' here'}.`;
}

function HoldersCard({
  holders,
  creator,
  names,
  listRead = true,
}: {
  holders: ReportFacts['holders'];
  creator: string | null;
  /** What the chain names an address, by address (case kept). */
  names: Record<string, string>;
  /**
   * Whether a holders list was read at all. A partial read with no list (a
   * large token on a node that refuses the largest accounts) has nothing to
   * draw: its zeros would read as a fact about the token.
   */
  listRead?: boolean;
}) {
  const largest = holders.top[0]?.share ?? 0;
  return (
    <section className="fact-card" aria-labelledby="fact-holders">
      <h3 id="fact-holders">Holders</h3>
      {!holders.measured || !listRead ? (
        <Missing note={holders.note} />
      ) : (
        <>
          {holders.pooled != null && holders.pooled > 0 && (
            <p className="fact-pooled">
              <strong>{pct(holders.pooled)}</strong> of the supply sits in{' '}
              {whereSetAside(holders.setAside)}. The shares below split the other{' '}
              {pct(1 - holders.pooled)}, held in wallets and other accounts.
            </p>
          )}
          <Donut top1={holders.top1} top10={holders.top10} count={holders.holderCount} />
          <p className="sr-only">{`Concentration: largest ${pct(holders.top1)} · top 10 ${pct(holders.top10)}`}</p>
          {holders.holderCount !== null && (
            <p className="fact-line">
              <strong>{holders.holderCount}</strong> holders outside curves, pools, locks and burn
              addresses
            </p>
          )}
          {holders.note && <p className="fact-note">{plainNote(holders.note)}</p>}
          {holders.top.length > 0 && (
            <ol className="holder-bars" aria-label="Largest holders">
              {holders.top.map((h) => (
                <li key={h.address}>
                  <span className="fact-mono">
                    <Address address={h.address} />
                    {creator && h.address === creator
                      ? ' · creator'
                      : names[h.address]
                        ? ` · ${names[h.address]}`
                        : h.kind === 'contract'
                          ? ' · program account'
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

const BASIS_WORD = {
  'tokens-sold': 'of the curve’s tokens sold',
  'quote-raised': 'of the target raised',
} as const;

function MarketCard({ market, solana }: { market: ReportFacts['market']; solana?: SolanaView }) {
  const trades = (market.buys24h ?? 0) + (market.sells24h ?? 0);
  const graduation = solana?.graduation?.data;
  const listed = solana?.market.data;
  return (
    <section className="fact-card" aria-labelledby="fact-market">
      <h3 id="fact-market">Market</h3>
      {graduation && (graduation.graduated || graduation.progress !== null) && (
        <Ring
          value={graduation.graduated ? 1 : (graduation.progress ?? 0)}
          label={graduation.graduated ? 'Graduated' : 'On its curve'}
          caption={
            graduation.graduated
              ? `Left its ${solana?.launchpad.data?.name ?? 'launch'} curve${graduation.destination ? ` for ${graduation.destination.name}` : ''}`
              : `${pct(graduation.progress ?? 0)}${graduation.basis ? ` ${BASIS_WORD[graduation.basis]}` : ''}`
          }
          center={graduation.graduated ? '100%' : pct(graduation.progress ?? 0)}
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
              <dd>{market.staleLiquidity ? 'not current' : usd(market.liquidityUsd)}</dd>
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
          {listed?.pair && (
            <p className="fact-mono">
              Main pair{listed.dex ? ` on ${listed.dex}` : ''}
              {listed.pairedWith ? ` against ${listed.pairedWith}` : ''}:{' '}
              <Address address={listed.pair} />
              {listed.pair === solana?.launchpad.data?.account ? ', its launch curve' : ''}
            </p>
          )}
          {market.staleLiquidity && (
            <p className="fact-note">
              DexScreener lists {usd(market.staleLiquidity.listedUsd)} of liquidity, but the token’s
              pools hold {pct(market.staleLiquidity.poolsShare)} of its supply on chain today: that
              figure is not current.
            </p>
          )}
          {market.quietHours != null && (
            <p className="fact-line">
              No trade in the last {market.quietHours === 1 ? 'hour' : `${market.quietHours} hours`}
              .
            </p>
          )}
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

/** What the chain names each address of the reading (curves, pools, locks), by address. */
export function namesOf(solana: SolanaView | undefined): Record<string, string> {
  const names: Record<string, string> = {};
  if (!solana) return names;
  for (const s of solana.holders.data.setAside) if (s.name) names[s.address] = s.name;
  for (const h of solana.holders.data.top) if (h.name) names[h.address] = h.name;
  return names;
}

export function FactsBoard({
  facts,
  timeline,
  solana,
  index = '02',
}: {
  facts: ReportFacts;
  timeline?: TimelineLaunch[];
  /** The Solana blocks, when the response carries them. */
  solana?: SolanaView;
  /** Section number in the report. */
  index?: string;
}) {
  return (
    <section className="facts-section" aria-labelledby="facts-title">
      <div className="report-section-head">
        <p className="report-kicker">{index} — Measured</p>
        <h3 id="facts-title">What the chain and the market show.</h3>
      </div>
      <div className="facts-board" role="region" aria-label="Measured facts">
        <CreatorCard creator={facts.creator} timeline={timeline} solana={solana} />
        <HoldersCard
          holders={facts.holders}
          creator={facts.creator.address}
          names={namesOf(solana)}
          listRead={
            solana
              ? solana.holders.data.method !== 'none'
              : facts.holders.top.length > 0 || facts.holders.holderCount !== null
          }
        />
        <MarketCard market={facts.market} solana={solana} />
      </div>
    </section>
  );
}
