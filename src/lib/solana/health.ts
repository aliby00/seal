import { SealError } from '../errors';
import { createSolanaRpc, solanaRpcNodes, type SolanaNode } from './rpc';

/** What /api/health says of the Solana node: its label and a `getSlot`, never its URL. */
export type SolanaNodeHealth = {
  /** The node read first: `alchemy`, `solana-rpc-url` or `public`. */
  node: SolanaNode['label'];
  /** Nodes tried in turn, the public one included: 1 means no failover. */
  nodes: number;
  slotOk: boolean;
  slot: number | null;
  /** The error's kind when the slot was not read (`timeout`, `rate-limit`…); never its message. */
  error: string | null;
  ms: number;
};

/** The `getSlot` of a health probe gets this long in all. */
export const HEALTH_SLOT_TIMEOUT_MS = 2_000;

/**
 * Asks the first configured node for its slot (its own retries only, 2 s in
 * all), without falling back to the next: the probe says whether the node
 * the analyses use answers. Never throws.
 */
export async function solanaNodeHealth(
  env: Record<string, string | undefined> = process.env,
  options: { nodes?: SolanaNode[]; timeoutMs?: number } = {},
): Promise<SolanaNodeHealth> {
  const nodes = options.nodes ?? solanaRpcNodes(env);
  const first = nodes[0] as SolanaNode;
  const started = Date.now();
  try {
    const rpc = createSolanaRpc({
      nodes: [first],
      maxCalls: 3,
      signal: AbortSignal.timeout(options.timeoutMs ?? HEALTH_SLOT_TIMEOUT_MS),
    });
    const slot = await rpc.getSlot();
    const ok = Number.isSafeInteger(slot) && slot > 0;
    return {
      node: first.label,
      nodes: nodes.length,
      slotOk: ok,
      slot: ok ? slot : null,
      error: ok ? null : 'unexpected answer',
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      node: first.label,
      nodes: nodes.length,
      slotOk: false,
      slot: null,
      error: error instanceof SealError ? error.kind : 'error',
      ms: Date.now() - started,
    };
  }
}
