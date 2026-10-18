import type { CSSProperties } from 'react';
import {
  flowDate,
  flowPct,
  lockWords,
  type FlowNode,
  type FlowNodeKind,
  type SupplyFlow as SupplyFlowData,
} from '@/lib/supply-flow';

/**
 * Where the supply went at launch, drawn for a person: one bar of the whole
 * supply split by who received it, then the same recipients as a small
 * tree — who handed what to whom — each named by its role, with what it
 * holds today. Shown at the top of the report whenever the launch handed
 * its supply out; it replaces an empty buyers chart when nobody bought.
 */

const EXPLORER = 'https://robinhoodchain.blockscout.com';
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** One colour per role, in a fixed order (validated for colour-vision deficiency on the HUD surface). */
const ROLE_SLOT: Record<FlowNodeKind, number> = {
  pool: 1,
  curve: 1,
  launchpad: 1,
  'capital-formation': 2,
  vesting: 3,
  distributor: 4,
  creator: 5,
  wallet: 6,
  contract: 6,
  'smart-wallet': 6,
  'batch-sender': 6,
  burn: 6,
};

const ROLE_WORD: Record<FlowNodeKind, string> = {
  pool: 'Market',
  curve: 'Market',
  launchpad: 'Launchpad',
  'capital-formation': 'Can be sold',
  vesting: 'Locked',
  distributor: 'Launchpad wallet',
  creator: 'Creator',
  wallet: 'Wallet',
  contract: 'Contract',
  'smart-wallet': 'Wallet',
  'batch-sender': 'Contract',
  burn: 'Burned',
};

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** What a recipient holds today, in a few words. */
function today(node: FlowNode, creator: string | null): string {
  if (node.lock) return capital(lockWords(node.lock, creator, node.received));
  if (node.kind === 'curve' && node.heldNow === 0) {
    return 'Empty today: bought there, or moved to its trading pool at graduation';
  }
  if (node.heldNow === null) return 'What it holds today could not be read';
  if (node.children.length > 0 && node.heldNow === 0) {
    const last = Math.max(...node.children.map((c) => c.at));
    return `Passed it all on within ${last < 90 ? `${Math.round(last)} seconds` : `${Math.round(last / 60)} minutes`}`;
  }
  if (node.heldNow === 0) return 'Holds none of it today';
  if (Math.abs(node.heldNow - node.received) < 0.0005) return 'Still holds it all';
  return `Holds ${flowPct(node.heldNow)} of the supply today`;
}

/** The bar's segments: every final recipient, and what a holder kept for itself. */
function segments(roots: readonly FlowNode[]): { node: FlowNode; share: number }[] {
  const out: { node: FlowNode; share: number }[] = [];
  for (const root of roots) {
    if (root.children.length === 0) {
      out.push({ node: root, share: root.received });
      continue;
    }
    const passed = root.children.reduce((n, c) => n + c.received, 0);
    if (root.received - passed >= 0.001) out.push({ node: root, share: root.received - passed });
    for (const child of root.children) out.push({ node: child, share: child.received });
  }
  return out;
}

function Node({ node, creator }: { node: FlowNode; creator: string | null }) {
  return (
    <li
      className="flow-node"
      style={{ '--slot': `var(--flow-${ROLE_SLOT[node.kind]})` } as CSSProperties}
    >
      <div className="flow-card">
        <div className="flow-card-top">
          <span className="flow-dot" aria-hidden="true" />
          <span className="flow-role">{ROLE_WORD[node.kind]}</span>
          <a
            className="flow-address"
            href={`${EXPLORER}/address/${node.address}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`${node.name}, ${node.address}, on the explorer`}
          >
            {short(node.address)}
          </a>
        </div>
        <div className="flow-card-body">
          <strong className="flow-share">{flowPct(node.received)}</strong>
          <span className="flow-name">{capital(node.name)}</span>
        </div>
        <p className="flow-today">{today(node, creator)}</p>
        {node.lock && (node.lock.cancelable || node.lock.withdrawable) && (
          <p className="flow-caveat">
            Its manager can still{' '}
            {[
              node.lock.cancelable ? 'cancel schedules' : '',
              node.lock.withdrawable ? 'withdraw the deposit' : '',
            ]
              .filter(Boolean)
              .join(' and ')}
            : the lock rests on it, not on code alone.
          </p>
        )}
        {node.lock && node.lock.schedules.length > 0 && (
          <ul className="flow-schedules">
            {node.lock.schedules.map((s, i) => (
              <li key={i}>
                {flowPct(s.total)}
                {s.beneficiary && creator && s.beneficiary === creator.toLowerCase()
                  ? ' for the creator'
                  : ''}
                : {s.steps > 0 ? `${s.steps} unlocks` : 'continuous unlock'}, {flowDate(s.startsAt)}{' '}
                → {flowDate(s.endsAt)}
              </li>
            ))}
          </ul>
        )}
        {node.detail && !node.lock && <p className="flow-detail">{node.detail}</p>}
      </div>
      {node.children.length > 0 && (
        <ol className="flow-children" aria-label={`What ${node.name} passed on`}>
          {node.children.map((child) => (
            <Node key={child.address} node={child} creator={creator} />
          ))}
        </ol>
      )}
    </li>
  );
}

export function SupplyFlow({
  flow,
  creator,
  index,
}: {
  flow: SupplyFlowData;
  creator: string | null;
  /** Section number in the report, when numbered. */
  index?: string;
}) {
  const parts = segments(flow.roots);
  const minutes = Math.max(1, Math.round(flow.windowSeconds / 60));
  const label = parts.map((p) => `${capital(p.node.name)}: ${flowPct(p.share)}`).join('; ');
  return (
    <section className="supply-flow" id="supply-flow" aria-labelledby="supply-flow-title">
      <div className="report-section-head">
        <p className="report-kicker">{index ? `${index} — ` : ''}Where the supply went</p>
        <h3 id="supply-flow-title">Who received the supply at launch, and what they hold now.</h3>
        <p className="questions-intro">
          Read from the token’s own transfers{flow.launchpad ? ` on ${flow.launchpad}` : ''}; each
          address is named by what the chain says it is.
        </p>
      </div>
      <div className="flow-bar" role="img" aria-label={`The whole supply at launch. ${label}.`}>
        {parts.map((p) => (
          <span
            key={p.node.address}
            className="flow-segment"
            title={`${capital(p.node.name)}: ${flowPct(p.share)}`}
            style={
              {
                '--slot': `var(--flow-${ROLE_SLOT[p.node.kind]})`,
                flexGrow: Math.max(p.share, 0.004),
              } as CSSProperties
            }
          >
            {p.share >= 0.12 && <span className="flow-segment-label">{flowPct(p.share)}</span>}
          </span>
        ))}
      </div>
      <ol className="flow-tree" aria-label="Who received the supply, and who passed it on">
        {flow.roots.map((root) => (
          <Node key={root.address} node={root} creator={creator} />
        ))}
      </ol>
      {flow.buys === 0 && (
        <p className="story-note">
          Nobody bought in the first {minutes === 1 ? 'minute' : `${minutes} minutes`}: the supply
          was only handed out, as drawn here.
        </p>
      )}
    </section>
  );
}
