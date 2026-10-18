import { partialNotice, type Glance, type GlanceTone } from '@/lib/glance';
import type { Signal } from '@/lib/specialists/types';
import { SignalIcon } from './signals';

/** The tone of a line, always said in words as well as colour. */
const TONE: Record<GlanceTone, { label: string; signal: Signal }> = {
  attention: { label: 'Worth attention', signal: 'concern' },
  neutral: { label: 'Context', signal: 'observation' },
  reassuring: { label: 'Reassuring', signal: 'reassurance' },
};

/**
 * The report's first screen: the few facts a reader needs, each in one
 * sentence with its number, and a link to where it is shown in full.
 */
export function AtAGlance({ glance }: { glance: Glance }) {
  const [lead, ...rest] = glance.items;
  return (
    <section className="glance" aria-labelledby="glance-title">
      <h3 id="glance-title" className="glance-kicker">
        In short
      </h3>
      {lead ? (
        <a className="glance-lead" href={lead.href} data-tone={lead.tone}>
          <span className="glance-tone" data-signal={TONE[lead.tone].signal}>
            <SignalIcon signal={TONE[lead.tone].signal} />
            {TONE[lead.tone].label}
          </span>
          <span className="glance-lead-body">
            {lead.figure && <strong className="glance-figure">{lead.figure}</strong>}
            <span className="glance-headline">{lead.title}</span>
          </span>
          <span className="glance-detail">
            {lead.detail} <span aria-hidden="true">↓</span>
          </span>
        </a>
      ) : (
        <p className="glance-headline">{glance.headline}</p>
      )}
      {rest.length > 0 && (
        <ul className="glance-list" data-count={rest.length}>
          {rest.map((item) => (
            <li key={item.id}>
              <a className="glance-item" href={item.href} data-tone={item.tone}>
                <span className="glance-tone" data-signal={TONE[item.tone].signal}>
                  <SignalIcon signal={TONE[item.tone].signal} />
                  {TONE[item.tone].label}
                </span>
                {item.figure && <strong className="glance-figure">{item.figure}</strong>}
                <span className="glance-text">{item.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {/* A read that failed is said, below the findings and quieter than them. */}
      {glance.partial && glance.partial.length > 0 && (
        <p className="glance-partial" role="status">
          {partialNotice(glance.partial)}
        </p>
      )}
      {glance.unseen.length > 0 && (
        <p className="glance-unseen">
          <strong>Not measured here:</strong> {glance.unseen.join(', ')}.
        </p>
      )}
    </section>
  );
}
