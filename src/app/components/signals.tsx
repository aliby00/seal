import type { Signal } from '@/lib/specialists/types';

import { SIGNAL_LABEL } from './signal-labels';

export function SignalIcon({ signal }: { signal: Signal }) {
  const common = {
    viewBox: '0 0 16 16',
    width: 16,
    height: 16,
    'aria-hidden': true,
    focusable: false,
    className: 'signal-icon',
  } as const;
  switch (signal) {
    case 'concern':
      return (
        <svg {...common}>
          <path d="M8 1.5 15 14H1z" fill="currentColor" />
          <path
            d="M8 6v3.6M8 11.4v.1"
            stroke="var(--signal-ink)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'reassurance':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="m4.6 8.2 2.3 2.3 4.5-4.7"
            fill="none"
            stroke="var(--signal-ink)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'observation':
      return (
        <svg {...common}>
          <rect
            x="1.5"
            y="1.5"
            width="13"
            height="13"
            rx="3"
            fill="currentColor"
            transform="rotate(45 8 8) scale(.82) translate(1.75 1.75)"
          />
          <circle cx="8" cy="8" r="1.9" fill="var(--signal-ink)" />
        </svg>
      );
    case 'quiet':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5 8h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle
            cx="8"
            cy="8"
            r="6.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeDasharray="2.4 2"
          />
          <path
            d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.5-.7 1v.4M8 11.6v.1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

export function SignalBadge({ signal }: { signal: Signal }) {
  return (
    <span className="signal-badge" data-signal={signal}>
      <SignalIcon signal={signal} />
      {SIGNAL_LABEL[signal]}
    </span>
  );
}
