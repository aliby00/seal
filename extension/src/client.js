/*
 * Asking sealauth.dev for a token's glance, politely: each answer is kept
 * five minutes, a token already being asked is not asked twice, and a 429
 * stops every request until the server's wait is over. Only the token (or
 * pair) address leaves the browser.
 */
(function (root) {
  'use strict';
  const ns = (root.SealExt = root.SealExt || {});

  const MESSAGES = {
    unreadable: 'SEAL could not read this token right now.',
    busy: 'SEAL is answering many requests. Try again in a minute.',
    unknown: 'SEAL found nothing for this address on Robinhood Chain.',
    invalid: 'This is not a token address.',
  };

  /** A store that only lives as long as the worker: used when no other is given. */
  function memoryStore() {
    const map = new Map();
    return {
      async get(key) {
        return map.get(key);
      },
      async set(key, value) {
        map.set(key, value);
      },
      async remove(key) {
        map.delete(key);
      },
    };
  }

  /** chrome.storage.session (cleared when the browser closes) behind the same three calls. */
  function sessionStore(area) {
    return {
      async get(key) {
        const found = await area.get(key);
        return found ? found[key] : undefined;
      },
      async set(key, value) {
        await area.set({ [key]: value });
      },
      async remove(key) {
        await area.remove(key);
      },
    };
  }

  function retryAfterMs(header, fallback) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 600) * 1000;
    return fallback;
  }

  /**
   * @param {object} options
   * @param {(url: string, init?: object) => Promise<Response>} options.fetch
   * @param {() => Promise<string> | string} options.apiBase
   * @param {object} [options.store] get/set/remove, async
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs]
   * @param {number} [options.backoffMs]
   * @param {number} [options.timeoutMs]
   */
  function createClient(options) {
    const config = ns.config || {};
    const store = options.store || memoryStore();
    const now = options.now || Date.now;
    const ttlMs = options.ttlMs ?? config.CACHE_TTL_MS ?? 300_000;
    const backoffMs = options.backoffMs ?? config.BACKOFF_MS ?? 60_000;
    const timeoutMs = options.timeoutMs ?? config.REQUEST_TIMEOUT_MS ?? 45_000;
    const inflight = new Map();
    let pausedUntil = 0;

    async function ask(query) {
      const base = String(await options.apiBase()).replace(/\/+$/, '');
      const param = query.kind === 'pair' ? 'pair' : 'token';
      const url = `${base}/api/glance?${param}=${encodeURIComponent(query.address)}`;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      let response;
      try {
        response = await options.fetch(url, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch {
        return { ok: false, status: 0, message: MESSAGES.unreadable };
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (response.status === 429) {
        pausedUntil = now() + retryAfterMs(response.headers.get('retry-after'), backoffMs);
        return { ok: false, status: 429, message: MESSAGES.busy };
      }
      if (!response.ok) {
        const message =
          response.status === 404
            ? MESSAGES.unknown
            : response.status === 400
              ? MESSAGES.invalid
              : MESSAGES.unreadable;
        return { ok: false, status: response.status, message };
      }
      let data;
      try {
        data = await response.json();
      } catch {
        return { ok: false, status: response.status, message: MESSAGES.unreadable };
      }
      if (!data || !data.glance || !Array.isArray(data.glance.items)) {
        return { ok: false, status: response.status, message: MESSAGES.unreadable };
      }
      return { ok: true, data };
    }

    /** The glance for `{ kind, address }`: `{ ok: true, data }` or `{ ok: false, status, message }`. */
    async function get(query) {
      const key = `glance:${query.kind}:${String(query.address).toLowerCase()}`;
      const cached = await store.get(key).catch(() => undefined);
      if (cached && now() - cached.at < ttlMs) return { ok: true, data: cached.data, cached: true };
      if (now() < pausedUntil) return { ok: false, status: 429, message: MESSAGES.busy };

      const pending = inflight.get(key);
      if (pending) return pending;
      const work = ask(query)
        .then(async (result) => {
          if (result.ok) {
            const entry = { at: now(), data: result.data };
            await store.set(key, entry).catch(() => undefined);
            // A pair resolved to its token is also known by the token's own address.
            if (result.data.token && query.kind === 'pair') {
              await store
                .set(`glance:token:${String(result.data.token).toLowerCase()}`, entry)
                .catch(() => undefined);
            }
          }
          return result;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, work);
      return work;
    }

    return {
      get,
      /** For tests: how many tokens are being asked right now. */
      pending: () => inflight.size,
      pausedUntil: () => pausedUntil,
    };
  }

  ns.client = { createClient, memoryStore, sessionStore, MESSAGES };
})(globalThis);
