import type { TokenReport } from '../contracts';
import { readFailed } from '../failed-reads';

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
 *
 * And from the fourth audit (staging, 18/10/2026):
 *
 *  - `unread`: an absence a failed read would have settled — "no other
 *    launch" while the listing did not answer (AI: 80 launches), "did not
 *    sell" while the creator's history was rate-limited (GNRG);
 *  - `immutable`: "nothing can be rewritten later" (MEME), said of a market
 *    without a hook while the token's own contract is not checked;
 *  - `count`: a count the data gives otherwise — "two early buyers" for 3
 *    (ECOGPT), "five of the top holders" for 6 (BOOMER), "189 early buyers
 *    holding 97 %" for a share they bought (MUT8).
 */
export type ClaimKind =
  | 'only-token'
  | 'clean-record'
  | 'no-sale'
  | 'no-link'
  | 'took-nothing'
  | 'unread'
  | 'immutable'
  | 'count';

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

const NO_OTHER_LAUNCH: RegExp[] = [
  /\bno\s+(?:other|prior|previous|earlier|further|additional)\s+(?:tokens?|launch(?:es)?)\b/i,
  /\bnot?\s+(?:any\s+)?(?:other|another)\s+(?:tokens?|launch(?:es)?)\b/i,
  /\bno\s+(?:launch|creator)\s+history\b/i,
];

const NOTHING_AT_LAUNCH: RegExp[] = [
  ...TOOK_NOTHING,
  /\b(?:bought|received|got)\s+(?:nothing|none)\b/i,
  /\bno\s+(?:early\s+|first\s+)?(?:buyers?|buys)\b/i,
];

const NO_TRADE: RegExp[] = [/\bno\s+(?:trades?|trading|swaps?|sells?|buys?)\b/i];

