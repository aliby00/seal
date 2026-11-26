import type { ReactNode } from 'react';
import { creatorFrom } from './creator-from';
import { plainNote } from './FactsBoard';
import { addressUrl, extensionWords, short, txUrl } from './explorer';
import { clockOf, Flash, LiveStamp, type LiveTimes } from './LiveStamp';
import type {
  FundedView,
  GroupView,
  MoveView,
  OtherTokenView,
  PoolView,
  PowerView,
  SolanaView,
  ViewBlock,
} from './solana-view';

/**
 * The Solana blocks of a reading, drawn: what the mint lets someone do, where
 * the supply sits by role, what became of the pools' liquidity, the launch,
 * and the creator — what they did with this token, their other tokens, the
 * wallets they sent SOL to. Facts only: each line says what the chain shows
 * and links to it; what was not read is said, never drawn as zero.
 */

export function pct(value: number | null): string {
  if (value === null) return 'not read';
  if (value === 0) return '0%';
  if (value > 0 && value < 0.001) return '<0.1%';
  if (value > 0.999 && value < 1) return '>99.9%';
  // Above 99 %, one decimal: 99.79 % is not the whole supply.
  return `${(value * 100).toFixed(value < 0.1 || (value > 0.99 && value < 1) ? 1 : 0)}%`;
}

/** A raw amount in whole tokens, compact: "1B", "983.99M". */
export function tokens(raw: string, decimals: number): string {
  try {
    const whole = Number(BigInt(raw) / 10n ** BigInt(decimals));
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(
      whole,
    );
  } catch {
    return raw;
  }
}

export function sol(value: number | null): string {
  if (value === null) return 'not read';
  if (value === 0) return '0 SOL';
  // Dust (a few thousand lamports) would print as "1e-7 SOL".
  if (value < 0.001) return '<0.001 SOL';
  return `${value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : Number(value.toPrecision(2))} SOL`;
}

/** "2026-11-24 21:58 UTC". */
export function when(at: string | null): string {
  return at ? `${at.slice(0, 16).replace('T', ' ')} UTC` : 'time not read';
}

const POWER_TITLE: Record<PowerView['power'], string> = {
  mint: 'Create more tokens',
  freeze: 'Freeze holders’ accounts',
  'permanent-delegate': 'Move or burn any holder’s tokens',
  pause: 'Pause all transfers',
  'transfer-hook': 'Run a program on every transfer',
  'transfer-fee': 'Fee on every transfer',
  'transfer-fee-change': 'Change the transfer fee',
  'default-account-state': 'State of new accounts',
  'non-transferable': 'Transfers',
  'close-mint': 'Close the mint',
  'interest-rate': 'Interest rate',
  'ui-multiplier': 'Displayed amount multiplier',
  'confidential-transfers': 'Confidential transfers',
  'confidential-mint-burn': 'Confidential mint and burn',
  'permissioned-burn': 'Burns need a permission',
  'metadata-update': 'Change name, symbol and link',
  'metadata-pointer': 'Point to other metadata',
  unknown: 'Extension not decoded',
};

export const powerTitle = (power: PowerView['power']) => POWER_TITLE[power] ?? power;

const STATUS_WORD: Record<PowerView['status'], string> = {
  held: 'Held',
  unknown: 'Not read',
  fixed: 'Fixed rule',
  none: 'Nobody',
};

const STATUS_ORDER: Record<PowerView['status'], number> = {
  held: 0,
  unknown: 1,
  fixed: 2,
  none: 3,
};

