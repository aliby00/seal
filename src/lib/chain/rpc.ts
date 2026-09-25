import { RateLimitError, TimeoutError, UpstreamError } from '../errors';
import { request, type RequestBudget } from '../http';

/**
 * Client JSON-RPC minimal pour Robinhood Chain.
 *
 * Il passe par le wrapper HTTP commun (timeout, retry, budget) et traduit les
 * erreurs JSON-RPC en erreurs typées — le RPC public répond volontiers 200 avec
 * une erreur dans le corps, ce que `fetch` seul ne signalerait pas.
 */

export const ROBINHOOD_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

export type RpcClient = {
  call<T>(method: string, params: unknown[]): Promise<T>;
};

type JsonRpcResponse<T> = {
  result?: T;
  error?: { code: number; message: string };
};

/** Les trois façons dont `eth_getLogs` refuse de répondre. Mesurées, pas supposées. */
export class LogQueryTooBroadError extends Error {
  constructor(readonly reason: 'too-many-results' | 'timeout') {
    super(
      reason === 'too-many-results'
        ? 'eth_getLogs : plus de résultats que la limite du nœud'
        : 'eth_getLogs : la requête a expiré côté nœud',
    );
    this.name = 'LogQueryTooBroadError';
  }
}

/**
 * Reconnaît une erreur qui veut dire « ta fenêtre est trop large ».
 * Le message diffère selon le cas, la réponse est la même : resserrer.
 */
export function classifyLogError(message: string): LogQueryTooBroadError | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('exceeds limit')) return new LogQueryTooBroadError('too-many-results');
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return new LogQueryTooBroadError('timeout');
  }
  return undefined;
}

export function createRpcClient(url: string = DEFAULT_RPC_URL, budget?: RequestBudget): RpcClient {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const response = await request(url, {
        source: 'robinhood-rpc',
        budget,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        },
      });

      const body = (await response.json()) as JsonRpcResponse<T>;

      if (body.error) {
        const tooBroad = classifyLogError(body.error.message);
        if (tooBroad) throw tooBroad;
        // -32005 est la convention pour « limite dépassée » côté JSON-RPC.
        if (body.error.code === -32005) throw new RateLimitError('robinhood-rpc');
        throw new UpstreamError('robinhood-rpc', `${method} : ${body.error.message}`);
      }

      if (body.result === undefined) {
        throw new UpstreamError('robinhood-rpc', `${method} : réponse sans résultat`);
      }
      return body.result;
    },
  };
}

export { RateLimitError, TimeoutError };
