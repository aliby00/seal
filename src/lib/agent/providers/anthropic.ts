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

/** Current models that take `output_config.effort` (Sonnet 5.5 is handled apart). */
const EFFORT_MODELS = /^claude-(opus-(5|4-[678])|sonnet-(5|4-6)|haiku-5-5|fable-5|mythos-5)/;

/**
 * How much the model may think before it writes, said explicitly rather than
 * left to the default. Left out, Claude Sonnet 5.5 runs adaptive thinking at
 * effort `high`: in prod (26/11/2026) hidden thinking took 600 to 1,100 of the
 * 1,500 output tokens, and 4 calls in 31 stopped at `max_tokens` with the text
 * cut or empty (BASKET: 1,500 tokens, no text at all), served offline and paid.
 *
 * - Claude Sonnet 5.5: `thinking: {type: "between_tools"}`, its way to turn
 *   thinking off (`{type: "disabled"}` is a 400 on it). There are no tools in
 *   this call, so it does not think at all: the whole budget is the text. It is
 *   accepted only by Sonnet 5.5, at effort `high` or below (the default), with
 *   no other field inside `thinking`.
 * - Other current models (Claude Opus 5.5 cannot turn thinking off at all):
 *   adaptive thinking kept, at effort `low`, so it stays short.
 * - Anything else (an older model, an unknown id): the request as before.
 */
export function thinkingParams(model: string): Record<string, unknown> {
  if (/^claude-sonnet-5-5(\b|$)/.test(model)) return { thinking: { type: 'between_tools' } };
  if (EFFORT_MODELS.test(model)) return { output_config: { effort: 'low' } };
  return {};
}

export function createAnthropicProvider(apiKey: string, client?: Anthropic['messages']): Provider {
  const messages =
    client ?? new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: 0 }).messages;

  return {
    name: 'anthropic',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const params = {
        model: request.model,
        max_tokens: request.maxTokens,
        // No cache breakpoint: the system prompts are under the 512 tokens a
        // prefix needs to be cached, and at this traffic a cache write
        // (1.25x the input price) would rarely be read back within 5 minutes.
        system: request.system,
        messages: [{ role: 'user' as const, content: request.user }],
        // SDK 0.128 does not type `between_tools` yet: sent as is.
        ...thinkingParams(request.model),
      } as unknown as Anthropic.MessageCreateParamsNonStreaming;
      const response = (await messages.create(
        params,
        request.signal ? { signal: request.signal } : undefined,
      )) as Anthropic.Message;

      if (response.stop_reason === 'refusal') {
        throw new UpstreamError('anthropic', 'the model refused the request');
      }

      const usage = response.usage;
      return {
        // Read by block type: a thinking block (empty under the default
        // display) may come before the text.
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
