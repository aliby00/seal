'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AnalyzeResponse } from './api/analyze/route';
import { SourceStudy } from './components/SourceStudy';
import { AnalysisReport } from './components/AnalysisReport';

const EXAMPLE_TOKEN = '0xd0c538e01a22ebf8502b4dc3a92026cec870cec6';
const errors: Record<number, string> = {
  400: 'Invalid address. Use 0x followed by 40 hexadecimal characters.',
  404: 'Token not found. Check its address and that it launched on pons, on Robinhood Chain.',
  429: 'The request limit has been reached. Wait a moment, then try again.',
  502: 'A data source or the explanation could not be reached. Please try again.',
  500: 'Something interrupted the analysis. Please try again shortly.',
};
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: AnalyzeResponse }
  | { status: 'error'; message: string; retry: boolean };

function Loading() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="loading-state" role="status">
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
      <p>On-chain history · Holders via Blockscout · Market via DexScreener</p>
      <p className="loading-caption">
        {elapsed < 15
          ? 'Analysis usually takes 2–15 seconds. Sources are consulted, then their observations are brought together.'
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

  async function analyze() {
    const address = token.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
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
        setState({
          status: 'error',
          message:
            errors[response.status] ??
            'The service is temporarily unavailable. Please try again shortly.',
          retry: response.status !== 400 && response.status !== 404,
        });
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
            <span aria-hidden="true">✳</span> Independent token research
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
              <span aria-hidden="true">↑</span>
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
      <div
        aria-live="polite"
        aria-atomic="false"
        id="analysis-result"
        aria-busy={state.status === 'loading'}
      >
        {state.status === 'error' && (
          <div className="error-state" role="alert">
            <h2>The analysis could not be completed.</h2>
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
