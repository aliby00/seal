import { UpstreamError } from '../../errors';
import { requestJson } from '../../http';
import type { CompletionRequest, CompletionResult, Provider } from './types';

/**
 * Groq — API compatible OpenAI, tier gratuit sans carte bancaire.
 *
 * Limites mesurées sur le plan gratuit (par organisation, pas par clé) :
 *   llama-3.3-70b-versatile   30 RPM · 1 000 req/jour · 12k TPM · 100k tokens/jour
 *   openai/gpt-oss-120b       30 RPM · 1 000 req/jour ·  8k TPM · 200k tokens/jour
 *
 * Une analyse SEAL pèse ~6 700 tokens : compter ~14 analyses/jour sur le 70B et
 * ~28 sur le gpt-oss-120b. Suffisant pour développer, pas pour un service public.
 */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

type ChatCompletion = {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
};

export function createGroqProvider(apiKey: string, baseUrl = GROQ_BASE_URL): Provider {
  return {
    name: 'groq',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const body = await requestJson<ChatCompletion>(`${baseUrl}/chat/completions`, {
        source: 'anthropic', // même budget d'erreurs et de retries que l'autre fournisseur
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxTokens,
            // Un peu de déterminisme : le whitepaper assume la variabilité,
            // mais rien n'oblige à l'amplifier.
            temperature: 0.3,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
          }),
        },
      });

      if (body.error) {
        throw new UpstreamError('anthropic', `groq : ${body.error.message ?? 'erreur inconnue'}`);
      }

      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? '';

      return {
        text,
        usage: {
          input_tokens: body.usage?.prompt_tokens ?? 0,
          output_tokens: body.usage?.completion_tokens ?? 0,
        },
        ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
      };
    },
  };
}
