import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Même alias que tsconfig, sinon le code applicatif n'est pas résolvable
      // depuis les tests alors qu'il l'est dans Next.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'indexer/test/**/*.test.ts'],
    // Mocked nodes have no rate limit: pacing would only slow the suite down.
    // The pacing itself is tested with an injected clock. The keyed node's
    // rate is the one variable that sets it (solana/rpc.ts); the public node
    // keeps its measured rate, and the tests inject their own.
    // Live runs (SEAL_LIVE=1) keep the real pacing: they talk to the real node.
    env: process.env.SEAL_LIVE === '1' ? {} : { SEAL_SOLANA_RPC_RATE: '1000000' },
  },
});
