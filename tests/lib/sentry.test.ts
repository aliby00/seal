import { describe, expect, it } from 'vitest';
import {
  TRACES_SAMPLE_RATE,
  clientEnvironment,
  redactKeys,
  scrubBreadcrumb,
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

  // The SDK records every outgoing request's URL: the Solana node's carries its key.
  it('never sends a node key, in a breadcrumb, a span or a message', () => {
    const alchemy = 'https://solana-mainnet.g.alchemy.com/v2/AbCdEf0123456789xyzKEY';
    const raw = {
      message: `POST ${alchemy} failed`,
      breadcrumbs: [{ category: 'fetch', data: { url: alchemy, method: 'POST' } }],
      spans: [{ description: `POST ${alchemy}`, data: { 'http.url': alchemy } }],
      request: { url: 'https://sealauth.dev/api/analyze', data: '{}' },
    };
    const event = scrubEvent(raw);
    expect(JSON.stringify(event)).not.toContain('AbCdEf0123456789xyzKEY');
    expect(event.breadcrumbs[0]!.data.url).toBe('https://solana-mainnet.g.alchemy.com/v2/[key]');
    expect(event.request.url).toBe('https://sealauth.dev/api/analyze');
    const crumb = scrubBreadcrumb({ data: { url: `${alchemy}?x=1` } });
    expect(crumb.data.url).toBe('https://solana-mainnet.g.alchemy.com/v2/[key]?x=1');
    expect(redactKeys('https://mainnet.helius-rpc.com/?api-key=0123-abcd')).toBe(
      'https://mainnet.helius-rpc.com/?api-key=[key]',
    );
    expect(redactKeys('https://x.solana-mainnet.quiknode.pro/0123abcd/')).toBe(
      'https://x.solana-mainnet.quiknode.pro/[key]/',
    );
    // The public node and an analysed mint stay readable.
    expect(redactKeys('https://api.mainnet-beta.solana.com')).toBe(
      'https://api.mainnet-beta.solana.com',
    );
    expect(redactKeys('/api/analyze FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump')).toBe(
      '/api/analyze FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump',
    );
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
