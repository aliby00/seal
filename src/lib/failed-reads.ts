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

/** What each read is about, for a reader: "some reads failed: …". */
export const READ_WORDS: Record<ReadId, string> = {
  creator: 'who created it and what they did before',
  'creator-launches': 'the creator’s other launches',
  'creator-sales': 'whether the creator sold this token',
  'launch-replay': 'the first minutes after its launch',
  holders: 'who holds it',
  market: 'its trading',
  questions: 'some of the ten questions',
};

/** The same reads, said to the model (in the prompt's language). */
export const READ_WORDS_FR: Record<ReadId, string> = {
  creator: 'le créateur et son historique',
  'creator-launches': 'les autres lancements du créateur',
  'creator-sales': 'les ventes du créateur sur ce token',
  'launch-replay': 'les premières minutes après le lancement',
  holders: 'la liste des détenteurs',
  market: 'les échanges du token',
  questions: 'certaines des dix questions',
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

/** Source notes written when a read of the creator could not be completed. */
export const UNREAD = {
  /** The creator's transfers of this token, which tell its sales. */
  ownSales: 'this token’s sales by its creator could not be read this time',
  /** The indexer, which lists the launchpads the node cannot. */
  indexer: 'the SEAL indexer did not answer: the launches it lists could not be read this time',
} as const;

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
