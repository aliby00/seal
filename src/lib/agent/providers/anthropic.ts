import Anthropic from '@anthropic-ai/sdk';
import { UpstreamError } from '../../errors';
import type { CompletionRequest, CompletionResult, Provider } from './types';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';

export function createAnthropicProvider(apiKey: string, client?: Anthropic['messages']): Provider {
  const messages = client ?? new Anthropic({ apiKey }).messages;

  return {
    name: 'anthropic',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const response = (await messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        // Préfixe stable marqué pour le cache : le system prompt ne change pas
        // d'une requête à l'autre, les données du token si.
        system: [
          {
            type: 'text' as const,
            text: request.system,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        messages: [{ role: 'user' as const, content: request.user }],
      })) as Anthropic.Message;

      if (response.stop_reason === 'refusal') {
        throw new UpstreamError('anthropic', 'la requête a été refusée par le modèle');
      }

      const usage = response.usage;
      return {
        text: response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join(''),
        // On recopie les champs utiles au calcul de coût plutôt que de caster
        // le type du SDK, qui n'est pas un Record<string, number>.
        usage: {
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
          cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
        },
        ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
      };
    },
  };
}
