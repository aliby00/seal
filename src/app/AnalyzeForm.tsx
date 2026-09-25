'use client';

import { useState } from 'react';
import type { AnalyzeResponse } from './api/analyze/route';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: AnalyzeResponse }
  | { status: 'error'; message: string };

const COMPLETENESS_LABEL: Record<string, string> = {
  full: 'Toutes les sources ont répondu.',
  partial: 'Vue partielle — certaines sources sont incomplètes.',
  unavailable: 'Aucune source exploitable.',
};

export function AnalyzeForm() {
  const [token, setToken] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setState({ status: 'loading' });
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = (await response.json()) as AnalyzeResponse & { error?: string };
      if (!response.ok) {
        setState({ status: 'error', message: body.error ?? `Erreur ${response.status}` });
        return;
      }
      setState({ status: 'done', result: body });
    } catch {
      setState({ status: 'error', message: "La requête n'a pas abouti." });
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="0x… adresse du token pons"
          aria-label="Adresse du token"
          spellCheck={false}
          style={{
            flex: '1 1 20rem',
            minWidth: 0,
            padding: '0.7rem 0.85rem',
            border: '1px solid var(--line)',
            borderRadius: '8px',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
          }}
        />
        <button
          type="submit"
          disabled={state.status === 'loading' || token.trim() === ''}
          style={{
            padding: '0.7rem 1.1rem',
            border: 'none',
            borderRadius: '8px',
            background: 'var(--accent)',
            color: '#fff',
            font: 'inherit',
            cursor: state.status === 'loading' ? 'progress' : 'pointer',
            opacity: token.trim() === '' ? 0.5 : 1,
          }}
        >
          {state.status === 'loading' ? 'Analyse…' : 'Analyser'}
        </button>
      </form>

      {state.status === 'loading' && (
        <p style={{ color: 'var(--muted)', marginTop: '1.5rem' }}>
          Lecture de la chaîne, des détenteurs et du marché…
        </p>
      )}

      {state.status === 'error' && (
        <p role="alert" style={{ marginTop: '1.5rem', color: '#c0392b' }}>
          {state.message}
        </p>
      )}

      {state.status === 'done' && (
        <article style={{ marginTop: '2rem' }}>
          {/* La complétude est affichée avant l'explication, pas en note de bas de page. */}
          <p
            style={{
              margin: '0 0 1rem',
              padding: '0.5rem 0.75rem',
              border: '1px solid var(--line)',
              borderRadius: '8px',
              color: 'var(--muted)',
              fontSize: '0.8125rem',
            }}
          >
            {COMPLETENESS_LABEL[state.result.completeness] ?? state.result.completeness}
            {state.result.sources
              .filter((s) => s.note)
              .map((s) => (
                <span
                  key={`${s.name}-${s.note}`}
                  style={{ display: 'block', marginTop: '0.35rem' }}
                >
                  {s.name} — {s.note}
                </span>
              ))}
          </p>

          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{state.result.explanation}</div>

          <p style={{ marginTop: '1.5rem', color: 'var(--muted)', fontSize: '0.75rem' }}>
            Analysé le {new Date(state.result.collectedAt).toLocaleString('fr-FR')} · coût de cette
            requête : {state.result.costUsd.toFixed(4)} $
          </p>
        </article>
      )}
    </div>
  );
}
