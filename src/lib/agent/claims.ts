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
 *
 * And from the fifth (staging, 18/10/2026):
 *
 *  - `into-pools`: "that launch transaction, which delivered into pools"
 *    (MUT8), while it delivered 71.43 % to three contracts that are not
 *    pools;
 *  - a count of the creator's "other" launches given with this token in
 *    it, "sold in 8 of 10 other checked launches" for 7 of 9 (ASTEROID): it
 *    is corrected in place rather than cut.
 *
 * And from the seventh (staging, 18/10/2026):
 *
 *  - `remover-unknown`: "who removed it is not stated here" (MOON), while the
 *    data names the sender of the removal transaction (the creator) and
 *    where the market returned the token (48.07 % of the supply, to it).
 *
 * A cut never leaves a dangling sentence behind: "It also took tokens out…"
 * opened AML's section once the sentence before it was cut. The next
 * sentence gets its subject back, or goes too.
 */
export type ClaimKind =
  | 'only-token'
  | 'clean-record'
  | 'no-sale'
  | 'no-link'
  | 'took-nothing'
  | 'unread'
  | 'immutable'
  | 'count'
  | 'into-pools'
  | 'remover-unknown';

export type Claim = { kind: ClaimKind; sentence: string };

const ONLY_TOKEN: RegExp[] = [
  // "its only launch SEAL could check", "only this token’s sales" are true.
  /\bonly\s+(?:this\s+)?(?:one\s+|single\s+)?(?:token|launch)\b(?![’']s\b|\s+(?:SEAL\s+)?(?:could|was|were|that\s+(?:SEAL\s+)?could|checked|read|listed|measured)\b)/i,
  /\b(?:just|a\s+single)\s+(?:this\s+)?(?:one\s+)?(?:token|launch)\b(?!\s+(?:of|by)\s+(?:others|other))/i,
  /\b(?:launched|created|deployed)\s+(?:only|just)\b/i,
  // "its first launch window" is a time, not a claim about the record.
  /\b(?:its|their|the\s+creator[’']s|this\s+creator[’']s|the\s+wallet[’']s)\s+(?:very\s+)?first\s+(?:token|launch)\b(?!\s+(?:window|block|minutes?|seconds?|hours?|days?|transaction|pool|price|buyers?)\b)/i,
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
  // MUT8: the launch transaction delivered to contracts, which are not pools.
  if ((summary?.creatorTx?.share ?? 0) >= 0.01) kinds.add('into-pools');
  // MOON: the sender of the removal transaction is in the data.
  if ((own(report)?.liquidityRemovals?.length ?? 0) > 0) kinds.add('remover-unknown');
  return kinds;
}

/** "that launch transaction, which delivered into pools" (MUT8). */
const INTO_POOLS: RegExp[] = [
  /\blaunch\s+transaction\b[^.]*\b(?:delivered|sent|went|put|placed)\s+(?:\w+\s+){0,4}?(?:into|to|in)\s+(?:the\s+|its\s+|a\s+)?(?:pools?|liquidity|markets?)\b/i,
  /\b(?:delivered|sent)\s+(?:\w+\s+){0,4}?into\s+(?:the\s+|its\s+)?pools?\b[^.]*\blaunch\s+transaction\b/i,
];

/** "Who removed it is not stated here" (MOON), with the remover in the data. */
const REMOVER_UNKNOWN: RegExp[] = [
  /\bwho\s+(?:removed|pulled|withdrew|took\s+out)\b[^.]*\b(?:not\s+(?:stated|known|shown|said|given|clear|identified|named|recorded)|unknown|unclear|cannot\s+be\s+(?:told|said|identified|named))/i,
  /\b(?:not\s+(?:stated|known|shown|said|clear)|unknown|unclear)\b[^.]*\bwho\s+(?:removed|pulled|withdrew)\b/i,
  /\b(?:removed|pulled|withdrawn)\s+by\s+(?:an?\s+)?(?:unknown|unidentified|unnamed)\b/i,
];

const PATTERNS: Record<Exclude<ClaimKind, 'unread' | 'count'>, RegExp[]> = {
  'remover-unknown': REMOVER_UNKNOWN,
  'into-pools': INTO_POOLS,
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
      if (!hit && (countMismatch(sentence, report) || othersCountMismatch(sentence, report)))
        hit = 'count';
      if (hit) found.push({ kind: hit, sentence });
    }
  }
  return found;
}

/** "8 of 10 other launches", "seven of the nine earlier launches". */
const OTHERS_COUNT = new RegExp(
  `\\b${NUMBER}\\s+(of|out\\s+of)\\s+((?:the|its|their)\\s+)?${NUMBER}\\s+(other|previous|earlier|prior)\\b`,
  'gi',
);

/**
 * The creator's sales over its other launches, this token left out: the
 * total the data gives (8 of 10, this token included) is not a count of
 * the others (7 of 9). `null` when this token's own sale is not known.
 */
export function otherLaunchSales(
  report: TokenReport,
): { sold: number; checked: number; totalSold: number; totalChecked: number } | null {
  if (report.creator.completeness === 'unavailable') return null;
  const checked = report.creator.data.tokens.filter((t) => t.creatorDumped !== null);
  const self = own(report);
  if (!self || self.creatorDumped === null || !checked.includes(self)) return null;
  const others = checked.filter((t) => t !== self);
  return {
    sold: others.filter((t) => t.creatorDumped === true).length,
    checked: others.length,
    totalSold: checked.filter((t) => t.creatorDumped === true).length,
    totalChecked: checked.length,
  };
}

/**
 * The text with each count of "other" launches the creator sold on set to
 * what the data says of the others: "sold in 8 of 10 other checked
 * launches" said this token in the count (ASTEROID). Only a count that is
 * the total, this token included, is corrected; another one is cut.
 */
export function correctOtherCounts(text: string, report: TokenReport): string {
  const counts = otherLaunchSales(report);
  if (!counts) return text;
  return text
    .split(/\n{2,}/)
    .map((paragraph) =>
      sentences(paragraph)
        .map((sentence) => {
          if (!/\b(?:sold|sell|sells|selling|sales?)\b/i.test(sentence)) return sentence;
          return sentence.replace(
            OTHERS_COUNT,
            (match, a: string, of: string, the: string | undefined, b: string, word: string) => {
              const x = numberOf(a);
              const y = numberOf(b);
              if (x === counts.totalSold && y === counts.totalChecked) {
                return `${counts.sold} ${of} ${the ?? ''}${counts.checked} ${word}`;
              }
              return match;
            },
          );
        })
        .join(' '),
    )
    .join('\n\n');
}

/** A count of the other launches that is neither theirs nor the total: cut. */
function othersCountMismatch(sentence: string, report: TokenReport): boolean {
  const counts = otherLaunchSales(report);
  if (!counts || !/\b(?:sold|sell|sells|selling|sales?)\b/i.test(sentence)) return false;
  for (const m of sentence.matchAll(OTHERS_COUNT)) {
    const x = m[1] ? numberOf(m[1]) : null;
    const y = m[4] ? numberOf(m[4]) : null;
    if (x === null || y === null) continue;
    if (x !== counts.sold || y !== counts.checked) return true;
  }
  return false;
}

/** A sentence that leans on the one before it: "It also took…", "This came…". */
const DANGLING = /^(?:It|Its|They|Their|This|That|These|Those|He|She|Also|Both|Such)\b/;
/** Who the sentence before was about, when it says so plainly. */
const SUBJECT =
  /^(The creator(?:[’']s wallet)?|The creator wallet|This token|The token|The largest holder|The market|The main pool)\b/;

/**
 * Openers that sum up what came before (staging, 18/10/2026): "Together,
 * that means no visible holder cluster tied to the creator remains" after a
 * single sentence about liquidity (Mike), and "The two reads use different
 * methods…" opening a section with no two reads named before (MUT8).
 */
const SUMMING = /^(?:(?:Taken|Put)\s+together|Together|Combined|In\s+sum|All\s+told)\b/i;
const PAIRED = /^(?:(?:The|These|Those)\s+two|Both(?:\s+of\s+the(?:se)?)?)\s+(\w+)/i;

const STOP = new Set(
  'about after again against also among because before being between both could does during every from have here into just more most much only other over same such than that their them then there these they this those through under very what when where which while with would your that'.split(
    ' ',
  ),
);

/** The words of a sentence that carry its content, singular. */
function contentWords(sentence: string): Set<string> {
  return new Set(
    (sentence.toLowerCase().match(/[a-z][a-z’'-]{3,}/g) ?? [])
      .map((w) => w.replace(/[’']s$/, '').replace(/(?:es|s)$/, ''))
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

/**
 * Whether `sentence`, which points back at what came before, is borne out
 * by the sentences kept before it in its section: a sum needs two of them
 * and something in common with them, "the two reads" needs reads named.
 */
function supported(sentence: string, before: readonly string[], afterCut: boolean): boolean {
  const paired = PAIRED.exec(sentence);
  if (paired) {
    if (before.length === 0 || afterCut) return false;
    const noun = paired[1]!.toLowerCase().replace(/(?:es|s)$/, '');
    return before.some((b) => contentWords(b).has(noun));
  }
  if (SUMMING.test(sentence)) {
    if (before.length < 2 || afterCut) return false;
    const earlier = new Set(before.flatMap((b) => [...contentWords(b)]));
    return [...contentWords(sentence)].some((w) => earlier.has(w));
  }
  return true;
}

/**
 * Keeps a paragraph readable once sentences are cut from it: the sentence
 * after a cut one loses its "also", and a pronoun that pointed at the cut
 * sentence gets that sentence's subject back. A sentence whose reference
 * cannot be restored is cut too, and so is one that sums up, or names "the
 * two" of, what the sentences before it do not state.
 */
function coherent(all: readonly string[], banned: ReadonlySet<string>): string[] {
  const kept: string[] = [];
  let lastCut: string | null = null;
  for (const sentence of all) {
    if (banned.has(sentence)) {
      lastCut = sentence;
      continue;
    }
    if (!supported(sentence, kept, lastCut !== null)) {
      lastCut = sentence;
      continue;
    }
    if (lastCut === null) {
      kept.push(sentence);
      continue;
    }
    let s = sentence.replace(/^(\S+(?:\s+\S+)?)\s+also\s+/i, '$1 ').replace(/^Also,?\s+/i, '');
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (DANGLING.test(s)) {
      const subject = SUBJECT.exec(lastCut)?.[1];
      if (subject && /^It\b/.test(s)) s = s.replace(/^It\b/, subject);
      else if (subject && /^Its\b/.test(s)) s = s.replace(/^Its\b/, `${subject}’s`);
      else {
        // Nothing to point at any more: this one goes too.
        lastCut = sentence;
        continue;
      }
    }
    kept.push(s);
    lastCut = null;
  }
  return kept;
}

/** The section headings the prompt asks for, numbered or not. */
const HEADING =
  /^(?:\d+[.)]\s*)?(?:What is reassuring|What deserves attention|Where the signals diverge)\b[^.!?]*$/i;

/** Words of emphasis from the prompt, copied into the text: dropped. */
const EMPHASIS = /\b(?:EXACTLY|EXACTEMENT|PRECISELY|EXACT)\b\s*(\S?)/g;
/**
 * Prompt markers in capitals ("NEVER", "ONLY", "THIS TOKEN", "AT LEAST"):
 * lowercased, outside quoted on-chain names, whose capitals are their own.
 */
const SHOUTED =
  /\b(?:NEVER|ALWAYS|ONLY|NOT|NONE|NO|ALL|EVERY|IN TOTAL|TOTAL|BOUGHT|SOLD|HELD|HOLDS?|CREATOR|OTHERS?|THIS TOKEN|THIS|AT LEAST|MINIMUM|UNKNOWN|MEASURED FACT|MEASURED|BEFORE|AND|NOR|OR|AU MOINS|JAMAIS|TOUS|CE TOKEN|NON LUES|INCONNU|VENDU|CRÉATEUR)\b/g;

/** Whether `offset` in `text` starts a sentence. */
const startsSentence = (text: string, offset: number) =>
  /(?:^|[.!?:]\s+|\n\s*)$/.test(text.slice(0, offset));

/** The text without the prompt's words of emphasis: "EXACTEMENT 6 of the 8" (ROBINHOOD), "EXACTLY 70" (OWN). */
export function withoutEmphasis(text: string): string {
  return text
    .split(/(["“][^"”\n]*["”])/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const shouted = part.replace(SHOUTED, (word: string, offset: number) => {
        const lower = word.toLowerCase();
        return startsSentence(part, offset)
          ? lower.charAt(0).toUpperCase() + lower.slice(1)
          : lower;
      });
      // The word goes; what followed it opens the sentence when the word did.
      return shouted.replace(EMPHASIS, (_: string, next: string, offset: number, whole: string) =>
        startsSentence(whole, offset) ? next.toUpperCase() : next,
      );
    })
    .join('');
}

/**
 * The text without the sentences that make a forbidden claim, or that point
 * at nothing. A section left with nothing to say is left out; `null` when
 * none is left: the facts are then worded offline instead.
 */
export function withoutClaims(
  text: string,
  report: TokenReport,
): { text: string | null; dropped: Claim[] } {
  const corrected = correctOtherCounts(withoutEmphasis(text), report);
  const dropped = findClaims(corrected, report);
  const banned = new Set(dropped.map((c) => c.sentence));
  const original = corrected.split(/\n{2,}/);
  const paragraphs = original.map((paragraph) =>
    HEADING.test(paragraph.trim()) ? paragraph : coherent(sentences(paragraph), banned).join(' '),
  );
  // Nothing cut: the text is served as written.
  if (
    dropped.length === 0 &&
    paragraphs.every((p, i) => HEADING.test(p.trim()) || p === sentences(original[i]!).join(' '))
  ) {
    return { text: corrected, dropped };
  }
  // A heading is a paragraph of its own: one whose body is left empty goes
  // with it, and a body left empty under no heading goes alone.
  const out: string[] = [];
  let said = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]!;
    if (HEADING.test(p.trim())) {
      const body = paragraphs[i + 1];
      if (body === undefined || body === '' || HEADING.test(body.trim())) {
        if (body === '') i++;
        continue;
      }
      out.push(p);
      continue;
    }
    if (p === '' && original[i]?.trim() !== '') continue;
    out.push(p);
    said++;
  }
  if (said === 0) return { text: null, dropped };
  return { text: out.join('\n\n'), dropped };
}
