/**
 * Une boucle d'ingestion : `step()` avance d'une tranche et dit s'il reste du
 * travail. Une erreur n'arrête jamais le processus : elle est journalisée, la
 * boucle attend de plus en plus longtemps (jusqu'à 5 min) puis reprend depuis
 * son curseur.
 */
export type Stream = {
  name: string;
  /** `true` = une tranche a été traitée, on enchaîne ; `false` = à jour, on attend. */
  step(): Promise<boolean>;
};

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export const logLine: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
};

const MAX_BACKOFF_MS = 5 * 60_000;

export type LoopOptions = {
  pollMs: number;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

export async function runLoop(stream: Stream, options: LoopOptions): Promise<void> {
  const log = options.log ?? logLine;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let backoff = 5_000;
  while (!options.signal?.aborted) {
    try {
      const more = await stream.step();
      backoff = 5_000;
      if (!more) await sleep(options.pollMs);
    } catch (error) {
      log('stream-error', {
        stream: stream.name,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        retryInMs: backoff,
      });
      await sleep(backoff);
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    }
  }
}
