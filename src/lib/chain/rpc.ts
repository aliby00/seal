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

export type RpcRequest = { method: string; params: unknown[] };

/** Résultat d'un appel groupé : succès ou erreur, par requête. */
export type BatchOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export type RpcClient = {
  call<T>(method: string, params: unknown[]): Promise<T>;
  /**
   * Envoie plusieurs appels en une seule requête HTTP.
   *
   * Vérifié sur Robinhood Chain : le batch JSON-RPC est supporté. C'est ce qui
   * rend un historique profond envisageable — sans lui, lire l'état de
   * graduation de 40 tokens coûte 40 allers-retours sur un RPC public qui
   * répond 403 après une rafale.
   *
   * Chaque entrée réussit ou échoue indépendamment : un token dont l'appel
   * revert ne doit pas faire échouer les 39 autres.
   */
  callBatch<T>(requests: RpcRequest[]): Promise<BatchOutcome<T>[]>;
};

type JsonRpcResponse<T> = {
  id?: number;
  result?: T;
  error?: { code: number; message: string };
};

/** Au-delà, certains nœuds refusent la requête entière. Valeur prudente. */
export const MAX_BATCH_SIZE = 20;

/** Les trois façons dont `eth_getLogs` refuse de répondre. Mesurées, pas supposées. */
export class LogQueryTooBroadError extends Error {
  constructor(readonly reason: 'too-many-results' | 'timeout') {
    super(
      reason === 'too-many-results'
        ? 'eth_getLogs : results exceed the node limit'
        : 'eth_getLogs : request timed out at the node',
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
  async function post(payload: unknown): Promise<Response> {
    return request(url, {
      source: 'robinhood-rpc',
      budget,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    });
  }

  return {
    async callBatch<T>(requests: RpcRequest[]): Promise<BatchOutcome<T>[]> {
      if (requests.length === 0) return [];

      const results: BatchOutcome<T>[] = [];
      for (let offset = 0; offset < requests.length; offset += MAX_BATCH_SIZE) {
        const slice = requests.slice(offset, offset + MAX_BATCH_SIZE);
        const response = await post(
          slice.map((r, i) => ({ jsonrpc: '2.0', id: offset + i, ...r })),
        );
        const body = (await response.json()) as JsonRpcResponse<T>[] | JsonRpcResponse<T>;

        if (!Array.isArray(body)) {
          // Le nœud a répondu à un batch par un objet : erreur globale.
          throw new UpstreamError(
            'robinhood-rpc',
            `batch : ${body.error?.message ?? 'réponse inattendue'}`,
          );
        }

        // L'ordre des réponses n'est pas garanti par la spec : on réaligne sur les id.
        const byId = new Map(body.map((entry) => [entry.id, entry]));
        for (let i = 0; i < slice.length; i += 1) {
          const entry = byId.get(offset + i);
          if (!entry || entry.error) {
            results.push({ ok: false, error: entry?.error?.message ?? 'réponse absente' });
          } else {
            results.push({ ok: true, value: entry.result as T });
          }
        }
      }
      return results;
    },

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
        throw new UpstreamError('robinhood-rpc', `${method} : response without a result`);
      }
      return body.result;
    },
  };
}

export { RateLimitError, TimeoutError };
