import type { TokenReport } from '../contracts';
import { volumePerTrade } from '../market';
import { sourcesFailed } from '../failed-reads';
import { readableNote } from '../plain-note';
import type { SolanaHolder } from '../solana/holders';
import { NATIVE_MINT } from '../solana/programs';
import type { TokenPower, TokenPowerKind } from '../solana/token-types';
import { addressesSoftware, imitatedName, normalizeName, quoteName } from './names';
import {
  BUYS_WITHOUT_SALE,
  CREATOR_HOLDS_SHARE,
  DEAD_LAUNCHES_MIN,
  FRESH_WALLET_SECONDS,
  GROUP_SHARE,
  GROUP_SHARE_MIN,
  LARGEST_WALLET_SHARE,
  LOCKED_FOR_GOOD,
  MOSTLY_SET_ASIDE,
  RECENT_WALLET_SECONDS,
  ROUND_TRIPS_MIN,
  TRADES_MIN,
  TRADES_PER_HOLDER,
  WITHDRAWABLE_SHARE,
} from './thresholds';
import type {
  Finding,
  GroupMeasure,
  Measures,
  PowerMeasure,
  Signal,
  Specialist,
  SpecialistId,
} from './types';
import {
  count,
  curveName,
  dayOf,
  durationWords,
  pct,
  shareOf,
  short,
  solOf,
  solWords,
} from './words';

/**
 * The ten questions SEAL asks of every Solana token, each answered from the
 * collected report alone: what the mint lets someone do, what its rules do
 * to transfers, who holds it, what the creator did before and with this
 * token, who funded the creator, how it trades, whether holders can sell,
 * what became of its pools, and whether its name is borrowed.
 *
 * Every fact is a sentence of what was read; every limit says what was not
 * read and what that prevents saying. A block that could not be read leaves
 * its question `unknown`, never `quiet`: an absence is said only when the
 * read that would have found it answered.
 */

/** The limit every question gives when the report itself could not be collected. */
export const NO_REPORT = 'the token’s report could not be collected this time';

const unknown = (specialist: SpecialistId, limits: string[]): Finding => ({
  specialist,
  signal: 'unknown',
  facts: [],
  limits,
});

/** The first note of a block's sources, as a reader takes it. */
function noteOf(
  block: { sources: readonly { note?: string }[] } | null | undefined,
): string | null {
  const note = block?.sources.find((s) => s.note)?.note;
  return note ? readableNote(note) : null;
}

/** "the mint could not be read (the source did not answer this time)". */
function unread(what: string, block: { sources: readonly { note?: string }[] } | null): string {
  const note = noteOf(block);
  return `${what} could not be read${note ? ` (${note})` : ''}`;
}

/** The strongest signal of a list, in the order a reader needs them. */
function strongest(signals: Signal[], fallback: Signal): Signal {
  for (const s of ['concern', 'observation', 'reassurance', 'quiet'] as const) {
    if (signals.includes(s)) return s;
  }
  return fallback;
}

