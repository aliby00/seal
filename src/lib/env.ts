import { z } from 'zod';

/**
 * Validation de l'environnement, au démarrage et en une seule fois.
 * Un env invalide doit faire échouer le boot, pas produire une erreur
 * incompréhensible au premier appel externe.
 */
/** `INDEXER_URL=` laissé vide, comme dans `.env.example`, vaut « non configuré ». */
const blankIsUnset = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const schema = z.object({
  SEAL_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  RPC_URL: z.url().default('https://rpc.mainnet.chain.robinhood.com'),
  BLOCKSCOUT_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Indexeur SEAL (`indexer/`) : les deux ensemble, ou aucun. Sans eux,
  // l'application fonctionne comme avant, sans ses réponses.
  INDEXER_URL: z.preprocess(blankIsUnset, z.url().optional()),
  INDEXER_TOKEN: z.preprocess(blankIsUnset, z.string().min(24).optional()),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
});

export type Env = z.infer<typeof schema>;

/** Un seul des deux ne sert à rien : c'est presque toujours un oubli de configuration. */
const paired = schema.refine((env) => Boolean(env.INDEXER_URL) === Boolean(env.INDEXER_TOKEN), {
  message: 'INDEXER_URL and INDEXER_TOKEN go together',
  path: ['INDEXER_TOKEN'],
});

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = paired.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(racine)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration d'environnement invalide :\n${details}`);
  }
  return result.data;
}

export const isProduction = (env: Env): boolean => env.SEAL_ENV === 'production';
