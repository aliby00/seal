type Kind = 'reassuring' | 'attention' | 'divergent';

/** The kind of a section is read from its own heading, never from where it sits. */
function kindOf(heading: string): Kind {
  if (/^(?:where the signals diverge|là où les signaux divergent)/i.test(heading))
    return 'divergent';
  if (/^(?:what is reassuring|what is clean|ce qui (?:est rassurant|rassure))/i.test(heading))
    return 'reassuring';
  return 'attention';
}

/**
 * The headings a reading is written under: "What stands out" and "What is
 * clean" since 26/11/2026; the three sections before it stay readable, for
 * the answers cached with them.
 */
const KNOWN_HEADING =
  /^(what stands out|what is clean|what is reassuring|what deserves attention|where the signals diverge(?:\s*[—–-].*)?|ce qui (?:est rassurant|rassure|mérite attention)|là où les signaux divergent(?:\s*[—–-].*)?)$/i;

/** One fact per line under "What stands out": a trader scans lines, a paragraph is read. */
const STANDS_OUT = /^what stands out$/i;

/** Sentences, keeping their end ("0.68%" or "$2.0k." is not cut inside). */
export function sentencesOf(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z"“(\d])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The closing line on what could not be read: said quietly, apart from the findings. */
const NOT_READ = /^not read this time\b/i;

/** Only explicit section headings carry emphasis. Never infer risk from prose. */
export function Explanation({ text, offline }: { text: string; offline: boolean }) {
  const sections: {
    heading?: string;
    kind?: Kind;
    divergent: boolean;
    limits?: boolean;
    paragraphs: string[];
  }[] = [];
  for (const block of text.split(/\n\s*\n/).filter((value) => value.trim())) {
    const [firstLine = '', ...rest] = block.split('\n');
    const heading = firstLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/[:.—–\s]+$/, '');
    if (KNOWN_HEADING.test(heading)) {
      const kind = kindOf(heading);
      sections.push({
        heading,
        kind,
        divergent: !offline && kind === 'divergent',
        paragraphs: rest.length ? [rest.join('\n')] : [],
      });
    } else if (NOT_READ.test(block.trim())) {
      sections.push({ divergent: false, limits: true, paragraphs: [block.trim()] });
    } else {
      if (!sections.length) sections.push({ divergent: false, paragraphs: [] });
      sections[sections.length - 1]?.paragraphs.push(block);
    }
  }
  return (
    <div className="explanation">
      {sections.map((section, index) => (
        <div
          key={index}
          className={
            section.divergent
              ? 'prose-block divergent'
              : section.limits
                ? 'prose-block prose-limits'
                : 'prose-block'
          }
          data-kind={section.kind}
        >
          {section.heading && <h3>{section.heading}</h3>}
          {section.heading && STANDS_OUT.test(section.heading) ? (
            <ul className="stands-list">
              {section.paragraphs
                .flatMap((paragraph) => sentencesOf(paragraph.replace(/\*\*/g, '')))
                .map((sentence, i) => (
                  <li key={i}>{sentence}</li>
                ))}
            </ul>
          ) : (
            section.paragraphs.map((paragraph, paragraphIndex) => (
              // Emphasis markers are not rendered as emphasis: they would only show as asterisks.
              <p key={paragraphIndex}>{paragraph.replace(/\*\*/g, '')}</p>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
