import { describe, expect, it } from 'vitest';
import { requestError } from '@/app/requestErrors';

describe('requestError', () => {
  it('turns the rate limit into a calm pause that can be retried', () => {
    const error = requestError(429);
    expect(error.title).toBe('A short pause.');
    expect(error.message).toMatch(/wait a minute/i);
    expect(error.retry).toBe(true);
  });

  it.each([403, 413, 415])('refused request %i: plain message, no retry', (status) => {
    const error = requestError(status);
    expect(error.message).not.toMatch(/\d{3}|error/i);
    expect(error.retry).toBe(false);
  });

  it('keeps an address error final and a server error retryable', () => {
    expect(requestError(400).retry).toBe(false);
    expect(requestError(404).retry).toBe(false);
    expect(requestError(502).retry).toBe(true);
  });

  it('falls back to a generic retryable message for an unknown status', () => {
    expect(requestError(503)).toMatchObject({ retry: true });
  });
});
