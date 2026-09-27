/** Only explicit section headings carry emphasis. Never infer risk from prose. */
export function Explanation({ text, offline }: { text: string; offline: boolean }) {
  const sections: { heading?: string; divergent: boolean; paragraphs: string[] }[] = [];
  for (const block of text.split(/\n\s*\n/).filter((value) => value.trim())) {
    const [firstLine = '', ...rest] = block.split('\n');
    const heading = firstLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/[:.—–\s]+$/, '');
    const knownHeading =
      /^(ce qui (?:est rassurant|rassure|mérite attention)|là où les signaux divergent(?:\s*[—–-].*)?)$/i.test(
        heading,
      );
    if (knownHeading) {
      sections.push({
        heading,
        divergent: !offline && /^là où les signaux divergent/i.test(heading),
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
        <div key={index} className={section.divergent ? 'prose-block divergent' : 'prose-block'}>
          {section.heading && <h3>{section.heading}</h3>}
          {section.paragraphs.map((paragraph, paragraphIndex) => (
            <p key={paragraphIndex}>{paragraph}</p>
          ))}
        </div>
      ))}
    </div>
  );
}
