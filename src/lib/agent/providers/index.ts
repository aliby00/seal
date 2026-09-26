import { ANTHROPIC_DEFAULT_MODEL, createAnthropicProvider } from './anthropic';
import { GROQ_DEFAULT_MODEL, createGroqProvider } from './groq';
import type { Provider } from './types';

export * from './types';
export { GROQ_BASE_URL, GROQ_DEFAULT_MODEL, createGroqProvider } from './groq';
export { ANTHROPIC_DEFAULT_MODEL, createAnthropicProvider } from './anthropic';

export type ResolvedProvider = { provider: Provider; model: string } | undefined;

/**
 * Choisit le fournisseur à partir de l'environnement.
 *
 * `AGENT_PROVIDER` force un fournisseur ; sans lui, on prend le premier dont
 * la clé est disponible, Groq d'abord parce qu'il est gratuit. Si rien n'est
 * configuré, on renvoie `undefined` et l'appelant bascule en mode hors-ligne.
 */
export function resolveProvider(
  env: Record<string, string | undefined> = process.env,
): ResolvedProvider {
  const forced = env.AGENT_PROVIDER;
  const groqKey = env.GROQ_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;

  const groq = (): ResolvedProvider =>
    groqKey
      ? {
          provider: createGroqProvider(groqKey),
          model: env.GROQ_MODEL ?? GROQ_DEFAULT_MODEL,
        }
      : undefined;

  const anthropic = (): ResolvedProvider =>
    anthropicKey
      ? {
          provider: createAnthropicProvider(anthropicKey),
          model: env.ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL,
        }
      : undefined;

  if (forced === 'groq') return groq();
  if (forced === 'anthropic') return anthropic();
  if (forced === 'offline') return undefined;

  // Gratuit d'abord : on ne dépense pas par défaut.
  return groq() ?? anthropic();
}
