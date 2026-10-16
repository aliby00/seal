import { describe, expect, it } from 'vitest';
import {
  TRACES_SAMPLE_RATE,
  clientEnvironment,
  scrubEvent,
  sentryDsn,
  sentryOptions,
} from '@/lib/sentry';

describe('sentry', () => {
  it('stays off without a DSN', () => {
    expect(sentryDsn({})).toBeUndefined();
    expect(sentryDsn({ NEXT_PUBLIC_SENTRY_DSN: '   ' })).toBeUndefined();
    expect(sentryDsn({ NEXT_PUBLIC_SENTRY_DSN: ' https://k@o.ingest.de.sentry.io/1 ' })).toBe(
      'https://k@o.ingest.de.sentry.io/1',
    );
  });

  it('removes everything that identifies the requester', () => {
    const event = scrubEvent({
      user: { ip_address: '1.2.3.4' },
      request: {
        url: 'https://sealauth.dev/api/analyze',
        data: '{"token":"0x1"}',
        cookies: { a: 'b' },
        headers: { 'x-forwarded-for': '1.2.3.4' },
        env: { REMOTE_ADDR: '1.2.3.4' },
        query_string: 'a=b',
      },
    });
    expect(event).toEqual({ request: { url: 'https://sealauth.dev/api/analyze' } });
  });

  it('sends no default PII and samples few traces', () => {
    const options = sentryOptions('https://k@o.ingest.de.sentry.io/1', 'staging');
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(TRACES_SAMPLE_RATE);
    expect(TRACES_SAMPLE_RATE).toBeLessThanOrEqual(0.05);
    expect(options.environment).toBe('staging');
  });

  it('names the environment from the host in the browser', () => {
    expect(clientEnvironment('sealauth.dev')).toBe('production');
    expect(clientEnvironment('www.sealauth.dev')).toBe('production');
    expect(clientEnvironment('seal-staging.vercel.app')).toBe('staging');
    expect(clientEnvironment('localhost')).toBe('development');
  });
});
