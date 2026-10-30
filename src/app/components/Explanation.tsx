type Kind = 'reassuring' | 'attention' | 'divergent';

/** The kind of a section is read from its own heading, never from where it sits. */
function kindOf(heading: string): Kind {
  if (/^(?:where the signals diverge|là où les signaux divergent)/i.test(heading))
    return 'divergent';
  if (/^(?:what is reassuring|ce qui (?:est rassurant|rassure))/i.test(heading))
    return 'reassuring';
  return 'attention';
}

/** Only explicit section headings carry emphasis. Never infer risk from prose. */
export function Explanation({ text, offline }: { text: string; offline: boolean }) {
  const sections: { heading?: string; kind?: Kind; divergent: boolean; paragraphs: string[] }[] =
    [];
  for (const block of text.split(/\n\s*\n/).filter((value) => value.trim())) {
    const [firstLine = '', ...rest] = block.split('\n');
    const heading = firstLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/[:.—–\s]+$/, '');
    const knownHeading =
      /^(what is reassuring|what deserves attention|where the signals diverge(?:\s*[—–-].*)?|ce qui (?:est rassurant|rassure|mérite attention)|là où les signaux divergent(?:\s*[—–-].*)?)$/i.test(
        heading,
      );
    if (knownHeading) {
      const kind = kindOf(heading);
      sections.push({
        heading,
        kind,
        divergent: !offline && kind === 'divergent',
        paragraphs: rest.length ? [rest.join('\n')] : [],
      });
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
          className={section.divergent ? 'prose-block divergent' : 'prose-block'}
          data-kind={section.kind}
        >
          {section.heading && <h3>{section.heading}</h3>}
          {section.paragraphs.map((paragraph, paragraphIndex) => (
            // Emphasis markers are not rendered as emphasis: they would only show as asterisks.
            <p key={paragraphIndex}>{paragraph.replace(/\*\*/g, '')}</p>
          ))}
        </div>
      ))}
    </div>
  );
}
