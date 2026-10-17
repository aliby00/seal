/**
 * The extension's scripts are plain browser scripts that add to one global
 * namespace. Loaded here in the same order as in the manifest, and typed for
 * the tests.
 */
import '../../extension/src/config.js';
import '../../extension/src/detect.js';
import '../../extension/src/client.js';
import '../../extension/src/card.js';
import '../../extension/src/styles.js';

export type Query = { kind: 'token' | 'pair'; address: string };

export type VNode = { tag: string; attrs: Record<string, string>; children: (VNode | string)[] };

export type Reply =
  { ok: true; data: GlanceData; cached?: boolean } | { ok: false; status: number; message: string };

export type GlanceData = {
  token: string;
  name: string | null;
  symbol: string | null;
  url: string;
  collectedAt: string;
  glance: {
    headline: string;
    items: {
      id: string;
      tone: string;
      figure: string;
      title: string;
      detail: string;
      href: string;
    }[];
    unseen: string[];
  };
};

type Store = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
};

type SealExt = {
  config: { CACHE_TTL_MS: number; HOVER_DELAY_MS: number; LOCAL_API: RegExp; API_BASE: string };
  detect: {
    fromUrl(href: string, base?: string): Query | null;
    fromLink(anchor: unknown, base?: string): Query | null;
    keyOf(query: Query): string;
    siteOf(hostname: string): string;
  };
  client: {
    createClient(options: {
      fetch: (url: string, init?: RequestInit) => Promise<Response>;
      apiBase: () => string | Promise<string>;
      store?: Store;
      now?: () => number;
      ttlMs?: number;
      backoffMs?: number;
    }): { get(query: Query): Promise<Reply>; pending(): number; pausedUntil(): number };
    memoryStore(): Store;
    MESSAGES: Record<string, string>;
  };
  card: {
    renderCard(
      state:
        | { status: 'loading' }
        | { status: 'error'; message: string; retry?: boolean }
        | { status: 'ready'; data: GlanceData },
      options?: { compact?: boolean; closable?: boolean; titleId?: string },
    ): VNode;
    textOf(node: VNode | string): string;
    findAll(node: VNode, test: (node: VNode) => boolean): VNode[];
    safeHref(url: string): string | null;
  };
  CSS: string;
};

export const ext = (globalThis as unknown as { SealExt: SealExt }).SealExt;
