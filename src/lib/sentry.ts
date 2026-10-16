/**
 * Error reporting, off until a DSN is configured. Without
 * NEXT_PUBLIC_SENTRY_DSN nothing is loaded and nothing leaves the server or
 * the browser: the SDK is imported only once a DSN exists.
 *
 * What is sent stays technical: the error, its stack and the route. No IP, no
 * cookies, no headers, no request body — an analysed address is public data,
 * but who asked for it is not ours to share.
 */

/** A small share of requests is traced: errors are the point, not timings. */
export const TRACES_SAMPLE_RATE = 0.05;

export function sentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const dsn = env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  return dsn ? dsn : undefined;
}

type ScrubbableEvent = {
  user?: unknown;
  request?: {
    data?: unknown;
    cookies?: unknown;
    headers?: unknown;
    env?: unknown;
    query_string?: unknown;
  };
};

/** Removes everything that could identify the person behind a request. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  delete event.user;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.env;
    delete event.request.query_string;
  }
  return event;
}

/**
 * SEAL_ENV is a server variable; the browser tells environments apart by the
 * host it was served from.
 */
export function clientEnvironment(host: string): string {
  if (host === 'sealauth.dev' || host === 'www.sealauth.dev') return 'production';
  if (host.startsWith('seal-staging')) return 'staging';
  return 'development';
}

export function sentryOptions(dsn: string, environment: string) {
  return {
    dsn,
    environment,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  };
}
