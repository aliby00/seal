'use client';

import { useState } from 'react';
import type { AnalyzeResponse } from '../api/analyze/route';

const EXPLORER = 'https://robinhoodchain.blockscout.com';
const DEXSCREENER = 'https://dexscreener.com/robinhood';

type Coverage = 'measured' | 'partial' | 'missing';
const COVERAGE_LABEL: Record<Coverage, string> = {
  measured: 'Read',
  partial: 'Partly read',
  missing: 'Not measured',
};

function coverageOf(measured: boolean | undefined, note: string | undefined): Coverage {
  if (!measured) return 'missing';
  return note && /could not|not covered|most recent|partial|truncat/i.test(note)
    ? 'partial'
    : 'measured';
}

function CoverageMark({ coverage }: { coverage: Coverage }) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      {coverage === 'measured' && <circle cx="6" cy="6" r="5" fill="currentColor" />}
      {coverage === 'partial' && (
        <>
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" fill="currentColor" />
        </>
      )}
      {coverage === 'missing' && (
        <circle
          cx="6"
          cy="6"
          r="4.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeDasharray="2 1.6"
        />
      )}
    </svg>
  );
}

const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;

export function ReportHeader({ result }: { result: AnalyzeResponse }) {
  const [copied, setCopied] = useState(false);
  const facts = result.facts;
  const sources: { name: string; coverage: Coverage }[] = facts
    ? [
        { name: 'Creator', coverage: coverageOf(facts.creator.measured, facts.creator.note) },
        { name: 'Holders', coverage: coverageOf(facts.holders.measured, facts.holders.note) },
        { name: 'Market', coverage: coverageOf(facts.market.measured, facts.market.note) },
      ]
    : [];
  const title = result.name ?? (result.symbol ? result.symbol : 'Unnamed token');

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <header className="report-hero">
      <div className="report-identity">
        <p className="report-kicker">SEAL reading</p>
        <h2 id="report-title">
          <span className="report-name">{title}</span>
          {result.symbol && result.name && <span className="report-symbol">{result.symbol}</span>}
        </h2>
        <div className="report-address">
          <code title={result.token}>{short(result.token)}</code>
          <button type="button" className="chip-button" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <a
            className="chip-button"
            href={`${EXPLORER}/token/${result.token}`}
            target="_blank"
            rel="noreferrer"
          >
            Explorer <span aria-hidden="true">↗</span>
          </a>
          <a
            className="chip-button"
            href={`${DEXSCREENER}/${result.token}`}
            target="_blank"
            rel="noreferrer"
          >
            DexScreener <span aria-hidden="true">↗</span>
          </a>
        </div>
        <span className="sr-only" aria-live="polite">
          {copied ? 'Address copied' : ''}
        </span>
      </div>
      {sources.length > 0 && (
        <ul className="coverage" aria-label="What each source could read">
          {sources.map((s) => (
            <li key={s.name} data-coverage={s.coverage}>
              <CoverageMark coverage={s.coverage} />
              <span className="coverage-name">{s.name}</span>
              <span className="coverage-state">{COVERAGE_LABEL[s.coverage]}</span>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
