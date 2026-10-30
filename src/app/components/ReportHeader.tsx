'use client';

import { useState } from 'react';
import type { AnalyzeResponse } from '../api/analyze/route';
import { readingUrl } from './analyze-request';

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
  const [copied, setCopied] = useState<'address' | 'link' | null>(null);
  const facts = result.facts;
  const sources: { name: string; coverage: Coverage }[] = facts
    ? [
        { name: 'Creator', coverage: coverageOf(facts.creator.measured, facts.creator.note) },
        { name: 'Holders', coverage: coverageOf(facts.holders.measured, facts.holders.note) },
        { name: 'Market', coverage: coverageOf(facts.market.measured, facts.market.note) },
      ]
    : [];
  const title = result.name ?? (result.symbol ? result.symbol : 'Unnamed token');

  // Rendered only in the browser, once a reading has come back.
  const link = readingUrl(result.token);
  const post = `What the chain shows about ${title}${
    result.symbol && result.name ? ` (${result.symbol})` : ''
  }, read by SEAL. No score, just the evidence.`;
  const shareOnX = `https://x.com/intent/post?${new URLSearchParams({ text: post, url: link })}`;

  async function copy(what: 'address' | 'link') {
    try {
      await navigator.clipboard.writeText(what === 'address' ? result.token : link);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  }

  return (
    <header className="report-hero">
      <div className="report-identity">
        <p className="report-kicker">SEAL reading</p>
        <h2 id="report-title" tabIndex={-1}>
          <span className="report-name">{title}</span>
          {result.symbol && result.name && <span className="report-symbol">{result.symbol}</span>}
        </h2>
        <div className="report-address">
          <code title={result.token}>{short(result.token)}</code>
          <button type="button" className="chip-button" onClick={() => void copy('address')}>
            {copied === 'address' ? 'Copied' : 'Copy address'}
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
        <div className="report-share" role="group" aria-label="Share this reading">
          <button type="button" className="share-button" onClick={() => void copy('link')}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.8 2.8 0 014 4L11 8.5M9 11.5l-1.2 1.2a2.8 2.8 0 01-4-4L5 7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            {copied === 'link' ? 'Link copied' : 'Copy link'}
          </button>
          <a className="share-button" href={shareOnX} target="_blank" rel="noreferrer">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
              <path
                d="M9.3 6.9L14.2 1h-1.2L8.8 6.1 5.4 1H1.5l5.1 7.5L1.5 15h1.2l4.5-5.2 3.6 5.2h3.9L9.3 6.9zm-1.6 1.9l-.5-.7L3.1 1.9h1.8l3.3 4.8.5.7 4.3 6.3h-1.8L7.7 8.8z"
                fill="currentColor"
              />
            </svg>
            Share on X<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
        <span className="sr-only" aria-live="polite">
          {copied === 'address' ? 'Address copied' : copied === 'link' ? 'Link copied' : ''}
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
