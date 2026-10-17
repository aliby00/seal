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
    // The pacing itself is tested with an injected clock.
    // Live runs (SEAL_LIVE=1) keep the real pacing: they talk to the real node.
    env:
      process.env.SEAL_LIVE === '1'
        ? {}
        : { SEAL_RPC_RATE: '1000000', SEAL_PUBLIC_RPC_RATE: '1000000' },
  },
});
