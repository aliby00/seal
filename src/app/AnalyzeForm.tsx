'use client';

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PLAIN_LABEL } from '@/lib/specialists/plain';
import type { AnalyzeResponse } from './api/analyze/route';
import { SourceStudy } from './components/SourceStudy';
import { AnalysisReport } from './components/AnalysisReport';
import { Arch } from './components/brand';
import { ADDRESS, ADDRESS_HINT, ANALYZE_EVENT, EXAMPLE_TOKEN } from './components/analyze-request';
import { requestError } from './requestErrors';

type State =
  | { status: 'idle' }
  | { status: 'loading'; address: string }
  | { status: 'done'; result: AnalyzeResponse }
  | { status: 'error'; title?: string; message: string; retry: boolean };

/** The long end of a usual analysis, in seconds: the scale of the wait bar. */
const USUAL = 40;
/** Past this, the wait is said to be longer than usual. */
const SLOW = 45;

/**
 * What happens during the wait, in its usual order. The request is a single
 * call: these are the typical times, never a step the server reported done.
 */
const PHASES: { from: number; title: string; body: string; checks?: readonly string[] }[] = [
  {
    from: 0,
    title: 'Public data',
    body: 'The creator’s wallet and past launches on Robinhood Chain, the holders via Blockscout, price and trades via DexScreener. All three are read at once.',
  },
  {
    from: 14,
    title: 'Ten checks',
    body: 'Ten fixed questions, each answered only from what was read:',
    checks: Object.values(PLAIN_LABEL),
  },
  {
    from: 22,
    title: 'The reading',
    body: 'The facts are read against each other and written up: where they agree, where they do not, and what could not be seen. Nothing is scored.',
  },
];

const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;

