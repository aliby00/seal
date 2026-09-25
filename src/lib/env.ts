import { z } from 'zod';

/**
 * Validation de l'environnement, au démarrage et en une seule fois.
 * Un env invalide doit faire échouer le boot, pas produire une erreur
 * incompréhensible au premier appel externe.
 */
const schema = z.object({
  SEAL_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  RPC_URL: z.url().default('https://rpc.mainnet.chain.robinhood.com'),
  BLOCKSCOUT_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(racine)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration d'environnement invalide :\n${details}`);
  }
  return result.data;
}

export const isProduction = (env: Env): boolean => env.SEAL_ENV === 'production';
