/**
 * A source note as a reader can take it. Notes are built for the logs
 * ("timeout : solana-rpc : request timed out after 8000 ms", "upstream:
 * solana-rpc : getTokenLargestAccounts: not served by the configured
 * nodes"); the page and the offline text show what happened, not the
 * error's kind, the source's name or the RPC method (staging, 16/11/2026).
 */
export function readableNote(note: string, { sentence = false } = {}): string {
  const text = note
    // "<kind> : <source> : " then, for an incomplete answer, "incomplete data — ".
    .replace(/^(?:[a-z][a-z-]* : )?[a-z][a-z-]* : (?:incomplete data\s*[—-]\s*)?/i, '')
    // A node's refusal quoted inside a note: the method name means nothing to a reader.
    .replace(
      /\(?(?:upstream: )?(?:solana-rpc|dexscreener-solana) : \w+: not served by the configured nodes\)?/gi,
      '(the Solana node used does not serve this read)',
    )
    .trim();
  if (/network request failed|timed? ?out|did not answer|fetch failed/i.test(text))
    return `${sentence ? 'T' : 't'}he source did not answer this time; try again in a minute`;
  if (/^(?:request limit reached|rate.?limit(?:ed)?|too many requests|429)\b/i.test(text))
    return `${sentence ? 'T' : 't'}he source limited requests this time; try again in a minute`;
  if (!text) return note;
  // Shown on its own, a note starts as a sentence; inside the offline text it
  // sits in parentheses and keeps its case.
  return sentence ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
