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
 * kinds the readers write (`rate-limit : …`, `timeout : …`), the Solana
 * readers' caps ("call cap of 60 reached", "time allowance used up", "the
 * allowance of calls for this read was spent"), the wording of the reads
 * that could not be completed ("… could not be read"), or an error message
 * of a source quoted in the note ("solana-rpc : node answered 503").
 */
const FAILED_NOTE =
  /could not be read|could not all be listed|rate-limit|request limit|busy|timed out|budget|unknown failure|unexpected error|did not answer|cap of \d+(?: ms)? reached|allowance (?:used up|spent)|allowance of calls|time allowed for this read ran out|not served by the configured nodes|(?:solana-rpc|dexscreener-solana) : |^(?:timeout|incomplete|upstream) : /i;

export function noteFailed(note: string | undefined): boolean {
  return FAILED_NOTE.test(note ?? '');
}

/** True when any of `sources` says its read failed. */
export function sourcesFailed(sources: readonly { note?: string }[]): boolean {
  return sources.some((s) => noteFailed(s.note));
}

/** A block of the report as the failed reads see it: its completeness and its sources. */
export type ReadBlock = { completeness: string; sources: readonly { note?: string }[] };

/**
 * The failed read of one block: when one of its notes says a read failed
 * (an error, a cap, a node that refused). A block that is partial or
 * unavailable by nature is not a failure: no pool to read for a token on its
 * curve, no pair listed, a history longer than what is read, a window cut at
 * its last transaction. Its note says what was left out, and asking again
 * would not change it.
 */
export function failedReadOf(read: ReadId, block: ReadBlock | null | undefined): FailedRead | null {
  if (!block) return null;
  const failedNote = block.sources.find((s) => noteFailed(s.note))?.note;
  return failedNote === undefined ? null : { read, note: failedNote };
}

/** What each read is about, for a reader: "some reads failed: …". */
export const READ_WORDS: Record<ReadId, string> = {
  token: 'what the token’s mint allows (supply, authorities, extensions)',
  creator: 'who created it',
  'creator-launches': 'the creator’s other launches',
  'creator-sales': 'what the creator did with this token',
  'linked-wallets': 'who funded the creator and the wallets it funded',
  'launch-replay': 'the first minutes after its launch',
  holders: 'who holds it',
  market: 'its trading',
  liquidity: 'what its pools hold',
  graduation: 'its launchpad and its progress toward graduation',
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
