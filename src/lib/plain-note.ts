/**
 * A source note as a reader can take it. Notes are built for the logs
 * ("timeout : solana-rpc : request timed out after 8000 ms"); the page and
 * the offline text show what happened, not
 * the error's kind and source name (staging, 16/11/2026).
 */
export function readableNote(note: string, { sentence = false } = {}): string {
  const text = note
    // "<kind> : <source> : " then, for an incomplete answer, "incomplete data — ".
    .replace(/^(?:[a-z][a-z-]* : )?[a-z][a-z-]* : (?:incomplete data\s*[—-]\s*)?/i, '')
    .trim();
  if (/network request failed|timed? ?out|did not answer|fetch failed/i.test(text))
    return `${sentence ? 'T' : 't'}he source did not answer this time; try again in a minute`;
  if (!text) return note;
  // Shown on its own, a note starts as a sentence; inside the offline text it
  // sits in parentheses and keeps its case.
  return sentence ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