/** "$47.35", "$2,912.64". */
const usd = (x: number) =>
  `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const supplyOf = (report: TokenReport): string | null =>
  report.mint.data?.supply ?? report.holders.data.supply ?? null;

// ── Powers and rules ────────────────────────────────────────────────────────

/** The powers over the token itself. */
const TOKEN_POWERS: ReadonlySet<TokenPowerKind> = new Set([
  'mint',
  'freeze',
  'metadata-update',
  'metadata-pointer',
  'close-mint',
  'interest-rate',
  'ui-multiplier',
  'permissioned-burn',
  'confidential-mint-burn',
  'unknown',
]);

/** What acts on transfers between holders. */
const TRANSFER_RULES: ReadonlySet<TokenPowerKind> = new Set([
  'permanent-delegate',
  'transfer-hook',
  'transfer-fee',
  'transfer-fee-change',
  'pause',
  'default-account-state',
  'non-transferable',
  'confidential-transfers',
]);

/** Whether a power acts today, read from the mint's extension; `undefined` when that does not apply. */
function activeOf(report: TokenReport, power: TokenPower): boolean | undefined {
  const ext = (name: string) => report.mint.data?.extensions.find((e) => e.extension === name);
  switch (power.power) {
    case 'transfer-hook': {
      const hook = ext('transferHook');
      return hook?.extension === 'transferHook' ? hook.state.programId !== null : undefined;
    }
    case 'pause': {
      const pause = ext('pausableConfig');
      return pause?.extension === 'pausableConfig' ? pause.state.paused : undefined;
    }
    case 'default-account-state': {
      const state = ext('defaultAccountState');
      return state?.extension === 'defaultAccountState'
        ? state.state.accountState === 'frozen'
        : undefined;
    }
    case 'transfer-fee':
      // The power exists only when a fee is charged or scheduled (token.ts).
      return power.status === 'unknown' ? undefined : /pays a [\d.]+% fee/.test(power.sentence);
    case 'non-transferable':
      return true;
    default:
      return undefined;
  }
}

function measureOf(report: TokenReport, power: TokenPower, creator: string | null): PowerMeasure {
  const active = activeOf(report, power);
  const fee =
    power.power === 'transfer-fee' ? /pays a ([\d.]+%) fee/.exec(power.sentence)?.[1] : undefined;
  return {
    power: power.power,
    status: power.status,
    byCreator: creator !== null && power.holder === creator,
    ...(active !== undefined ? { active } : {}),
    ...(fee ? { fee } : {}),
  };
}

/** A power's sentence, with who holds it when the sentence does not say. */
function powerFact(power: TokenPower, creator: string | null): string {
  if (power.status !== 'held' || !power.holder) return power.sentence;
  const who =
    creator && power.holder === creator
      ? `${short(power.holder)}, the creator`
      : short(power.holder);
  return `${power.sentence} Held by ${who}.`;
}

/** Held powers first, then what is unknown, then rules in force, then what nobody holds. */
const STATUS_ORDER: Record<TokenPower['status'], number> = {
  held: 0,
  unknown: 1,
  fixed: 2,
  none: 3,
};

function powersRead(report: TokenReport, kinds: ReadonlySet<TokenPowerKind>) {
  const creator = report.creator.data.creator;
  const powers = report.powers
    .filter((p) => kinds.has(p.power))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  return {
    powers,
    facts: powers.map((p) => powerFact(p, creator)),
    measures: powers.map((p) => measureOf(report, p, creator)),
  };
}

const tokenPowers: Specialist = {
  id: 'token-powers',
  title: 'Token Powers',
  question:
    'Can someone still create more tokens, freeze holders’ tokens, or change the token’s name and image?',
  run({ report }) {
    if (!report) return unknown('token-powers', [NO_REPORT]);
    const mint = report.mint.data;
    if (!mint) return unknown('token-powers', [unread('the mint', report.mint)]);
    const { powers, facts, measures } = powersRead(report, TOKEN_POWERS);
    const held = (kind: TokenPowerKind) =>
      powers.some((p) => p.power === kind && p.status === 'held');
    const unknownOnes = powers.filter((p) => p.status === 'unknown');
    const limits = [
      ...mint.gaps,
      ...(unknownOnes.length > 0
        ? [
            `${count(unknownOnes.length, 'part')} of what the mint allows could not be decoded: what it lets someone do is not known`,
          ]
        : []),
    ];
    const signal: Signal =
      held('mint') || held('freeze')
        ? 'concern'
        : powers.some((p) => p.status === 'held') || unknownOnes.length > 0
          ? 'observation'
          : 'reassurance';
    return {
      specialist: 'token-powers',
      signal,
      facts,
      limits,
      followUps: [
        ...(held('freeze') ? (['sell-path'] as const) : []),
        ...(held('mint') ? (['holder-spread'] as const) : []),
      ],
      measures: { powers: measures },
    };
  },
};

const transferRules: Specialist = {
  id: 'transfer-rules',
  title: 'Transfer Rules',
  question:
    'Do the token’s own rules take a fee on transfers, run a program that can refuse them, or let someone move holders’ tokens?',
  run({ report }) {
    if (!report) return unknown('transfer-rules', [NO_REPORT]);
    const mint = report.mint.data;
    if (!mint) return unknown('transfer-rules', [unread('the mint', report.mint)]);
    if (mint.program === 'spl-token') {
      return {
        specialist: 'transfer-rules',
        signal: 'reassurance',
        facts: [
          'It is an SPL Token mint: that token program has no transfer fee, transfer hook, permanent delegate, pause or default frozen accounts.',
        ],
        limits: [],
        measures: { rules: [] },
      };
    }
    const { powers, facts, measures } = powersRead(report, TRANSFER_RULES);
    // An extension SEAL cannot decode may act on transfers: "none" is not said then.
    const undecoded = report.powers.some((p) => p.power === 'unknown');
    if (powers.length === 0 && undecoded) {
      return {
        specialist: 'transfer-rules',
        signal: 'observation',
        facts: [
          'No extension SEAL can read acts on transfers (transfer fee, transfer hook, permanent delegate, pause, default account state, non-transferable).',
        ],
        limits: [
          ...mint.gaps,
          'the mint carries an extension SEAL cannot read: whether it acts on transfers is not known',
        ],
        measures: { rules: [] },
      };
    }
    if (powers.length === 0) {
      return {
        specialist: 'transfer-rules',
        signal: 'reassurance',
        facts: [
          'It is a Token-2022 mint without any extension that acts on transfers (transfer fee, transfer hook, permanent delegate, pause, default account state, non-transferable).',
        ],
        limits: mint.gaps,
        measures: { rules: [] },
      };
    }
    const acting = measures.filter(
      (m) =>
        (m.power === 'permanent-delegate' && m.status === 'held') ||
        (m.status !== 'none' && m.active === true),
    );
    const someoneCan = measures.filter((m) => m.status === 'held');
    const unknownOnes = measures.filter((m) => m.status === 'unknown');
    const signal: Signal =
      acting.length > 0
        ? 'concern'
        : someoneCan.length > 0 || unknownOnes.length > 0 || undecoded
          ? 'observation'
          : 'reassurance';
    return {
      specialist: 'transfer-rules',
      signal,
      facts,
      limits: [
        ...mint.gaps,
        ...(unknownOnes.length > 0
          ? ['part of the transfer rules could not be read: what they do now is not known']
          : []),
        ...(undecoded
          ? [
              'the mint carries an extension SEAL cannot read: whether it acts on transfers is not known',
            ]
          : []),
      ],
      ...(signal === 'concern' ? { followUps: ['sell-path' as const] } : {}),
      measures: { rules: measures },
    };
  },
};

// ── Holders ─────────────────────────────────────────────────────────────────

const holderSpread: Specialist = {
  id: 'holder-spread',
  title: 'Holder Spread',
  question: 'How much of the supply sits in a few wallets, the creator’s included?',
  run({ report }) {
    if (!report) return unknown('holder-spread', [NO_REPORT]);
    const holders = report.holders;
    const h = holders.data;
    if (holders.completeness === 'unavailable' || h.method === 'none') {
      return unknown('holder-spread', [unread('the holders list', holders)]);
    }
    const exact = h.holderCount !== null;
    const facts: string[] = [
      exact
        ? `Every token account was read: ${count(h.holderCount!, 'holder')}, curves, pools, locks and burn left out.`
        : `The 20 largest token accounts were read: at least ${count(h.holdersAtLeast, 'holder')}, curves, pools, locks and burn left out.`,
    ];
    const o = h.ofSupply;
    const aside = [
      o.curves ? `${pct(o.curves)} on a bonding curve` : '',
      o.pools ? `${pct(o.pools)} in trading pools` : '',
      o.locked ? `${pct(o.locked)} in locks` : '',
      o.burned ? `${pct(o.burned)} with the incinerator` : '',
    ].filter(Boolean);
    if (aside.length > 0) {
      facts.push(
        `Of the whole supply, ${aside.join(', ')}: held for trading or locked, these are left out of the shares below.`,
      );
    }
    const setAside = h.pooledShare ?? null;
    const wallets = (h.top as readonly SolanaHolder[]).filter(
      (t) => t.kind === 'wallet' || t.kind === 'contract',
    );
    const largest = wallets[0];
    if (largest) {
      facts.push(
        `The largest holder has ${pct(h.concentration.top1)} of what circulates (${pct(largest.ofSupply)} of the whole supply); the top 10 have ${pct(h.concentration.top10)}.`,
      );
    }
    const creator = h.creator ?? null;
    if (creator) {
      // Shares are rounded to six places: a dust balance is "<0.01%", never "none".
      const ofSupply = shareOf(creator.balance, h.supply) ?? creator.ofSupply;
      facts.push(
        creator.balance !== '0'
          ? `The creator holds ${ofSupply > 0 ? pct(ofSupply) : '<0.01%'} of the supply (${creator.share > 0 ? pct(creator.share) : '<0.01%'} of what circulates).`
          : 'The creator holds none of it today.',
      );
    }
    const limits = [
      ...(exact
        ? []
        : [
            'only the largest token accounts were read: shares are floors and the holder count is a minimum',
          ]),
      ...(holders.completeness === 'partial' && noteOf(holders) ? [noteOf(holders)!] : []),
    ];
    const signals: Signal[] = [];
    if (creator && creator.ofSupply >= CREATOR_HOLDS_SHARE) signals.push('concern');
    if (setAside !== null && setAside >= MOSTLY_SET_ASIDE) signals.push('observation');
    else if (largest && h.concentration.top1 >= LARGEST_WALLET_SHARE) signals.push('concern');
    return {
      specialist: 'holder-spread',
      signal: strongest(signals, 'quiet'),
      facts,
      limits,
      ...(creator && creator.ofSupply >= CREATOR_HOLDS_SHARE
        ? { followUps: ['creator-history' as const] }
        : {}),
      measures: {
        spread: {
          top1: h.concentration.top1,
          top10: h.concentration.top10,
          setAside,
          holders: h.holderCount ?? h.holdersAtLeast,
          exact,
          creator: creator ? creator.ofSupply : (report.creatorOnToken?.data.holdsNowShare ?? null),
        },
      },
    };
  },
};

// ── The creator ─────────────────────────────────────────────────────────────

/** Where the creator was read, in plain words. */
export const CREATOR_FROM: Record<NonNullable<TokenReport['creator']['data']['from']>, string> = {
  'pump-curve': 'named by its pump.fun bonding curve',
  'creation-transaction': 'the fee payer of the transaction that created the mint',
  'metadata-update-authority':
    'the address that can update its metadata (the creator’s choice at launch, not proof of authorship)',
};

const NO_CREATOR =
  'no creator is named on the chain (no pump.fun curve, creation transaction or metadata authority names one)';

/**
 * A question about the creator, with no creator to ask about: "nobody is
 * named" only when the creator read answered; a failed read says so.
 */
function withoutCreator(id: SpecialistId, report: TokenReport): Finding {
  return report.creator.completeness === 'unavailable'
    ? unknown(id, [unread('the creator', report.creator)])
    : unknown(id, [NO_CREATOR]);
}

/** Whether the creator sold this token: a sale read is a sale; "no sale" only when every move was read. */
function creatorSold(report: TokenReport): boolean | null {
  const onToken = report.creatorOnToken;
  if (!onToken || onToken.completeness === 'unavailable') return null;
  if (onToken.data.sold !== '0') return true;
  return onToken.completeness === 'full' ? false : null;
}

const creatorHistory: Specialist = {
  id: 'creator-history',
  title: 'Creator History',
  question: 'What became of the creator’s other tokens, and what has it done with this one?',
  run({ report }) {
    if (!report) return unknown('creator-history', [NO_REPORT]);
    const creator = report.creator.data.creator;
    if (!creator) return withoutCreator('creator-history', report);
    const facts: string[] = [];
    const limits: string[] = [];
    const signals: Signal[] = [];
    const measures: Measures = {};

    const history = report.creatorHistory;
    if (!history || history.completeness === 'unavailable') {
      limits.push(unread('the creator’s other tokens', history));
    } else {
      const c = history.data.counts;
      const s = history.data.scanned;
      const atLeast = history.completeness !== 'full' || !s.pumpCurvesListed;
      if (c.launched === 0) {
        facts.push(
          `No other token by this creator was found on pump.fun’s curves or in the ${count(s.transactionsRead, 'transaction')} of its own read.`,
        );
      } else {
        facts.push(
          `It launched ${atLeast ? 'at least ' : ''}${count(c.launched, 'other token')}: ${c.graduated} graduated from their curve, ${c.active} traded in the last 24 hours, ${c.dead} launched over a day ago with no trade in the last 24 hours, ${c.unknown} not determined.`,
        );
        const pattern = c.dead >= DEAD_LAUNCHES_MIN && c.dead * 2 >= c.launched;
        signals.push(pattern ? 'concern' : 'observation');
      }
      if (history.completeness !== 'full' && noteOf(history)) limits.push(noteOf(history)!);
      if (!s.pumpCurvesListed)
        limits.push('pump.fun’s curves naming the creator could not all be listed');
      measures.history = { ...c, atLeast };
    }

    const onToken = report.creatorOnToken;
    const supply = supplyOf(report);
    if (!onToken || onToken.completeness === 'unavailable') {
      limits.push(unread('what the creator did with this token', onToken));
    } else {
      const d = onToken.data;
      const sold = creatorSold(report);
      const bought = shareOf(d.bought, supply);
      const soldShare = shareOf(d.sold, supply);
      const spent = solOf(d.solSpent);
      const got = solOf(d.solReceived);
      const parts: string[] = [];
      // A move read is said even when the supply is not known: "some", never left out.
      const part = (raw: string) => {
        const s = shareOf(raw, supply);
        return s === null ? 'some' : pct(s);
      };
      if (d.bought !== '0') {
        parts.push(
          `bought ${part(d.bought)}${bought !== null ? ' of the supply' : ''}${spent ? ` for ${solWords(spent)}` : ''}`,
        );
      }
      if (d.received !== '0') parts.push(`received ${part(d.received)} from other addresses`);
      if (sold === true) {
        parts.push(
          `sold ${soldShare !== null ? pct(soldShare) : 'some'}${got ? ` for ${solWords(got)}` : ''}`,
        );
      }
      // Tokens passed on outside any market: who got them is in the report, not who controls them.
      if (d.sends.distinct > 0) {
        const total = d.sends.total && d.sends.total !== '0' ? part(d.sends.total) : 'some';
        parts.push(
          `sent ${total} to ${count(d.sends.distinct, 'other address', 'other addresses')} outside any market`,
        );
      }
      if (d.locked !== '0') parts.push(`put ${part(d.locked)} into a lock`);
      if (d.burned !== '0') parts.push(`burned ${part(d.burned)}`);
      const read = `${d.transactions.read} of ${count(d.transactions.listed, 'transaction')} on its token accounts read`;
      facts.push(
        parts.length > 0
          ? `On this token, the creator ${parts.join(', ')} (${read}).`
          : `On this token, the creator neither bought nor received any (${read}).`,
      );
      if (sold === false) facts.push('The creator has not sold any of this token.');
      if (sold === null) {
        limits.push(
          'not every move of the creator on this token was read: no sale was seen, but one may lie in the transactions not read',
        );
      }
      const holds = d.holdsNow === null ? null : (shareOf(d.holdsNow, supply) ?? d.holdsNowShare);
      if (d.holdsNow !== null && holds !== null) {
        facts.push(
          d.holdsNow !== '0'
            ? `It holds ${pct(holds)} of the supply today.`
            : 'It holds none of it today.',
        );
      }
      if (sold === true) signals.push('concern');
      measures.creator = {
        bought,
        sold: sold === true ? soldShare : sold === false ? 0 : null,
        hasSold: sold,
        holdsNow: holds,
      };
    }
    const nothingRead = !measures.history && !measures.creator;
    return {
      specialist: 'creator-history',
      signal: nothingRead ? 'unknown' : strongest(signals, 'quiet'),
      facts,
      limits,
      ...(signals.includes('concern') ? { followUps: ['funding-trace' as const] } : {}),
      measures,
    };
  },
};

/** When the token was created, Unix seconds; `null` when not read. */
function createdAt(report: TokenReport): number | null {
  const creation = report.creator.data.creation;
  if (creation?.blockTime) return creation.blockTime;
  const launched = report.launch.data.launchedAt;
  return launched ? Math.floor(Date.parse(launched) / 1000) : null;
}

const walletAge: Specialist = {
  id: 'wallet-age',
  title: 'Wallet Age',
  question: 'Did the creator’s wallet exist before this launch?',
  run({ report }) {
    if (!report) return unknown('wallet-age', [NO_REPORT]);
    const creator = report.creator.data.creator;
    if (!creator) return withoutCreator('wallet-age', report);
    const linked = report.linkedWallets;
    const history = report.creatorHistory;
    const facts: string[] = [];
    const limits: string[] = [];
    let signal: Signal = 'unknown';
    const created = createdAt(report);
    if (!linked || linked.completeness === 'unavailable') {
      limits.push(unread('the creator’s first funding', linked));
    } else if (linked.data.funding === 'found' && linked.data.firstFunding) {
      const first = linked.data.firstFunding;
      if (first.blockTime !== null && created !== null) {
        const age = created - first.blockTime;
        facts.push(
          age >= 0
            ? `The creator’s wallet first received SOL on ${dayOf(first.blockTime)}, ${durationWords(age)} before the token was created.`
            : `The creator’s wallet first received SOL on ${dayOf(first.blockTime)}, after the token was created.`,
        );
        // SOL first received after the creation: someone else paid for it, a
        // fact to note, not a fresh wallet ("funded less than a day before").
        signal =
          age < 0
            ? 'observation'
            : age < FRESH_WALLET_SECONDS
              ? 'concern'
              : age < RECENT_WALLET_SECONDS
                ? 'observation'
                : 'quiet';
      } else if (first.blockTime !== null) {
        facts.push(`The creator’s wallet first received SOL on ${dayOf(first.blockTime)}.`);
        limits.push(
          'the token’s creation time was not read: the wallet’s age at launch is not known',
        );
        signal = 'quiet';
      } else {
        limits.push('the time of the creator’s first funding was not given by the node');
      }
    } else if (linked.data.funding === 'not-reached') {
      facts.push(
        'The creator’s wallet has a longer history than SEAL reads: its first funding was not reached.',
      );
      signal = 'quiet';
    } else if (linked.data.funding === 'none-seen') {
      facts.push('No incoming SOL was found in the creator’s transactions read.');
      signal = 'observation';
    } else {
      limits.push('the creator’s first funding was found but its transfer was not given');
    }
    if (history && history.completeness !== 'unavailable') {
      const s = history.data.scanned;
      if (s.signaturesComplete) {
        facts.push(`Its wallet has ${count(s.signatures, 'transaction')} in all.`);
      } else if (s.readSince !== null) {
        facts.push(
          `Its transactions read go back to ${dayOf(s.readSince)}, and it has more before.`,
        );
      }
    }
    return {
      specialist: 'wallet-age',
      signal,
      facts,
      limits,
      ...(signal === 'concern' ? { followUps: ['funding-trace' as const] } : {}),
    };
  },
};

const fundingTrace: Specialist = {
  id: 'funding-trace',
  title: 'Funding Trace',
  question:
    'Who first sent SOL to the creator, and did wallets the creator funded around the launch trade this token?',
  run({ report }) {
    if (!report) return unknown('funding-trace', [NO_REPORT]);
    if (!report.creator.data.creator) return withoutCreator('funding-trace', report);
    const linked = report.linkedWallets;
    if (!linked || linked.completeness === 'unavailable') {
      return unknown('funding-trace', [unread('who funded the creator', linked)]);
    }
    const d = linked.data;
    const facts: string[] = [];
    const limits: string[] = [];
    const first = d.firstFunding;
    if (d.funding === 'found' && first) {
      const sol = solOf(first.lamports);
      const how =
        first.how === 'system-transfer'
          ? 'by a transfer'
          : 'when an account was closed to it, in a transaction that address sent';
      facts.push(
        `The creator’s first SOL came from ${short(first.from)}${sol !== null ? `: ${solWords(sol)}` : ''}${first.blockTime !== null ? ` on ${dayOf(first.blockTime)}` : ''}, ${how}.`,
      );
      limits.push(
        'who is behind the funding address is not read: an exchange, a service or a person',
      );
    } else if (d.funding === 'not-reached') {
      limits.push('the creator’s first funding lies beyond the transactions read');
    } else if (d.funding === 'none-seen') {
      facts.push('No incoming SOL was found in the creator’s transactions.');
    } else {
      limits.push('the creator’s first funding was found but its transfer was not given');
    }

    const supply = supplyOf(report);
    const traded = d.funded.filter(
      (f) => f.onToken && (f.onToken.bought !== '0' || f.onToken.sold !== '0'),
    );
    const sellers = d.funded.filter((f) => f.onToken && f.onToken.sold !== '0');
    const sum = (pick: (f: (typeof d.funded)[number]) => string | null | undefined) =>
      d.funded.reduce((n, f) => n + (shareOf(pick(f), supply) ?? 0), 0);
    const bought = sum((f) => f.onToken?.bought);
    const sold = sum((f) => f.onToken?.sold);
    const heldRead = d.funded.every((f) => f.onToken && f.onToken.holdsNow !== null);
    const held = heldRead ? sum((f) => f.onToken?.holdsNow) : null;
    const complete = d.funded.every((f) => f.onToken?.complete === true);
    if (d.window === null) {
      limits.push(
        'the launch time is not known: the wallets the creator funded around it were not looked for',
      );
    } else if (d.funded.length === 0) {
      facts.push(
        `Around the launch (${dayOf(d.window.from)} to ${dayOf(d.window.to)}), the creator sent SOL to no other wallet outside its trades${linked.completeness === 'full' ? '' : ', in the transactions read'}.`,
      );
    } else {
      const lamports = d.funded.reduce((n, f) => n + (solOf(f.lamports) ?? 0), 0);
      facts.push(
        `Around the launch, the creator sent ${solWords(lamports)} to ${count(d.funded.length, 'wallet')} outside its trades.`,
      );
      facts.push(
        traded.length === 0
          ? `None of them traded this token${complete ? '' : ' in what was read'}.`
          : `${count(traded.length, 'of them', 'of them')} traded this token: they bought ${complete ? '' : 'at least '}${pct(bought)} of the supply${sellers.length > 0 ? ` and ${sellers.length === traded.length ? 'sold' : `${sellers.length} sold`} ${complete ? '' : 'at least '}${pct(sold)}` : ''}${held !== null ? `; the wallets it funded hold ${held === 0 ? 'none of it' : pct(held)} today` : ''}.`,
      );
      if (!complete) limits.push('not every funded wallet’s trades on this token were read');
    }
    if (linked.completeness === 'partial' && noteOf(linked)) limits.push(noteOf(linked)!);
    limits.push('a SOL transfer links the addresses; it does not show who controls them');
    const signal: Signal =
      traded.length > 0
        ? 'concern'
        : d.funded.length > 0
          ? 'observation'
          : facts.length > 0
            ? 'quiet'
            : 'unknown';
    return {
      specialist: 'funding-trace',
      signal,
      facts,
      limits,
      ...(first
        ? {
            funding: {
              kind: 'unknown' as const,
              linkedCreators: 0,
              launches: null,
              depth: 1,
              path: [{ address: first.from, kind: 'unknown' as const, name: null, txCount: null }],
            },
          }
        : {}),
      ...(d.window !== null
        ? {
            measures: {
              linked: {
                wallets: d.funded.length,
                buyers: d.funded.filter((f) => f.onToken && f.onToken.bought !== '0').length,
                sellers: sellers.length,
                bought,
                sold,
                heldNow: held,
                complete,
              },
            },
          }
        : {}),
    };
  },
};

// ── Trading ─────────────────────────────────────────────────────────────────

function group(
  g: {
    wallets: number;
    share: number;
    heldNow: number | null;
    soldInWindow: number;
  } | null,
): GroupMeasure | null {
  return g
    ? { wallets: g.wallets, share: g.share, heldNow: g.heldNow, soldInWindow: g.soldInWindow }
    : null;
}

function groupFact(where: string, g: GroupMeasure, transactions: number): string {
  const held =
    g.heldNow === null
      ? ''
      : g.heldNow === 0
        ? '; they hold none of it today'
        : `; they hold ${pct(g.heldNow)} today`;
  const sold = g.soldInWindow > 0 ? `, ${g.soldInWindow} of them sold in the window read` : '';
  return `${where}, ${count(g.wallets, 'wallet')} other than the creator got ${pct(g.share)} of the supply in ${count(transactions, 'transaction')}${sold}${held}.`;
}

const volumeReality: Specialist = {
  id: 'volume-reality',
  title: 'Volume Reality',
  question:
    'Does the trading come from many people, or from a few addresses buying together or going back and forth?',
  run({ report }) {
    if (!report) return unknown('volume-reality', [NO_REPORT]);
    const facts: string[] = [];
    const limits: string[] = [];
    const signals: Signal[] = [];
    const market = report.market;
    const txns = market.completeness === 'unavailable' ? null : market.data.txns;
    const launch = report.launch.data;
    const sameSlot = group(launch.sameSlot);
    const payerGroup = group(launch.payerGroup);
    if (launch.payerGroup && payerGroup && payerGroup.share >= GROUP_SHARE_MIN) {
      facts.push(
        groupFact(
          'In transactions paid by the creator or by the creation’s fee payer',
          payerGroup,
          launch.payerGroup.transactions,
        ),
      );
      signals.push(payerGroup.share >= GROUP_SHARE ? 'concern' : 'observation');
    }
    if (launch.sameSlot && sameSlot && sameSlot.share >= GROUP_SHARE_MIN) {
      facts.push(groupFact('In the creation slot', sameSlot, launch.sameSlot.transactions));
      signals.push(sameSlot.share >= GROUP_SHARE ? 'concern' : 'observation');
    }
    // What was got together at launch first: it is what the question is most often asked for.
    if (txns) {
      const trades = txns.h24.buys + txns.h24.sells;
      const perTrade = volumePerTrade(market);
      const h = report.holders;
      const holders =
        h.completeness !== 'unavailable' && h.data.holderCount !== null ? h.data.holderCount : null;
      facts.push(
        `${count(trades, 'trade')} in the last 24 hours on its listed pairs (${txns.h24.buys} buys, ${txns.h24.sells} sells)${perTrade !== null ? `, ${usd(perTrade)} per trade on average` : ''}${holders !== null ? `, while ${count(holders, 'wallet')} ${holders === 1 ? 'holds' : 'hold'} it today, curves and pools left out` : ''}.`,
      );
      if (
        holders !== null &&
        trades >= TRADES_MIN &&
        trades >= TRADES_PER_HOLDER * Math.max(1, holders)
      ) {
        facts.push(
          `That is at least ${TRADES_PER_HOLDER} trades in a day for each wallet holding it now.`,
        );
        signals.push('concern');
      }
    } else {
      limits.push(unread('its trading over the last 24 hours', market));
    }
    const trips =
      launch.summary?.roundTrips?.wallets ?? (launch.creation ? launch.roundTrips.length : null);
    if (trips !== null && trips >= ROUND_TRIPS_MIN) {
      facts.push(
        `In the first ${launch.windowSeconds} seconds read, ${count(trips, 'address', 'addresses')} bought and then sold back.`,
      );
      signals.push('observation');
    }
    if (report.launch.completeness === 'unavailable') {
      limits.push(unread('the first transactions after the creation', report.launch));
    } else if (report.launch.completeness === 'partial') {
      limits.push('the launch window was read in part: later buys are not counted');
    }
    const answered = txns !== null || report.launch.completeness !== 'unavailable';
    return {
      specialist: 'volume-reality',
      signal: answered ? strongest(signals, 'quiet') : 'unknown',
      facts,
      limits,
      ...(signals.includes('concern') ? { followUps: ['funding-trace' as const] } : {}),
      measures: {
        launch: { sameSlot, payerGroup, roundTrips: trips },
      },
    };
  },
};

/** The curve a token still trades on, and what it holds, for the summary. */
function curveOf(report: TokenReport): Measures['curve'] | undefined {
  const g = report.graduation?.data;
  const pad = report.launchpad.data.launchpad;
  if (!g || !pad || g.graduated !== false) return undefined;
  const sol = g.raised && g.raised.mint === null ? solOf(g.raised.raw) : null;
  const m = report.market.data;
  // The token's own price in SOL and in dollars give SOL's price where it trades.
  const solUsd =
    m.pairedWith?.address === NATIVE_MINT && m.priceUsd && m.priceNative
      ? m.priceUsd / m.priceNative
      : null;
  return {
    launchpad: pad.name,
    graduated: g.graduated,
    progress: g.progress,
    sol,
    usd: sol !== null && solUsd !== null ? sol * solUsd : null,
  };
}

const sellPath: Specialist = {
  id: 'sell-path',
  title: 'Sell Path',
  question: 'Can holders sell today, and can something in the token stand in their way?',
  run({ report }) {
    if (!report) return unknown('sell-path', [NO_REPORT]);
    const mint = report.mint.data;
    const facts: string[] = [];
    const limits: string[] = [];
    const signals: Signal[] = [];
    /** The facts that deserve attention, said first. */
    const lead: string[] = [];
    const curve = curveOf(report);
    if (curve) {
      facts.push(
        `It trades on its ${curveName(curve.launchpad)}${curve.progress !== null ? `, ${pct(curve.progress)} of the way to graduation` : ''}${curve.sol !== null ? `; the curve holds ${solWords(curve.sol)}` : ''}.`,
      );
    } else if (report.graduation?.data.graduated && report.graduation.data.destination) {
      facts.push(
        `It graduated from its curve to ${report.graduation.data.destination.name} ${short(report.graduation.data.destination.pool)}.`,
      );
    }
    const market = report.market;
    const txns = market.completeness === 'unavailable' ? null : market.data.txns;
    if (txns) {
      const { buys, sells } = txns.h24;
      if (sells > 0) {
        facts.push(
          `${count(sells, 'sale')} went through in the last 24 hours on its listed pairs.`,
        );
      } else if (buys >= BUYS_WITHOUT_SALE) {
        lead.push(
          `${count(buys, 'buy', 'buys')} and no sale in the last 24 hours on its listed pairs.`,
        );
        signals.push('concern');
      } else {
        facts.push('No sale in the last 24 hours on its listed pairs.');
      }
    } else {
      limits.push(unread('its recent trades', market));
    }
    if (!mint) {
      limits.push(unread('the mint', report.mint));
    } else {
      const power = (kind: TokenPowerKind) => report.powers.find((p) => p.power === kind);
      const blockers: TokenPower[] = [];
      for (const kind of [
        'non-transferable',
        'pause',
        'default-account-state',
        'freeze',
        'permanent-delegate',
        'transfer-hook',
      ] as const) {
        const p = power(kind);
        if (!p || p.status === 'none') continue;
        const active = activeOf(report, p);
        // A hook nobody set and nobody holds, or accounts that start usable with nobody to change it, block nothing.
        if (kind === 'default-account-state' && active === false && p.status !== 'held') continue;
        blockers.push(p);
        const inForce =
          kind === 'non-transferable' ||
          (kind === 'pause' && active === true) ||
          (kind === 'default-account-state' && active === true && p.status === 'fixed');
        signals.push(inForce ? 'concern' : 'observation');
        // What stops a sale today is the answer: said before the trades.
        if (inForce) lead.push(p.sentence);
        else facts.push(p.sentence);
      }
      // An extension SEAL cannot decode may block transfers: "nothing" is not said then.
      const undecoded = report.powers.some((p) => p.power === 'unknown');
      if (blockers.length === 0 && undecoded) {
        facts.push(
          'Nothing SEAL can read in the mint can stop a sale: no freeze authority, no permanent delegate, no transfer hook, no pause.',
        );
        limits.push(
          'the mint carries an extension SEAL cannot read: whether it can stop a sale is not known',
        );
        signals.push('observation');
      } else if (blockers.length === 0) {
        facts.push(
          'Nothing in the mint can stop a sale: no freeze authority, no permanent delegate, no transfer hook, no pause.',
        );
        if (txns && txns.h24.sells > 0) signals.push('reassurance');
      }
    }
    facts.unshift(...lead);
    const answered = mint !== null || txns !== null;
    return {
      specialist: 'sell-path',
      signal: answered ? strongest(signals, 'quiet') : 'unknown',
      facts,
      limits,
      ...(curve ? { measures: { curve } } : {}),
    };
  },
};

const POOL_NAME: Record<string, string> = {
  pumpswap: 'PumpSwap pool',
  'raydium-amm-v4': 'Raydium AMM v4 pool',
  'raydium-cpmm': 'Raydium CPMM pool',
  'meteora-damm-v2': 'Meteora DAMM v2 pool',
  'raydium-clmm': 'Raydium CLMM pool',
  'orca-whirlpool': 'Orca Whirlpool pool',
  'meteora-dlmm': 'Meteora DLMM pool',
  'meteora-damm-v1': 'Meteora DAMM v1 pool',
  other: 'pool',
};

const liquidityMove: Specialist = {
  id: 'liquidity-move',
  title: 'Liquidity Move',
  question: 'Can the liquidity of its pools be withdrawn, and by whom?',
  run({ report }) {
    if (!report) return unknown('liquidity-move', [NO_REPORT]);
    const curve = curveOf(report);
    if (curve) {
      return {
        specialist: 'liquidity-move',
        signal: 'unknown',
        facts: [],
        limits: [
          `not applicable: the token is still on its ${curveName(curve.launchpad)}, which has no pool shares to withdraw yet`,
        ],
        notApplicable: true,
      };
    }
    const liquidity = report.liquidity;
    const creator = report.creator.data.creator;
    const known = liquidity.data.pools.filter((p) => p.known);
    const unknownPools = liquidity.data.pools.filter((p) => !p.known);
    if (known.length === 0) {
      // "No pool" only when the market list it comes from answered.
      const noPool =
        liquidity.data.pools.length === 0 &&
        liquidity.sources.some((s) => s.note === 'no pool to read') &&
        !sourcesFailed(report.market.sources);
      return unknown('liquidity-move', [
        ...(unknownPools.length > 0
          ? [...new Set(unknownPools.map((p) => p.note ?? 'this pool could not be described'))]
          : noPool
            ? ['no trading pool of this token was listed: there is no pool liquidity to read']
            : [unread('what its pools hold', liquidity)]),
      ]);
    }
    const facts: string[] = [];
    const signals: Signal[] = [];
    for (const p of known) {
      const name = `${p.programName ?? POOL_NAME[p.kind] ?? 'pool'} ${short(p.pool)}`;
      const shares = [
        p.burnedShare ? `${pct(p.burnedShare)} burned` : '',
        p.lockedShare ? `${pct(p.lockedShare)} locked for good` : '',
        p.withdrawableShare !== null ? `${pct(p.withdrawableShare)} withdrawable` : '',
      ].filter(Boolean);
      const wallets = p.holders
        .filter((x) => x.kind === 'wallet')
        .sort((a, b) => b.share - a.share);
      const top = wallets[0];
      const byCreator = wallets.filter((w) => creator && w.owner === creator);
      const creatorShare = byCreator.reduce((n, w) => n + w.share, 0);
      const who = `${
        top
          ? `; the largest holder of its liquidity, ${creator && top.owner === creator ? 'the creator' : `the wallet ${short(top.owner)}`}, has ${pct(top.share)}`
          : ''
      }${byCreator.length > 0 && top && top.owner !== creator ? `; the creator has ${pct(creatorShare)}` : ''}`;
      const fact = `${name}: ${shares.join(', ') || 'shares not read'}${who}.`;
      const forGood = (p.burnedShare ?? 0) + (p.lockedShare ?? 0);
      // A pool whose liquidity one holder can withdraw is said first.
      if (
        byCreator.length > 0 ||
        ((p.withdrawableShare ?? 0) >= WITHDRAWABLE_SHARE && top && top.share >= WITHDRAWABLE_SHARE)
      ) {
        signals.push('concern');
        facts.splice(signals.filter((s) => s === 'concern').length - 1, 0, fact);
      } else {
        signals.push(forGood >= LOCKED_FOR_GOOD ? 'reassurance' : 'observation');
        facts.push(fact);
      }
    }
    const limits = [
      ...new Set(unknownPools.map((p) => p.note ?? 'a pool could not be described')),
      'withdrawals already made are not read: only what each pool holds today',
    ];
    // Every pool read has its liquidity burned or locked for good: that rules out a pull.
    const signal = strongest(signals, 'quiet');
    return { specialist: 'liquidity-move', signal, facts, limits };
  },
};

// ── The name ────────────────────────────────────────────────────────────────

const nameClone: Specialist = {
  id: 'name-clone',
  title: 'Name Clone',
  question:
    'Does the token use the name or symbol of a well-known token, or of an earlier token by the same creator?',
  run({ report, token }) {
    if (!report) return unknown('name-clone', [NO_REPORT]);
    const mint = report.mint.data;
    if (!mint) return unknown('name-clone', [unread('the mint', report.mint)]);
    const meta = mint.metadata;
    if (!meta) {
      // A metadata account the mint points to, or a Metaplex account, that
      // could not be read is not "no metadata".
      const metadataGaps = mint.gaps.filter((g) => /metadata/i.test(g));
      if (metadataGaps.length > 0) return unknown('name-clone', metadataGaps);
      return {
        specialist: 'name-clone',
        signal: 'quiet',
        facts: ['The mint carries no metadata: no name or symbol is set on chain.'],
        limits: [],
      };
    }
    const facts: string[] = [];
    const signals: Signal[] = [];
    const bySymbol = imitatedName(meta.symbol);
    const byName = imitatedName(meta.name);
    const borrowed = bySymbol ?? byName;
    if (borrowed && borrowed.mint !== token) {
      const which =
        bySymbol === borrowed && byName === borrowed
          ? `Its name ${quoteName(meta.name)} and symbol ${quoteName(meta.symbol)} use those of`
          : bySymbol === borrowed
            ? `Its symbol ${quoteName(meta.symbol)} uses that of`
            : `Its name ${quoteName(meta.name)} uses that of`;
      facts.push(
        `${which} ${borrowed.label}, whose mint is ${short(borrowed.mint)}; this token is another mint.`,
      );
      signals.push('concern');
    }
    if (meta.otherMint) {
      facts.push(
        `Its metadata is the metadata of another mint, ${short(meta.otherMint)}: the name and image it shows are that mint’s.`,
      );
      signals.push('observation');
    }
    if (addressesSoftware(`${meta.name} ${meta.symbol}`)) {
      facts.push(
        'Its name or symbol is worded as an instruction to software; it is quoted here as data only.',
      );
      signals.push('observation');
    }
    const history = report.creatorHistory;
    const mine = normalizeName(meta.name);
    const symbol = normalizeName(meta.symbol);
    const same = (history?.data.tokens ?? []).filter(
      (t) =>
        (t.name && mine && normalizeName(t.name) === mine) ||
        (t.symbol && symbol && normalizeName(t.symbol) === symbol),
    );
    if (same.length > 0) {
      const first = same[0]!;
      facts.push(
        `The creator launched ${same.length === 1 ? 'another token' : `${same.length} other tokens`} with the same name or symbol before, such as ${short(first.mint)}${first.launchedAt ? ` on ${dayOf(Date.parse(first.launchedAt) / 1000)}` : ''}.`,
      );
      signals.push('observation');
    }
    const historyRead = Boolean(history && history.completeness !== 'unavailable');
    if (facts.length === 0) {
      facts.push(
        `Its name ${quoteName(meta.name)} and symbol ${quoteName(meta.symbol)} match none of the well-known tokens SEAL compares with${historyRead ? ', nor the creator’s other launches found' : ''}.`,
      );
    }
    return {
      specialist: 'name-clone',
      signal: strongest(signals, 'quiet'),
      facts,
      limits: [
        'names are compared with a short list of well-known Solana tokens and the creator’s own launches only',
        ...(historyRead
          ? []
          : [
              'the creator’s other launches were not read: a name reused from them would not be seen',
            ]),
      ],
    };
  },
};

export const CATALOG: Record<SpecialistId, Specialist> = {
  'token-powers': tokenPowers,
  'transfer-rules': transferRules,
  'holder-spread': holderSpread,
  'creator-history': creatorHistory,
  'wallet-age': walletAge,
  'funding-trace': fundingTrace,
  'volume-reality': volumeReality,
  'sell-path': sellPath,
  'liquidity-move': liquidityMove,
  'name-clone': nameClone,
};
