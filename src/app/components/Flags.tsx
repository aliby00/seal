import type { Flag } from '@/lib/flags';

const TONE_WORD: Record<Flag['tone'], string> = { red: 'Red', orange: 'Orange', green: 'Green' };

/**
 * SEAL's flags, one fact per line, red, orange or green by fixed rules
 * (lib/flag-rules.ts). The colour is also said in words for screen readers.
 */
export function Flags({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="flag-list" aria-label="Flags, one fact each">
      {flags.map((f) => (
        <li key={f.id} className="flag" data-tone={f.tone}>
          <span className="flag-dot" aria-hidden="true" />
          <span className="sr-only">{TONE_WORD[f.tone]}: </span>
          <strong className="flag-label">{f.label}</strong>
          {f.text && <span className="flag-text">{f.text}</span>}
        </li>
      ))}
    </ul>
  );
}