const IMMUTABLE: RegExp[] = [
  /\bnothing\s+(?:\w+\s+){0,3}(?:can|could)\s+(?:\w+\s+)?be\s+(?:rewritten|changed|altered|modified|upgraded)\b/i,
  /\bimmutable\b/i,
  /\bcan(?:not|['’]t|\s+never)\s+be\s+(?:rewritten|changed|altered|modified|upgraded)\b/i,
];

const own = (report: TokenReport) =>
  report.creator.data.tokens.find(
    (t) => String(t.address).toLowerCase() === report.token.toLowerCase(),
  );

/** The absences a failed read leaves unknown, as patterns: never said (GNRG, AI, MEME). */
export function unreadPatterns(report: TokenReport): RegExp[] {
  const failed = report.failedReads ?? [];
  const creator = readFailed(failed, 'creator');
  return [
    ...(creator || readFailed(failed, 'creator-launches') ? NO_OTHER_LAUNCH : []),
    ...(creator || readFailed(failed, 'creator-sales') ? NO_SALE : []),
    ...(readFailed(failed, 'launch-replay') ? NOTHING_AT_LAUNCH : []),
    ...(readFailed(failed, 'holders') ? NO_LINK : []),
    ...(readFailed(failed, 'market') ? NO_TRADE : []),
  ];
}

/** Which claims the facts forbid for this report. */
export function forbiddenClaims(report: TokenReport): Set<ClaimKind> {
  const kinds = new Set<ClaimKind>(['only-token', 'immutable']);
  if (unreadPatterns(report).length > 0) kinds.add('unread');
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

const PATTERNS: Record<Exclude<ClaimKind, 'unread' | 'count'>, RegExp[]> = {
  'only-token': ONLY_TOKEN,
  'clean-record': CLEAN,
  'no-sale': NO_SALE,
  'no-link': NO_LINK,
  'took-nothing': TOOK_NOTHING,
  immutable: IMMUTABLE,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

const numberOf = (word: string): number | null => {
  const lower = word.toLowerCase();
  if (lower in NUMBER_WORDS) return NUMBER_WORDS[lower] ?? null;
  const n = Number(lower.replace(/,/g, ''));
  return Number.isInteger(n) ? n : null;
};

const NUMBER =
  '(\\d[\\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';

/** "the two early buyers", "3 wallets that bought in the first minute". */
const EARLY_COUNT = new RegExp(
  `\\b${NUMBER}\\s+(?:\\w+\\s+){0,2}?(?:early|earliest|first)\\s+(?:\\w+\\s+)?(?:buyers?|wallets?|addresses)\\b`,
  'i',
);
/** "five of the top holders", "6 of the largest holders". */
const LINKED_COUNT = new RegExp(
  `\\b${NUMBER}\\s+(?:other\\s+)?(?:of\\s+the\\s+)?(?:\\w+\\s+)?(?:top|largest|biggest)\\s+(?:\\w+\\s+)?holders?\\b`,
  'i',
);

const percents = (share: number): string[] => {
  const x = share * 100;
  return [...new Set([x.toFixed(0), x.toFixed(1), x.toFixed(2)])].map((v) => v.replace('.', '\\.'));
};

/**
 * A count in `sentence` the report gives otherwise: the early buyers, the
 * largest holders linked to the creator, or a share the early buyers bought
 * told as one they held.
 */
export function countMismatch(sentence: string, report: TokenReport): boolean {
  const early = report.launch?.data.summary?.early;
  if (early) {
    const m = EARLY_COUNT.exec(sentence);
    const n = m?.[1] ? numberOf(m[1]) : null;
    if (n !== null && n !== early.wallets) return true;
    // MUT8: "189 early buyers holding 97% at launch" — they bought it.
    if (early.share > 0 && /\b(?:early|earliest|first)\b/i.test(sentence)) {
      const held = new RegExp(
        `\\b(?:holding|held|hold)\\s+(?:about\\s+|roughly\\s+|some\\s+|nearly\\s+|almost\\s+)?(?:${percents(early.share).join('|')})\\s?%`,
        'i',
      );
      if (held.test(sentence)) return true;
    }
  }
  const h = report.holders.data;
  // WAFER: "the only creator transfer outside markets went to a burn
  // address", while it also sent 0.11 % to a wallet.
  if (
    (h.creatorLinks?.sentTo ?? 0) > 0 &&
    /\bonly\b[^.]*\b(?:transfers?|sends?|sent)\b[^.]*\bburn/i.test(sentence)
  ) {
    return true;
  }
  if (h.creatorLinks && /\breceived\b|\bfrom\s+the\s+creator\b|\blinked\b/i.test(sentence)) {
    const m = LINKED_COUNT.exec(sentence);
    const n = m?.[1] ? numberOf(m[1]) : null;
    if (n !== null) {
      const shown = h.top.filter((t) => t.kind === 'wallet' || t.kind === 'contract').slice(0, 8);
      const k = shown.filter((t) => t.fromCreator).length;
      const allowed = new Set([k, h.top.filter((t) => t.fromCreator).length]);
      if (/\bother\b/i.test(sentence) && shown[0]?.fromCreator) allowed.add(k - 1);
      if (!allowed.has(n)) return true;
    }
  }
  return false;
}

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
  const unread = unreadPatterns(report);
  const found: Claim[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    for (const sentence of sentences(paragraph)) {
      let hit: ClaimKind | undefined;
      for (const kind of kinds) {
        if (kind === 'unread' || kind === 'count') continue;
        const about = ABOUT[kind];
        if (about && !about.test(sentence)) continue;
        if (PATTERNS[kind].some((p) => p.test(sentence))) {
          hit = kind;
          break;
        }
      }
      // A sentence that says the read failed is not an absence: "could not be read".
      if (
        !hit &&
        unread.some((p) => p.test(sentence)) &&
        !/could\s+not\s+be\s+(?:read|listed)|not\s+(?:read|measured)|unknown|failed/i.test(sentence)
      ) {
        hit = 'unread';
      }
      if (!hit && countMismatch(sentence, report)) hit = 'count';
      if (hit) found.push({ kind: hit, sentence });
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
