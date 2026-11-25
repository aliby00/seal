import type { SpecialistAnswer } from './brief';
import { GROUP_SHARE_MIN, MOSTLY_SET_ASIDE } from './thresholds';
import type { PowerMeasure, SpecialistId } from './types';

/**
 * The ten questions said the way a non-technical reader would ask them, and
 * each answer cut to one line. The full facts stay one click away; nothing
 * here adds to them or judges the token.
 */

export const PLAIN_LABEL: Record<SpecialistId, string> = {
  'token-powers': 'Powers kept over the token',
  'transfer-rules': 'Rules on transfers',
  'holder-spread': 'Supply held by a few',
  'creator-history': 'Creator’s tokens and sales',
  'wallet-age': 'Creator’s wallet',
  'funding-trace': 'Who funded the creator',
  'volume-reality': 'Real trading',
  'sell-path': 'Can holders sell',
  'liquidity-move': 'Pool liquidity',
  'name-clone': 'Borrowed name',
};

const pc = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

/** What a held power lets someone do, in a few words. */
const CAN: Partial<Record<PowerMeasure['power'], string>> = {
  mint: 'create tokens',
  freeze: 'freeze holders',
  'permanent-delegate': 'take holders’ tokens',
  pause: 'pause transfers',
  'transfer-hook': 'set a transfer program',
  'transfer-fee-change': 'set a transfer fee',
  'metadata-update': 'change its name',
};

function heldWords(list: readonly PowerMeasure[] | undefined): string | null {
  const words = (list ?? [])
    .filter((p) => p.status === 'held')
    .map((p) => CAN[p.power])
    .filter((w): w is string => Boolean(w));
  if (words.length === 0) return null;
  return `Someone can ${words.slice(0, 3).join(', ')}`;
}

/** One line, readable without the details. Falls back to the first fact. */
export function shortAnswer(answer: SpecialistAnswer): string {
  const first = answer.facts[0];
  const signal = answer.signal;
  const m = answer.measures;
  // Not applicable is said as such, with why, never as "not measured".
  if (answer.notApplicable) {
    const why = answer.limits[0]?.replace(/^not applicable: /, '') ?? '';
    return why ? `Not applicable: ${why}` : 'Not applicable to this token';
  }
  switch (answer.specialist) {
    case 'token-powers': {
      const held = heldWords(m?.powers);
      if (held) return held;
      if (signal === 'reassurance') return 'No one can create more tokens or freeze holders';
      break;
    }
    case 'transfer-rules': {
      const fee = m?.rules?.find((r) => r.power === 'transfer-fee' && r.fee);
      if (fee?.fee) return `Every transfer pays a ${fee.fee} fee`;
      const held = heldWords(m?.rules);
      if (held) return held;
      if (signal === 'reassurance') return 'No rule acts on transfers';
      break;
    }
    case 'holder-spread': {
      const s = m?.spread;
      if (s && s.setAside !== null && s.setAside >= MOSTLY_SET_ASIDE)
        return `${pc(s.setAside)} in curves, pools, locks or burned`;
      if (s) return `Largest holder ${pc(s.top1)} · top 10 ${pc(s.top10)} (pools left out)`;
      break;
    }
    case 'creator-history': {
      const c = m?.creator;
      const h = m?.history;
      if (c?.hasSold === true)
        return c.sold !== null
          ? `The creator sold ${pc(c.sold)} of the supply`
          : 'The creator sold some';
      if (h && h.launched > 0)
        return `${h.atLeast ? 'At least ' : ''}${h.launched} other token${h.launched === 1 ? '' : 's'} · ${h.dead} with no trade in 24 h`;
      if (h && h.launched === 0) return 'No other token found from this creator';
      break;
    }
    case 'wallet-age':
      if (signal === 'concern') return 'Funded less than a day before the launch';
      break;
    case 'funding-trace': {
      const l = m?.linked;
      if (l && l.buyers > 0)
        return `${l.buyers} wallet${l.buyers === 1 ? '' : 's'} it funded bought this token`;
      if (l && l.wallets > 0)
        return `It funded ${l.wallets} wallet${l.wallets === 1 ? '' : 's'} around the launch`;
      break;
    }
    case 'volume-reality': {
      // The larger of the two groups: paid by the creator, or in the creation slot.
      const paid = m?.launch?.payerGroup;
      const slot = m?.launch?.sameSlot;
      const wallets = (n: number) => `${n} wallet${n === 1 ? '' : 's'}`;
      if (paid && paid.share >= GROUP_SHARE_MIN && (!slot || paid.share >= slot.share))
        return `${wallets(paid.wallets)} got ${pc(paid.share)} in transactions the creator paid for`;
      if (slot && slot.share >= GROUP_SHARE_MIN)
        return `${wallets(slot.wallets)} got ${pc(slot.share)} in the creation slot`;
      if (signal === 'concern') return 'Many trades for few holders';
      break;
    }
    case 'sell-path':
      // A concern is said by its own fact, put first: a pause, frozen accounts, buys and no sale.
      if (signal === 'reassurance') return 'Nothing in the mint can stop a sale';
      break;
    case 'liquidity-move':
      if (signal === 'reassurance') return 'Pool liquidity burned or locked';
      break;
    case 'name-clone':
      if (signal === 'concern') return 'Its name or symbol is taken from another token';
      if (signal === 'quiet') return 'No borrowed name found';
      break;
  }
  const text = first ?? answer.limits[0] ?? '';
  return text.length > 96 ? `${text.slice(0, 93).trimEnd()}…` : text;
}