/** Held powers first, then the unread, the fixed rules, and those nobody holds. */
export function sortedPowers(powers: readonly PowerView[]): PowerView[] {
  return [...powers].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

export { creatorFrom };

const OUTCOME_WORD: Record<OtherTokenView['outcome'], string> = {
  graduated: 'graduated',
  active: 'traded in the last 24 h',
  dead: 'no trade in the last 24 h',
  unknown: 'not known',
};

export const outcomeWord = (outcome: OtherTokenView['outcome']) => OUTCOME_WORD[outcome];

const MOVE_WORD: Record<MoveView['kind'], string> = {
  buy: 'Bought',
  sell: 'Sold',
  locked: 'Locked',
  unlocked: 'Unlocked',
  sent: 'Sent',
  received: 'Received',
  burned: 'Burned',
  provided: 'Put into a pool as liquidity',
  withdrawn: 'Taken out of a pool',
};

const ROLE_WORD: Record<string, string> = {
  pool: 'Pool',
  curve: 'Bonding curve',
  launchpad: 'Launchpad',
  locker: 'Lock',
  // holders.ts files every lock program (Jupiter Lock, Streamflow) under this role.
  vesting: 'Lock or vesting',
  burn: 'Burned',
};

const BASIS_WORD = {
  'tokens-sold': 'of the curve’s tokens sold',
  'quote-raised': 'of the target raised',
} as const;

function Address({ address, label }: { address: string; label?: string }) {
  return (
    <a
      className="sol-address"
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {label ?? short(address)}
    </a>
  );
}

function Tx({ signature, children }: { signature: string; children?: ReactNode }) {
  return (
    <a
      className="sol-address"
      href={txUrl(signature)}
      target="_blank"
      rel="noreferrer"
      title={signature}
    >
      {children ?? short(signature, 6)}
    </a>
  );
}

/** What a block's completeness means for the reader, when it is not complete. */
function ReadNote({ block }: { block: Pick<ViewBlock<unknown>, 'read' | 'note'> }) {
  const plain = plainNote(block.note);
  if (block.read === 'full') return plain ? <p className="fact-note">{plain}</p> : null;
  return (
    <p className="fact-note">
      {block.read === 'partial' ? 'Partly read' : 'Not read'}
      {plain ? ` — ${plain}` : '.'}
    </p>
  );
}

function Card({
  id,
  title,
  children,
  wide,
}: {
  id: string;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section
      className="fact-card"
      id={id}
      data-wide={wide || undefined}
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`}>{title}</h3>
      {children}
    </section>
  );
}

function MintCard({ view }: { view: SolanaView }) {
  const mint = view.mint.data;
  const powers = sortedPowers(view.powers);
  return (
    <Card id="fact-mint" title="Mint and powers" wide>
      {!mint ? (
        <ReadNote block={view.mint} />
      ) : (
        <>
          <dl className="fact-pairs">
            <div>
              <dt>Program</dt>
              <dd>{mint.program === 'token-2022' ? 'Token-2022' : 'SPL Token'}</dd>
            </div>
            <div>
              <dt>Supply</dt>
              <dd>
                {tokens(mint.supply, mint.decimals)} <span>{mint.decimals} decimals</span>
              </dd>
            </div>
          </dl>
          {mint.extensions.length > 0 && (
            <ul className="sol-chips" aria-label="Token-2022 extensions">
              {mint.extensions.map((name, i) => (
                <li key={`${name}-${i}`} title={name}>
                  {extensionWords(name)}
                </li>
              ))}
            </ul>
          )}
          {mint.metadata && (
            <p className="fact-line">
              Named{' '}
              {mint.metadata.name ?? (mint.metadata.withheld ? '(not shown)' : 'without a name')}
              {mint.metadata.symbol ? ` (${mint.metadata.symbol})` : ''} in its{' '}
              {mint.metadata.from === 'metaplex' ? 'Metaplex metadata' : 'Token-2022 metadata'}.
              {mint.metadata.withheld
                ? ' A name or symbol it carries reads as a verdict or advice: SEAL does not repeat it.'
                : ''}
              {mint.metadata.mutable ? (
                mint.metadata.updateAuthority ? (
                  <>
                    {' '}
                    <Address address={mint.metadata.updateAuthority} /> can still change it.
                  </>
                ) : (
                  ' It can still be changed.'
                )
              ) : (
                ' Nobody can change it.'
              )}
            </p>
          )}
          {powers.length > 0 && (
            <ul className="sol-powers" aria-label="What the mint lets someone do">
              {powers.map((p) => (
                <li key={`${p.power}-${p.holder ?? ''}`} data-status={p.status}>
                  <span className="sol-power-head">
                    <strong>{powerTitle(p.power)}</strong>
                    <span className="sol-status">{STATUS_WORD[p.status]}</span>
                  </span>
                  <span className="sol-power-sentence">{p.sentence}</span>
                  {p.holder && (
                    <span className="fact-mono">
                      Holder: <Address address={p.holder} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {mint.gaps.length > 0 && (
            <p className="fact-note">Not decoded: {mint.gaps.join('; ')}.</p>
          )}
          {view.mint.read !== 'full' && <ReadNote block={view.mint} />}
        </>
      )}
    </Card>
  );
}

function HoldersStamp({ live }: { live?: LiveTimes }) {
  return live ? (
    <LiveStamp at={live.holdersAt} collectedAt={live.collectedAt} paused={live.paused} />
  ) : null;
}

function SupplyCard({ view, live }: { view: SolanaView; live?: LiveTimes }) {
  const h = view.holders;
  const of = h.data.ofSupply;
  const rows: { label: string; value: number | null }[] = [
    { label: 'Largest wallet', value: of.largestWallet },
    { label: '10 largest wallets', value: of.top10Wallets },
    { label: 'On a bonding curve', value: of.curves },
    { label: 'In pools', value: of.pools },
    { label: 'Locked', value: of.locked },
    { label: 'Burned', value: of.burned },
  ];
  const shown = rows.filter((r) => r.value !== null && r.value > 0);
  return (
    <Card id="fact-roles" title="Supply by role">
      {h.read === 'unavailable' || h.data.method === 'none' ? (
        <ReadNote block={h} />
      ) : (
        <>
          <HoldersStamp live={live} />
          <p className="fact-line">
            {h.data.holderCount !== null ? (
              <>
                <strong>
                  <Flash value={h.data.holderCount.toLocaleString('en-US')} />
                </strong>{' '}
                holders
              </>
            ) : (
              <>
                At least <strong>{h.data.holdersAtLeast.toLocaleString('en-US')}</strong> holders
              </>
            )}{' '}
            outside curves, pools, locks and burn addresses
            {h.data.method === 'largest-accounts' ? ', from the largest accounts only' : ''}.
          </p>
          {shown.length > 0 && (
            <ol className="holder-bars" aria-label="Parts of the whole supply">
              {shown.map((r) => (
                <li key={r.label}>
                  <span>{r.label}</span>
                  <span className="holder-track" aria-hidden="true">
                    <span
                      className="holder-fill"
                      style={{ width: `${Math.min(1, r.value ?? 0) * 100}%` }}
                    />
                  </span>
                  <span className="holder-share">
                    <Flash value={pct(r.value)} />
                  </span>
                </li>
              ))}
            </ol>
          )}
          {shown.length > 0 && <p className="fact-note">Shares of the whole supply.</p>}
          {h.data.creator && (
            <p className="fact-line">
              The creator, <Address address={h.data.creator.address} />, holds{' '}
              <Flash value={pct(h.data.creator.ofSupply)} /> of the supply today.
            </p>
          )}
          {h.data.setAside.length > 0 && (
            <ul className="sol-list" aria-label="Set aside from the holders">
              {h.data.setAside.map((s) => (
                <li key={s.address}>
                  <span>{s.name ?? ROLE_WORD[s.role] ?? s.role}</span>
                  <Address address={s.address} />
                  <strong>{pct(s.share)}</strong>
                </li>
              ))}
            </ul>
          )}
          <ReadNote block={h} />
        </>
      )}
    </Card>
  );
}

function PoolRow({ pool }: { pool: PoolView }) {
  const parts = [
    { name: 'burned', value: pool.burned, tone: 'calm' },
    { name: 'locked', value: pool.locked, tone: 'neutral' },
    { name: 'withdrawable by its holders', value: pool.withdrawable, tone: 'warm' },
  ];
  const known = parts.filter((p): p is typeof p & { value: number } => p.value !== null);
  return (
    <li className="sol-pool">
      <span className="sol-pool-head">
        <strong>{pool.type}</strong> <Address address={pool.pool} />
      </span>
      {pool.known && known.length > 0 ? (
        <div className="split">
          <div
            className="split-bar"
            role="img"
            aria-label={known.map((p) => `${pct(p.value)} ${p.name}`).join(', ')}
          >
            {known
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
            {known.map((p) => (
              <li key={p.name}>
                <i className={`tone-${p.tone}`} aria-hidden="true" />
                {pct(p.value)} {p.name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <span className="fact-note">
          {pool.note ? plainNote(pool.note) : 'Its liquidity was not read.'}
        </span>
      )}
    </li>
  );
}

function LiquidityCard({ view }: { view: SolanaView }) {
  const l = view.liquidity;
  // The pools come from DexScreener's list: with none listed there is nothing to
  // read (a token still on its curve), which is a fact about the token — unless
  // the market read itself failed, and then the pools are simply unknown.
  const noPool = l.data.pools.length === 0 && /no pool to read/i.test(l.note ?? '');
  const marketFailed = view.failed.some((f) => f.read === 'market');
  return (
    <Card id="fact-liquidity" title="Liquidity by pool">
      {noPool && marketFailed ? (
        <p className="fact-line">
          The token’s pools could not be listed: the market read failed this time.
        </p>
      ) : noPool ? (
        <p className="fact-line">
          {view.launchpad.data
            ? 'DexScreener lists no trading pool for this token other than its launch curve: there is no pool liquidity to read.'
            : 'DexScreener lists no trading pool for this token: there is no pool liquidity to read.'}
        </p>
      ) : l.data.pools.length === 0 ? (
        <p className="fact-line">
          {l.read === 'unavailable'
            ? 'The pools could not be read.'
            : 'No pool was read for this token.'}
        </p>
      ) : (
        <ul className="sol-pools">
          {l.data.pools.map((p) => (
            <PoolRow key={p.pool} pool={p} />
          ))}
        </ul>
      )}
      {/* Each pool already says why its liquidity was not read. */}
      {!noPool && !l.data.pools.every((p) => !p.known && p.note) && <ReadNote block={l} />}
      {noPool && marketFailed && <ReadNote block={view.market} />}
    </Card>
  );
}

function Group({ group, what }: { group: GroupView; what: string }) {
  return (
    <p className="fact-line">
      <strong>{group.wallets}</strong> wallet{group.wallets === 1 ? '' : 's'} other than the creator
      got {pct(group.share)} of the supply {what}
      {group.heldNow === null
        ? '; what they hold today was not read'
        : group.unread > 0
          ? `; today ${pct(group.heldNow)} is held by the ${group.wallets - group.unread} of them read (${group.unread} not read)`
          : `; they hold ${pct(group.heldNow)} today`}
      {group.soldInWindow > 0 ? `; ${group.soldInWindow} sold in the window read` : ''}.
    </p>
  );
}

function LaunchCard({ view }: { view: SolanaView }) {
  const pad = view.launchpad.data;
  const grad = view.graduation?.data;
  const creation = view.launch.data.creation ?? view.creator.data.creation;
  return (
    <Card id="fact-launch" title="Launch">
      {pad ? (
        <p className="fact-line">
          Launched on <strong>{pad.name}</strong>
          {pad.account ? (
            <>
              {' '}
              · <Address address={pad.account} />
            </>
          ) : null}
          .
        </p>
      ) : view.launchpad.read === 'unavailable' ? (
        <ReadNote block={view.launchpad} />
      ) : (
        <p className="fact-line">
          No pump.fun, Meteora DBC or Raydium LaunchLab curve holds this token.
        </p>
      )}
      {grad && (
        <>
          {grad.graduated ? (
            <p className="fact-line">
              Graduated from its curve
              {grad.destination ? (
                <>
                  {' '}
                  to {grad.destination.name}: <Address address={grad.destination.pool} />
                </>
              ) : null}
              .
            </p>
          ) : grad.progress !== null ? (
            <div className="sol-progress">
              <span className="holder-track" aria-hidden="true">
                <span
                  className="holder-fill"
                  style={{ width: `${Math.min(1, grad.progress) * 100}%` }}
                />
              </span>
              <span>
                Still on its curve: {pct(grad.progress)}
                {grad.basis ? ` ${BASIS_WORD[grad.basis]}` : ''}.
              </span>
            </div>
          ) : (
            <p className="fact-line">Its progress on the curve was not read.</p>
          )}
        </>
      )}
      {creation ? (
        <dl className="fact-pairs">
          <div>
            <dt>Created</dt>
            <dd>
              <span>{when(creation.at)}</span>
            </dd>
          </div>
          <div>
            <dt>Slot</dt>
            <dd>{creation.slot.toLocaleString('en-US')}</dd>
          </div>
          <div>
            <dt>Transaction</dt>
            <dd>
              <Tx signature={creation.signature} />
            </dd>
          </div>
          <div>
            <dt>Paid by</dt>
            <dd>
              <Address address={creation.payer} />
            </dd>
          </div>
        </dl>
      ) : (
        <p className="fact-note">The transaction that created the mint was not found.</p>
      )}
      {view.launch.data.sameSlot && (
        <Group group={view.launch.data.sameSlot} what="in the creation slot" />
      )}
      {view.launch.data.payerGroup && (
        <Group
          group={view.launch.data.payerGroup}
          what="in transactions paid by the creation’s fee payer or the creator"
        />
      )}
      {view.launch.read !== 'full' && <ReadNote block={view.launch} />}
    </Card>
  );
}

function Amount({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value === null ? <span>not read</span> : <Flash value={pct(value)} />}</dd>
    </div>
  );
}

function CreatorTokenCard({ view, live }: { view: SolanaView; live?: LiveTimes }) {
  const creator = view.creator.data;
  const on = view.onToken;
  return (
    <Card id="fact-creator-token" title="Creator and this token">
      {!creator.address ? (
        <>
          <p className="fact-line">Nothing on the chain names a creator for this token.</p>
          <ReadNote block={view.creator} />
        </>
      ) : (
        <>
          <p className="fact-mono">
            <Address address={creator.address} label={creator.address} />
          </p>
          {creatorFrom(creator.from, view.powers) && (
            <p className="fact-line">{creatorFrom(creator.from, view.powers)}</p>
          )}
          {on && on.read !== 'unavailable' ? (
            <>
              <HoldersStamp live={live} />
              <dl className="fact-pairs">
                <Amount label="Bought" value={on.data.bought} />
                <Amount label="Sold" value={on.data.sold} />
                <Amount label="Received" value={on.data.received} />
                <Amount label="Holds today" value={on.data.holdsNow} />
                {(on.data.locked ?? 0) > 0 && <Amount label="Locked" value={on.data.locked} />}
                {(on.data.burned ?? 0) > 0 && <Amount label="Burned" value={on.data.burned} />}
              </dl>
              <p className="fact-note">
                Shares of the whole supply. {on.data.transactions.read} of{' '}
                {on.data.transactions.listed} transaction
                {on.data.transactions.listed === 1 ? '' : 's'} read.
              </p>
              {on.data.moves.length > 0 && (
                <ol className="sol-list" aria-label="The creator’s moves of this token">
                  {on.data.moves.map((m) => (
                    <li key={`${m.signature}-${m.kind}`} data-kind={m.kind}>
                      <span>{MOVE_WORD[m.kind]}</span>
                      <Tx signature={m.signature}>{when(m.at)}</Tx>
                      <strong>{pct(m.share)}</strong>
                    </li>
                  ))}
                </ol>
              )}
              {on.data.more > 0 && (
                <p className="fact-note">{on.data.more} more moves not listed here.</p>
              )}
              {on.read !== 'full' && <ReadNote block={on} />}
            </>
          ) : (
            <p className="fact-note">
              What the creator did with this token was not read
              {on?.note ? ` — ${plainNote(on.note)}` : '.'}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function OtherTokensCard({ view }: { view: SolanaView }) {
  const history = view.history;
  if (!history) return null;
  const d = history.data;
  return (
    <Card id="fact-creator-tokens" title="The creator’s other tokens">
      {history.read === 'unavailable' ? (
        <ReadNote block={history} />
      ) : (
        <>
          <p className="fact-big">
            {d.launched}
            <span>
              {' '}
              other token{d.launched === 1 ? '' : 's'} found
              {d.curvesListed && d.historyComplete && history.read === 'full'
                ? ''
                : ', from what could be read'}
            </span>
          </p>
          {d.launched > 0 && (
            <dl className="fact-pairs">
              <div>
                <dt>Graduated</dt>
                <dd>{d.counts.graduated}</dd>
              </div>
              <div>
                <dt>Traded in the last 24 h</dt>
                <dd>{d.counts.active}</dd>
              </div>
              <div>
                <dt>No trade in the last 24 h</dt>
                <dd>{d.counts.dead}</dd>
              </div>
              <div>
                <dt>Not known</dt>
                <dd>{d.counts.unknown}</dd>
              </div>
            </dl>
          )}
          {d.tokens.length > 0 && (
            <ul className="sol-list" aria-label="Other tokens from this creator">
              {d.tokens.map((t) => (
                <li key={t.mint}>
                  <span>
                    {t.name ?? t.symbol ?? short(t.mint)}
                    {t.launchpad ? ` · ${t.launchpad}` : ''}
                    {t.launchedAt ? ` · ${t.launchedAt.slice(0, 10)}` : ''}
                  </span>
                  <Address address={t.mint} />
                  <strong>{outcomeWord(t.outcome)}</strong>
                </li>
              ))}
            </ul>
          )}
          {d.more > 0 && <p className="fact-note">{d.more} more not listed here.</p>}
          {!d.historyComplete && (
            <p className="fact-note">
              The creator’s transaction history is longer than what was read: older tokens may be
              missing.
            </p>
          )}
          <ReadNote block={history} />
        </>
      )}
    </Card>
  );
}

function FundedRow({ f }: { f: FundedView }) {
  const did =
    f.bought === null && f.sold === null
      ? 'its trades of this token were not read'
      : `bought ${pct(f.bought)}, sold ${pct(f.sold)}${f.holdsNow === null ? '' : `, holds ${pct(f.holdsNow)} today`}${f.complete ? '' : ' (partly read)'}`;
  return (
    <li>
      <span>
        {sol(f.sol)} sent · {did}
      </span>
      <Address address={f.wallet} />
    </li>
  );
}

function LinkedCard({ view }: { view: SolanaView }) {
  const linked = view.linked;
  if (!linked) return null;
  const d = linked.data;
  return (
    <Card id="fact-linked" title="SOL around the creator">
      {linked.read === 'unavailable' ? (
        <ReadNote block={linked} />
      ) : (
        <>
          {d.firstFunding ? (
            <p className="fact-line">
              First SOL received: {sol(d.firstFunding.sol)} from{' '}
              <Address address={d.firstFunding.from} />,{' '}
              <Tx signature={d.firstFunding.signature}>{when(d.firstFunding.at)}</Tx>.
            </p>
          ) : (
            <p className="fact-line">
              {d.funding === 'none-seen'
                ? 'No SOL received from another address was seen in the creator’s whole history.'
                : d.funding === 'not-reached'
                  ? 'The creator’s first SOL was not reached: its history is longer than what was read.'
                  : 'Who first sent the creator SOL was not read.'}
            </p>
          )}
          {d.window ? (
            d.funded.length > 0 ? (
              <>
                <p className="fact-line">
                  Wallets the creator sent SOL to around the launch ({d.window.from.slice(0, 10)} to{' '}
                  {d.window.to.slice(0, 10)}), and what each did with this token:
                </p>
                <ul className="sol-list" aria-label="Wallets the creator sent SOL to">
                  {d.funded.map((f) => (
                    <FundedRow key={f.wallet} f={f} />
                  ))}
                </ul>
                {d.more > 0 && <p className="fact-note">{d.more} more not listed here.</p>}
              </>
            ) : (
              <p className="fact-line">
                The creator sent SOL to no wallet around the launch, in what was read.
              </p>
            )
          ) : (
            <p className="fact-note">
              The launch time is not known: transfers around it were not read.
            </p>
          )}
          <p className="fact-note">Transfers only: who controls these addresses is not known.</p>
          <ReadNote block={linked} />
        </>
      )}
    </Card>
  );
}

export function SolanaFacts({
  view,
  index,
  live,
}: {
  view: SolanaView;
  index: string;
  /** When the live reads last landed: the holders and the creator's balance follow them. */
  live?: LiveTimes;
}) {
  return (
    <section className="facts-section sol-facts" aria-labelledby="solana-facts-title">
      <div className="report-section-head">
        <p className="report-kicker">{index} — Read on Solana</p>
        <h3 id="solana-facts-title">The mint, the launch and the creator, account by account.</h3>
        <p className="questions-intro">
          Every address and transaction links to the Solana Explorer.
          {live &&
            ` Holders and what the creator holds are refreshed live; the rest is as of ${clockOf(live.collectedAt)}.`}
        </p>
      </div>
      <div className="facts-board sol-board" role="region" aria-label="Facts read on Solana">
        <MintCard view={view} />
        <SupplyCard view={view} live={live} />
        <LiquidityCard view={view} />
        <LaunchCard view={view} />
        <CreatorTokenCard view={view} live={live} />
        <OtherTokensCard view={view} />
        <LinkedCard view={view} />
      </div>
    </section>
  );
}
