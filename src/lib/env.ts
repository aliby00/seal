import { z } from 'zod';

/**
 * Validation de l'environnement, au démarrage et en une seule fois.
 * Un env invalide doit faire échouer le boot, pas produire une erreur
 * incompréhensible au premier appel externe.
 */
/** A variable left empty, as in `.env.example`, counts as unset. */
const blankIsUnset = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const schema = z.object({
  SEAL_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  /**
   * The keyed node's URL (one or several, comma-separated): when one is an
   * Alchemy URL, its key reads Solana through `solana-mainnet.g.alchemy.com`
   * (solana/rpc.ts). Unset: the public Solana node.
   */
  RPC_URL: z.preprocess(blankIsUnset, z.string().optional()),
  /** A Solana node of its own; takes precedence over RPC_URL's Alchemy key. */
  SOLANA_RPC_URL: z.preprocess(blankIsUnset, z.url().optional()),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
});

export type Env = z.infer<typeof schema>;

/** Every entry of RPC_URL is a URL: a typo would silently fall back to the public node. */
const checked = schema.refine(
  (env) =>
    (env.RPC_URL ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .every((entry) => z.url().safeParse(entry).success),
  { message: 'every entry must be a URL', path: ['RPC_URL'] },
);

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = checked.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(racine)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration d'environnement invalide :\n${details}`);
  }
  return result.data;
}

export const isProduction = (env: Env): boolean => env.SEAL_ENV === 'production';
