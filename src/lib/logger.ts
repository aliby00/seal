/**
 * Log structuré, une ligne JSON par événement.
 *
 * Volontairement minimal : pas de dépendance, et un format que Vercel et
 * n'importe quel agrégateur savent lire. Le champ `env` vient de SEAL_ENV,
 * ce qui permet de séparer la dépense de staging de celle de production.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  return LEVELS[configured ?? 'info'] ?? LEVELS.info;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({
    level,
    message,
    env: process.env.SEAL_ENV ?? 'development',
    at: new Date().toISOString(),
    ...fields,
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
