'use client';

import { useState } from 'react';
import { ADDRESS, ADDRESS_HINT, EXAMPLE_TOKEN, requestAnalysis } from './analyze-request';

/**
 * The address field, on the first screen. It does not run the analysis
 * itself: it hands the address to the workspace form, which owns the request
 * and the report. Without JavaScript the form still works: it opens
 * /?token=…#analysis, a link the workspace starts on its own.
 */
export function EntranceComposer() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  function start(address: string) {
    if (!ADDRESS.test(address)) {
      setError(ADDRESS_HINT);
      return;
    }
    setError('');
    requestAnalysis(address);
  }

  return (
    <form
      className="entrance-composer"
      action="/#analysis"
      method="get"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        start(value.trim());
      }}
    >
      <label htmlFor="entrance-token" className="sr-only">
        Token address to analyze
      </label>
      <div className="entrance-field" data-invalid={Boolean(error) || undefined}>
        <span className="composer-prompt" aria-hidden="true">
          &gt;_
        </span>
        <input
          id="entrance-token"
          name="token"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
          }}
          placeholder="Token address, 0x…"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'entrance-error entrance-help' : 'entrance-help'}
        />
        <button type="submit" className="entrance-submit">
          <span className="entrance-submit-label">Analyze</span>
          <span className="cta-orb" aria-hidden="true">
            →
          </span>
        </button>
      </div>
      {error && (
        <p id="entrance-error" className="entrance-error" role="alert">
          {error}
        </p>
      )}
      <p className="entrance-meta">
        <span id="entrance-help">Public data · no wallet · about 30 s</span>
        <button
          type="button"
          className="entrance-example"
          onClick={() => {
            setValue(EXAMPLE_TOKEN);
            start(EXAMPLE_TOKEN);
          }}
        >
          Read an example <span aria-hidden="true">↓</span>
        </button>
      </p>
    </form>
  );
}