function Loading({
  address,
  onCancel,
  panel,
}: {
  address: string;
  onCancel: () => void;
  panel: RefObject<HTMLDivElement | null>;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const current = PHASES.filter((phase) => elapsed >= phase.from).length - 1;
  const progress = Math.min(1, elapsed / USUAL);
  return (
    <div className="loading-state" role="status" tabIndex={-1} ref={panel}>
      <span className="scan-beam" aria-hidden="true" />
      <div className="loading-top">
        <div>
          <p className="loading-kicker">
            Token <code title={address}>{short(address)}</code>
          </p>
          <h2>
            Reading what the chain shows
            <span className="loading-dots" aria-hidden="true">
              …
            </span>
          </h2>
        </div>
        <span className="index" aria-hidden="true">
          {elapsed} s
        </span>
      </div>
      <div
        className="loading-track"
        aria-hidden="true"
        data-over={elapsed >= USUAL || undefined}
        style={{ '--progress': progress } as CSSProperties}
      >
        <span className="loading-fill" />
        {PHASES.slice(1).map((phase) => (
          <span
            key={phase.title}
            className="loading-tick"
            style={{ '--at': phase.from / USUAL } as CSSProperties}
          />
        ))}
      </div>
      <div className="loading-scale" aria-hidden="true">
        <span>0 s</span>
        <span>usually 20 to 40 s</span>
      </div>
      <ol className="loading-phases" aria-label="What happens during the wait, in its usual order">
        {PHASES.map((phase, i) => (
          <li key={phase.title} data-state={i < current ? 'past' : i === current ? 'now' : 'next'}>
            <span className="phase-time" aria-hidden="true">
              {phase.from === 0 ? 'first' : `~${phase.from} s`}
            </span>
            <div>
              <h3>{phase.title}</h3>
              <p>{phase.body}</p>
              {phase.checks && (
                <ul className="phase-checks">
                  {phase.checks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="sr-only">Usually at this point: {PHASES[current]?.title}.</p>
      <div className="loading-foot">
        <p className="loading-caption">
          {elapsed < SLOW
            ? 'The steps follow the usual order; the report arrives in one piece once every source has answered.'
            : 'This is taking longer than expected. A source may be slow or incomplete; its limitations will be shown.'}
        </p>
        <button type="button" className="loading-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AnalyzeForm() {
  const [token, setToken] = useState('');
  const [validation, setValidation] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const loadingPanel = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  // A finished report takes the focus: a screen reader starts at its title
  // instead of hearing the whole report read out as one live announcement.
  useEffect(() => {
    if (state.status === 'done') document.getElementById('report-title')?.focus();
  }, [state]);
  // The wait is shown where the reader is looking: the panel takes the focus
  // and comes into view, wherever the analysis was started from.
  const loading = state.status === 'loading';
  useEffect(() => {
    const panel = loadingPanel.current;
    if (!loading || !panel) return;
    panel.focus({ preventScroll: true });
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start' });
  }, [loading]);

  // A link such as /?token=0x…#analysis (the browser extension's "Full
  // reading", or a shared reading) opens with the address filled in and the
  // analysis started. The entrance field asks for an analysis the same way.
  // The start waits a tick so a remount in development does not send it twice.
  useEffect(() => {
    const start = (address: string) => {
      setToken(address);
      void analyze(address);
    };
    const linked = new URLSearchParams(window.location.search).get('token')?.trim() ?? '';
    const timer = ADDRESS.test(linked) ? setTimeout(() => start(linked), 0) : undefined;
    const onRequest = (event: Event) => {
      const address = (event as CustomEvent<string>).detail;
      if (typeof address === 'string' && ADDRESS.test(address)) start(address);
    };
    window.addEventListener(ANALYZE_EVENT, onRequest);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(ANALYZE_EVENT, onRequest);
    };
    // Once, on arrival: later edits of the field are the reader's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cancel() {
    cancelled.current = true;
    request.current?.abort();
  }

  async function analyze(value: string = token) {
    const address = value.trim();
    if (!ADDRESS.test(address)) {
      setValidation(ADDRESS_HINT);
      input.current?.focus();
      return;
    }
    if (request.current) return;
    setValidation('');
    setState({ status: 'loading', address });
    cancelled.current = false;
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: address }),
        signal: controller.signal,
      });
      if (!response.ok) {
        setState({ status: 'error', ...requestError(response.status) });
        return;
      }
      const result = (await response.json()) as AnalyzeResponse;
      setState({ status: 'done', result });
    } catch {
      if (cancelled.current) {
        setState({ status: 'idle' });
        setTimeout(() => input.current?.focus(), 0);
        return;
      }
      setState({
        status: 'error',
        message: controller.signal.aborted
          ? 'The response took too long. You can retry the analysis.'
          : 'The connection was interrupted. Check your connection, then try again.',
        retry: true,
      });
    } finally {
      clearTimeout(timeout);
      request.current = null;
    }
  }

  return (
    <section className="analysis-workspace" aria-label="Analyze a token">
      <div className="analysis-entry">
        <div className="workspace-intro">
          <p className="analysis-kicker">
            <Arch className="kicker-arch" strips={5} /> Independent token research
          </p>
          <h2 id="workspace-title">
            A token is more
            <br />
            than <em>a ticker.</em>
          </h2>
          <p>
            Understand the history, the holders and the market.
            <br />
            One address. An explanation you can actually read.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void analyze();
          }}
          noValidate
        >
          <label htmlFor="token" className="input-label composer-label">
            Token address
          </label>
          <div className="input-row composer-row">
            <span className="composer-prompt" aria-hidden="true">
              &gt;_
            </span>
            <Input
              ref={input}
              id="token"
              name="token"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setValidation('');
              }}
              placeholder="Paste a Robinhood Chain token address · 0x…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              disabled={loading}
              aria-invalid={Boolean(validation)}
              aria-describedby={validation ? 'token-error token-help' : 'token-help'}
            />
            <Button type="submit" disabled={loading}>
              {loading ? 'Analyzing…' : 'Analyze token'}
              <span className="cta-orb" aria-hidden="true">
                →
              </span>
            </Button>
          </div>
          {validation && (
            <p id="token-error" role="alert" className="validation-message">
              {validation}
            </p>
          )}
          <div className="form-caption">
            <p id="token-help">Public data. No wallet connection.</p>
            <button
              type="button"
              className="text-link"
              disabled={loading}
              onClick={() => {
                setToken(EXAMPLE_TOKEN);
                setValidation('');
                input.current?.focus();
              }}
            >
              Try an example <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
        <div className="source-signatures" aria-label="Research sources">
          <span>ROBINHOOD CHAIN</span>
          <span>BLOCKSCOUT</span>
          <span>DEXSCREENER</span>
        </div>
        <p className="entry-principle">Evidence and context. Never a score.</p>
      </div>
      {state.status === 'loading' && (
        <Loading address={state.address} onCancel={cancel} panel={loadingPanel} />
      )}
      {/* The loading panel announces itself; this only says the report is in. */}
      <p className="sr-only" aria-live="polite">
        {state.status === 'done' ? 'Analysis ready.' : ''}
      </p>
      <div id="analysis-result" aria-busy={loading}>
        {state.status === 'error' && (
          <div className="error-state" role="alert">
            <h2>{state.title ?? 'The analysis could not be completed.'}</h2>
            <p>{state.message}</p>
            {state.retry && (
              <Button variant="ghost" type="button" onClick={() => void analyze()}>
                Try again <span aria-hidden="true">↗</span>
              </Button>
            )}
          </div>
        )}
        {state.status === 'done' && <AnalysisReport result={state.result} />}
      </div>
      <SourceStudy />
    </section>
  );
}
