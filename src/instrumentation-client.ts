import { clientEnvironment, sentryDsn, sentryOptions } from '@/lib/sentry';

// Browser-side error reporting; the SDK is fetched only when a DSN is set.
const dsn = sentryDsn({ NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN });
if (dsn) {
  void import('@sentry/nextjs').then((Sentry) =>
    Sentry.init(sentryOptions(dsn, clientEnvironment(window.location.hostname))),
  );
}
