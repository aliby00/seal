import Anthropic from '@anthropic-ai/sdk';
import { UpstreamError } from '../../errors';
import type { CompletionRequest, CompletionResult, Provider } from './types';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * The SDK default is ten minutes and two retries; the route has 60 seconds in
 * all. A call that cannot finish in time is cut, and the facts are served. No
 * retry: a second 25 s attempt would outlive the function, and the first one
 * would be paid for nothing.
 */
export const ANTHROPIC_TIMEOUT_MS = 25_000;

export function createAnthropicProvider(apiKey: string, client?: Anthropic['messages']): Provider {
  const messages =
    client ?? new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: 0 }).messages;

  return {
    name: 'anthropic',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const response = (await messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          // No cache breakpoint: the system prompts are under the 512 tokens a
          // prefix needs to be cached, and at this traffic a cache write
          // (1.25x the input price) would rarely be read back within 5 minutes.
          system: request.system,
          messages: [{ role: 'user' as const, content: request.user }],
        },
        request.signal ? { signal: request.signal } : undefined,
      )) as Anthropic.Message;

      if (response.stop_reason === 'refusal') {
        throw new UpstreamError('anthropic', 'the model refused the request');
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
