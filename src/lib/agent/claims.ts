import type { TokenReport } from '../contracts';

/**
 * Claims the model's text may not make, checked against the facts it was
 * given. The prompt forbids them; this is the check after the fact, sentence
 * by sentence, because the audit of 18/10/2026 found each of them in served
 * text:
 *
 *  - `only-token`: "The creator has launched only this one token" (DELTA),
 *    "it covers only this one token" (Mike), while SEAL lists launches on
 *    some launchpads only. Never true as stated.
 *  - `clean-record`: "the creator's own record looks clean" (Mike), with a
 *    creator sale measured on this token.
 *  - `no-sale`: "has not been seen selling", with a sale measured.
 *  - `no-link`: "no link between the creator and the holders", with holders
 *    measured as having received the creator's tokens.
 *  - `took-nothing`: "it took no supply in the launch block" (MUT8), while
 *    the creator's own launch transaction delivered 71.4 % to three
 *    contracts.
 */
export type ClaimKind = 'only-token' | 'clean-record' | 'no-sale' | 'no-link' | 'took-nothing';

export type Claim = { kind: ClaimKind; sentence: string };

const ONLY_TOKEN: RegExp[] = [
  /\bonly\s+(?:this\s+)?(?:one\s+|single\s+)?(?:token|launch)\b/i,
  /\b(?:just|a\s+single)\s+(?:this\s+)?(?:one\s+)?(?:token|launch)\b(?!\s+(?:of|by)\s+(?:others|other))/i,
  /\b(?:launched|created|deployed)\s+(?:only|just)\b/i,
  /\b(?:its|their|the\s+creator[’']s|this\s+creator[’']s|the\s+wallet[’']s)\s+(?:very\s+)?first\s+(?:token|launch)\b/i,
  /\bfirst\s+(?:token|launch)\s+(?:by|from|of)\s+(?:this|the|its)\s+(?:creator|wallet)\b/i,
  /\bnever\s+launched\s+(?:any|another|other)\b/i,
  /\bno\s+(?:other|prior|previous|earlier)\s+(?:tokens?|launch(?:es)?)\b(?!\s+(?:that|which|where|was|were|has\s+been|have\s+been)?\s*(?:found|seen|listed|recorded|that|which|where)\b)/i,
];

const CLEAN: RegExp[] = [/\bclean\b/i, /\bspotless\b/i, /\bunblemished\b/i];

const NO_SALE: RegExp[] = [
  /\b(?:has\s+not|hasn[’']t|did\s+not|didn[’']t|never)\s+(?:been\s+seen\s+)?(?:sell|sold|selling)\b/i,
  /\bno\s+(?:creator\s+)?sales?\b(?!\s+(?:of|on)\s+(?:its\s+)?other)/i,
  /\bwithout\s+(?:any\s+)?(?:creator\s+)?sales?\b/i,
  /\bshows?\s+no\s+sales?\b/i,
];

const NO_LINK: RegExp[] = [
  /\bno\s+(?:\w+\s+)?(?:link|connection|relation(?:ship)?|tie)s?\b/i,
  /\bnot\s+(?:\w+\s+)?(?:linked|connected|related)\b/i,
  /\bunrelated\b/i,
  /\bunlinked\b/i,
];

const TOOK_NOTHING: RegExp[] = [
  /\btook\s+no(?:thing|\s+supply|\s+tokens?)?\b/i,
  /\breceived\s+nothing\b/i,
  /\b(?:took|received|kept)\s+none\b/i,
];

const own = (report: TokenReport) =>
  report.creator.data.tokens.find(
    (t) => String(t.address).toLowerCase() === report.token.toLowerCase(),
  );

/** Which claims the facts forbid for this report. */
export function forbiddenClaims(report: TokenReport): Set<ClaimKind> {
  const kinds = new Set<ClaimKind>(['only-token']);
  const tokens = report.creator.completeness === 'unavailable' ? [] : report.creator.data.tokens;
  const summary = report.launch?.data.summary;
  const soldHere = own(report)?.creatorDumped === true || (summary?.creatorSold ?? 0) > 0;
  if (soldHere || tokens.some((t) => t.creatorDumped === true)) kinds.add('clean-record');
  if (soldHere) kinds.add('no-sale');
  const links = report.holders.data.creatorLinks;
  if (
    (links && (links.holders.length > 0 || links.distributors.length > 0)) ||
    (summary?.creatorTx?.share ?? 0) >= 0.01
  ) {
    kinds.add('no-link');
  }
  if ((summary?.creatorTx?.share ?? 0) >= 0.01) kinds.add('took-nothing');
  return kinds;
}

const PATTERNS: Record<ClaimKind, RegExp[]> = {
  'only-token': ONLY_TOKEN,
  'clean-record': CLEAN,
  'no-sale': NO_SALE,
  'no-link': NO_LINK,
  'took-nothing': TOOK_NOTHING,
};

/** Sentences of a paragraph, keeping their final punctuation ("0.34%" is not an end). */
function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Some claims are only that claim when they are about the creator or the holders. */
const ABOUT: Partial<Record<ClaimKind, RegExp>> = {
  'no-link': /\b(?:creator|holders?|wallets?|addresses|contracts?)\b/i,
  // "did not sell on its other launches" may be true: only this token's sale is measured here.
  'no-sale': /^(?!.*\bother\b).*\bcreator\b/i,
};

/** The claims in `text` that the facts of `report` forbid. */
export function findClaims(text: string, report: TokenReport): Claim[] {
  const kinds = forbiddenClaims(report);
  const found: Claim[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    for (const sentence of sentences(paragraph)) {
      for (const kind of kinds) {
        const about = ABOUT[kind];
        if (about && !about.test(sentence)) continue;
        if (PATTERNS[kind].some((p) => p.test(sentence))) {
          found.push({ kind, sentence });
          break;
        }
      }
    }
  }
  return found;
}

/**
 * The text without the sentences that make a forbidden claim. `null` when a
 * section would be left with nothing to say: the facts are then worded
 * offline instead.
 */
export function withoutClaims(
  text: string,
  report: TokenReport,
): { text: string | null; dropped: Claim[] } {
  const dropped = findClaims(text, report);
  if (dropped.length === 0) return { text, dropped };
  const banned = new Set(dropped.map((c) => c.sentence));
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => {
    const kept = sentences(paragraph).filter((s) => !banned.has(s));
    return kept.join(' ');
  });
  // A heading is a paragraph of its own; a body left empty means the
  // section said nothing else.
  const emptied = paragraphs.some((p, i) => p === '' && text.split(/\n{2,}/)[i]?.trim() !== '');
  if (emptied) return { text: null, dropped };
  return { text: paragraphs.join('\n\n'), dropped };
}
