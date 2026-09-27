'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AnalyzeResponse } from './api/analyze/route';
import { SourceStudy } from './components/SourceStudy';
import { AnalysisReport } from './components/AnalysisReport';

const EXAMPLE_TOKEN = '0xd0c538e01a22ebf8502b4dc3a92026cec870cec6';
const errors: Record<number, string> = {
  400: 'Cette adresse n’est pas valide. Vérifiez qu’elle commence par 0x, suivi de 40 caractères hexadécimaux.',
  404: 'Ce token n’a pas été trouvé. Vérifiez son adresse et son lancement sur pons, sur Robinhood Chain.',
  429: 'Le quota de requêtes est atteint. Patientez un instant avant de réessayer.',
  502: 'Une source externe ou la génération de l’explication n’a pas abouti. Vous pouvez réessayer.',
  500: 'L’analyse a rencontré un problème inattendu. Réessayez dans quelques instants.',
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
          Lecture des données publiques
          <span className="loading-dots" aria-hidden="true">
            …
          </span>
        </h2>
        <span className="index" aria-hidden="true">
          {elapsed} s
        </span>
      </div>
      <p>Historique sur la chaîne · Détenteurs via Blockscout · Marché via DexScreener</p>
      <p className="loading-caption">
        {elapsed < 15
          ? 'L’analyse prend généralement entre 2 et 15 secondes. Les sources sont consultées, puis les observations sont rassemblées.'
          : 'La réponse prend plus de temps que prévu. Une source peut être lente ou incomplète ; ses limites seront indiquées.'}
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
      setValidation(
        'Saisissez une adresse commençant par 0x, suivie de 40 caractères hexadécimaux.',
      );
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
            'Le service est momentanément indisponible. Réessayez dans quelques instants.',
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
          ? 'La réponse a pris trop de temps. Vous pouvez relancer l’analyse.'
          : 'La connexion a été interrompue. Vérifiez votre connexion, puis réessayez.',
        retry: true,
      });
    } finally {
      clearTimeout(timeout);
      request.current = null;
    }
  }

  return (
    <section className="analysis-workspace" aria-label="Analyser un token">
      <div className="research-desk">
        <div className="research-main">
          <div className="workspace-intro">
            <p className="scene-eyebrow">
              <span className="research-cross" aria-hidden="true">
                +
              </span>{' '}
              Pons / Robinhood Chain
            </p>
            <h2 id="workspace-title">
              Un token.
              <br />
              <span>Toute sa nuance.</span>
            </h2>
            <p>
              Une adresse suffit pour examiner le créateur, les détenteurs et le marché. SEAL
              rapproche les faits et explique là où ils se contredisent.
            </p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void analyze();
            }}
            noValidate
          >
            <div className="query-heading">
              <span>Nouvelle lecture</span>
              <span aria-hidden="true">↗</span>
            </div>
            <label htmlFor="token" className="input-label">
              L’adresse du token
            </label>
            <div className="input-row">
              <Input
                ref={input}
                id="token"
                name="token"
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  setValidation('');
                }}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                disabled={state.status === 'loading'}
                aria-invalid={Boolean(validation)}
                aria-describedby={validation ? 'token-error token-help' : 'token-help'}
              />
              <Button type="submit" disabled={state.status === 'loading'}>
                {state.status === 'loading' ? 'Analyse en cours…' : 'Lire l’analyse'}
                <span aria-hidden="true">↗</span>
              </Button>
            </div>
            {validation && (
              <p id="token-error" role="alert" className="validation-message">
                {validation}
              </p>
            )}
            <div className="form-caption">
              <p id="token-help">Lecture publique. Aucun portefeuille à connecter.</p>
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
                Utiliser un exemple <span aria-hidden="true">↗</span>
              </button>
            </div>
          </form>
          <div className="research-footnote">
            <span aria-hidden="true">↳</span>
            <p>
              Un raisonnement, pas une note.
              <br />
              <span>Les sources et leurs limites accompagnent chaque lecture.</span>
            </p>
          </div>
        </div>
        <SourceStudy />
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
            <h2>L’analyse n’a pas abouti.</h2>
            <p>{state.message}</p>
            {state.retry && (
              <Button variant="ghost" type="button" onClick={() => void analyze()}>
                Réessayer <span aria-hidden="true">↗</span>
              </Button>
            )}
          </div>
        )}
        {state.status === 'done' && <AnalysisReport result={state.result} />}
      </div>
    </section>
  );
}
