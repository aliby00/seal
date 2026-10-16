import type { Instrumentation } from 'next';
import { sentryDsn, sentryOptions } from '@/lib/sentry';

/** Server-side error reporting; does nothing without a DSN (see lib/sentry). */
export async function register() {
  const dsn = sentryDsn();
  if (!dsn) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.init(sentryOptions(dsn, process.env.SEAL_ENV ?? 'development'));
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!sentryDsn()) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(error, request, context);
};
