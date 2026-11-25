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

/**
 * A node URL can carry its key (Alchemy: `/v2/<key>`, others in a query
 * parameter or a path token). The SDK records the URL of every outgoing
 * request (fetch breadcrumbs, spans), so a key would reach Sentry with the
 * first error of an analysis: every string it sends is cleared of them.
 */
const KEY_IN_PATH = /(\/(?:v\d+|rpc|key)\/)[A-Za-z0-9_-]{16,}/g;
const KEY_IN_HOST_PATH = /(\.quiknode\.pro\/)[A-Za-z0-9_-]+/g;
const KEY_IN_QUERY = /([?&](?:api[-_]?key|key|token|access[-_]?token)=)[^&#\s"']+/gi;

/** `text` without the keys a URL in it may carry. */
export function redactKeys(text: string): string {
  return text
    .replace(KEY_IN_PATH, '$1[key]')
    .replace(KEY_IN_HOST_PATH, '$1[key]')
    .replace(KEY_IN_QUERY, '$1[key]');
}

/** Every string of `value`, redacted; objects and arrays are changed in place. */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactKeys(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = redactDeep(value[i], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) record[key] = redactDeep(record[key], depth + 1);
  return value;
}

/** A breadcrumb (an outgoing request's URL, a log line) without keys. */
export function scrubBreadcrumb<T>(breadcrumb: T): T {
  return redactDeep(breadcrumb) as T;
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
  // Breadcrumbs, spans, messages: an outgoing request's URL may hold a key.
  return redactDeep(event) as T;
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
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
