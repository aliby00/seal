/**
 * What the form says when the API refuses or fails a request. Each message is
 * written for the reader, never echoes the server's error text, and says
 * whether trying again can help.
 */
export type RequestError = { title: string; message: string; retry: boolean };

const FAILED = 'The analysis could not be completed.';

const byStatus: Record<number, RequestError> = {
  400: {
    title: FAILED,
    message: 'Invalid address. Use 0x followed by 40 hexadecimal characters.',
    retry: false,
  },
  403: {
    title: FAILED,
    message: 'Requests from other websites are not accepted. Open SEAL directly, then try again.',
    retry: false,
  },
  404: {
    title: FAILED,
    message: 'Token not found. Check its address and that it exists on Robinhood Chain.',
    retry: false,
  },
  413: {
    title: FAILED,
    message: 'The request was larger than expected. Reload the page, then try again.',
    retry: false,
  },
  415: {
    title: FAILED,
    message: 'The request was not in the expected format. Reload the page, then try again.',
    retry: false,
  },
  // The rate limit: nothing is wrong, the reader only has to wait.
  429: {
    title: 'A short pause.',
    message: 'Too many analyses from this connection. Wait a minute, then try again.',
    retry: true,
  },
  500: {
    title: FAILED,
    message: 'Something interrupted the analysis. Please try again shortly.',
    retry: true,
  },
  502: {
    title: FAILED,
    message: 'A data source or the explanation could not be reached. Please try again.',
    retry: true,
  },
};

export function requestError(status: number): RequestError {
  return (
    byStatus[status] ?? {
      title: FAILED,
      message: 'The service is temporarily unavailable. Please try again shortly.',
      retry: true,
    }
  );
}
