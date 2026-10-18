import type { FailedRead, ReadId } from './contracts/report';

/**
 * Reads that failed this time, and what follows from it: what they would
 * have found is unknown, never absent. Measured on staging on 18/10/2026:
 * with the node rate-limiting, AI's report said "no other launch by this
 * creator was found" (80 really), GNRG's that the creator "did not sell",
 * and MEME's lost its creator — each served, and cached, as a clean finding.
 */

/**
 * A source note that says a read failed rather than found nothing: the error
 * kinds collect.ts writes (`rate-limit : …`, `timeout : …`), and the wording
 * of the reads that could not be completed.
 */
const FAILED_NOTE =
  /could not be read|rate-limit|request limit|busy|timed out|budget|unknown failure|did not answer|^(?:timeout|incomplete|upstream) : /i;

export function noteFailed(note: string | undefined): boolean {
  return FAILED_NOTE.test(note ?? '');
}

/** True when any of `sources` says its read failed. */
export function sourcesFailed(sources: readonly { note?: string }[]): boolean {
  return sources.some((s) => noteFailed(s.note));
}

/** The family of reads a source note belongs to. */
export type SourceFamily = 'creator' | 'holders' | 'market' | 'launch';

/** Which read a failed note of `family` is about. */
export function readOfNote(family: SourceFamily, note: string, creatorUnavailable = false): ReadId {
  if (family === 'holders') return 'holders';
  if (family === 'market') return 'market';
  if (family === 'launch') return 'launch-replay';
  if (creatorUnavailable) return 'creator';
  if (note === UNREAD.ownSales) return 'creator-sales';
  if (note === UNREAD.walletCount) return 'creator-wallet';
  if (note === UNREAD.removals || note === UNREAD.removalSenders) return 'liquidity';
  return 'creator-launches';
}

/**
 * One failed read per source note that says its read failed, in every family:
 * the same test as `sourcesFailed`, so a source the cache refuses as failed
 * is always named in the report's failed reads too (Wheel Smith: "its sales
 * by its creator could not be read this time", and no partial notice).
 */
export function failedReadsOfSources(families: {
  creator: { completeness: string; sources: readonly { note?: string }[] };
  holders: { sources: readonly { note?: string }[] };
  market: { sources: readonly { note?: string }[] };
  /** The launch replay: a part of it (receipts, codes, balances) that failed says so in its note. */
  launch?: { sources: readonly { note?: string }[] };
}): FailedRead[] {
  const out: FailedRead[] = [];
  const unavailable = families.creator.completeness === 'unavailable';
  for (const family of ['creator', 'holders', 'market', 'launch'] as const) {
    for (const source of families[family]?.sources ?? []) {
      if (!noteFailed(source.note)) continue;
      const note = source.note ?? '';
      out.push({ read: readOfNote(family, note, family === 'creator' && unavailable), note });
    }
  }
  return out;
}

/** What each read is about, for a reader: "some reads failed: …". */
export const READ_WORDS: Record<ReadId, string> = {
  creator: 'who created it and what they did before',
  'creator-launches': 'the creator’s other launches',
  'creator-sales': 'whether the creator sold this token',
  'launch-replay': 'the first minutes after its launch',
  holders: 'who holds it',
  market: 'its trading',
  'creator-wallet': 'how many transactions the creator’s wallet has sent',
  'creator-fees': 'the fees its creator took from its market',
  liquidity: 'what its pools hold and who removed liquidity',
  'market-rules': 'its markets’ trading rules',
  graduation: 'its progress toward graduation',
  questions: 'some of the ten questions',
};

/** One entry per read, the first note kept. */
export function mergeFailedReads(reads: readonly FailedRead[]): FailedRead[] {
  const seen = new Map<ReadId, FailedRead>();
  for (const r of reads) if (!seen.has(r.read)) seen.set(r.read, r);
  return [...seen.values()];
}

/** Whether `read` failed, in a list of failed reads (absent counts as none). */
export function readFailed(reads: readonly { read: ReadId }[] | undefined, read: ReadId): boolean {
  return (reads ?? []).some((r) => r.read === read);
}

/** Added to a failed read of the creator's sales when a sale was confirmed anyway. */
export const SALE_SEEN = '; a sale by the creator was still confirmed, by a trade in its market';

/** Source notes written when a read of the creator could not be completed. */
export const UNREAD = {
  /** The creator's transfers of this token, which tell its sales. */
  ownSales: 'this token’s sales by its creator could not be read this time',
  /** The other launches' sales and liquidity, left unchecked when the listing ran late. */
  otherChecks:
    'the creator’s other launches were listed, but their sales and liquidity could not be read this time',
  /** The indexer, which lists the launchpads the node cannot. */
  indexer: 'the SEAL indexer did not answer: the launches it lists could not be read this time',
  /** The creator's wallet: its transaction count. */
  walletCount: 'how many transactions the creator’s wallet has sent could not be read this time',
  /** Who sent the analysed token's liquidity removals, and what they returned. */
  removals: 'who removed this token’s liquidity, and to whom it went, could not be read this time',
  /**
   * The removals were read, and the most recent detailed, but not every
   * one's sender in time (a market busy with hundreds of removals): whether
   * the creator was among them is unknown.
   */
  removalSenders:
    'whether the creator removed any of this token’s liquidity could not be read this time: not every removal’s sender was read in time',
} as const;

/** The read a question fell back from when the indexer's count of a hook's markets did not answer. */
export const HOOK_COUNT_UNREAD_NOTE =
  'the chain-wide count of markets on this token’s trading rules (hook) could not be read this time; only the markets of about the last 50 minutes were compared';

/** The limit a question gives when its lookups ran out of time. */
export const QUESTION_TIMED_OUT = 'the on-chain lookups for this question did not finish in time';
/** The limit a question gives when it failed. */
export const QUESTION_FAILED = 'this question could not be answered for this token';

/**
 * Questions that did not finish in time, or failed, are a failed read:
 * AI's report answered six of ten "did not finish in time", served no
 * partial notice and was cached (staging, 18/10/2026).
 */
export function questionsFailed(unanswered: readonly string[], total: number): FailedRead | null {
  if (unanswered.length === 0) return null;
  return {
    read: 'questions',
    note: `${unanswered.length} of the ${total} questions did not finish in time or could not be answered this time (${unanswered.join(', ')})`,
  };
}
