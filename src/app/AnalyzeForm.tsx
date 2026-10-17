'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AnalyzeResponse } from './api/analyze/route';
import { SourceStudy } from './components/SourceStudy';
import { AnalysisReport } from './components/AnalysisReport';
import { Arch } from './components/brand';
import { requestError } from './requestErrors';

/** A real pons launch whose creator history and holders can be read in full. */
const EXAMPLE_TOKEN = '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: AnalyzeResponse }
  | { status: 'error'; title?: string; message: string; retry: boolean };

/** The steps light up on a typical schedule; the request itself is a single call. */
const SCAN_STEPS: { label: string; from: number }[] = [
  { label: 'Chain history', from: 0 },
  { label: 'Holders', from: 3 },
  { label: 'Market', from: 5 },
  { label: 'Ten specialists', from: 7 },
  { label: 'Reading', from: 12 },
];

function Loading() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const current = SCAN_STEPS.filter((step) => elapsed >= step.from).length - 1;
  return (
    <div className="loading-state" role="status">
      <span className="scan-beam" aria-hidden="true" />
      <div className="loading-top">
        <h2>
          Reading public data
          <span className="loading-dots" aria-hidden="true">
            …
          </span>
        </h2>
        <span className="index" aria-hidden="true">
          {elapsed} s
        </span>
      </div>
      <ol className="scan-steps" aria-hidden="true">
        {SCAN_STEPS.map((step, i) => (
          <li
            key={step.label}
            data-state={i < current ? 'done' : i === current ? 'active' : 'wait'}
          >
            {step.label}
          </li>
        ))}
      </ol>
      <p className="loading-sources">
        On-chain history · Holders via Blockscout · Market via DexScreener
      </p>
      <p className="loading-caption">
        {elapsed < 30
          ? 'An analysis usually takes 15 to 30 seconds. Each source is read, then the ten questions are asked.'
          : 'This is taking longer than expected. A source may be slow or incomplete; its limitations will be shown.'}
      </p>
    </div>
  );
}

export function AnalyzeForm() {
  const [token, setToken] = useState('');
  const [validation, setValidation] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  // A finished report takes the focus: a screen reader starts at its title
  // instead of hearing the whole report read out as one live announcement.
  useEffect(() => {
    if (state.status === 'done') document.getElementById('report-title')?.focus();
  }, [state]);

  // A link such as /?token=0x…#analysis (the browser extension's "Full
  // reading") opens with the address filled in and the analysis started. The
  // start waits a tick so a remount in development does not send it twice.
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('token')?.trim() ?? '';
    if (!ADDRESS.test(linked)) return;
    const timer = setTimeout(() => {
      setToken(linked);
      void analyze(linked);
    }, 0);
    return () => clearTimeout(timer);
    // Once, on arrival: later edits of the field are the reader's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function analyze(value: string = token) {
    const address = value.trim();
    if (!ADDRESS.test(address)) {
      setValidation('Enter an address starting with 0x, followed by 40 hexadecimal characters.');
      input.current?.focus();
      return;
    }
    if (request.current) return;
    setValidation('');
    setState({ status: 'loading' });
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
              placeholder="Paste a pons token address · 0x…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              disabled={state.status === 'loading'}
              aria-invalid={Boolean(validation)}
              aria-describedby={validation ? 'token-error token-help' : 'token-help'}
            />
            <Button type="submit" disabled={state.status === 'loading'}>
              {state.status === 'loading' ? 'Analyzing…' : 'Analyze token'}
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
              disabled={state.status === 'loading'}
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
      {state.status === 'loading' && <Loading />}
      {/* The loading panel announces itself; this only says the report is in. */}
      <p className="sr-only" aria-live="polite">
        {state.status === 'done' ? 'Analysis ready.' : ''}
      </p>
      <div id="analysis-result" aria-busy={state.status === 'loading'}>
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
