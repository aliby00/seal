import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  GROQ_DEFAULT_MODEL,
  createAnthropicProvider,
  createGroqProvider,
  resolveProvider,
} from '../../src/lib/agent/providers';
import { thinkingParams } from '../../src/lib/agent/providers/anthropic';
import { UpstreamError } from '../../src/lib/errors';

afterEach(() => vi.unstubAllGlobals());

describe('resolveProvider', () => {
  // Le défaut doit être gratuit : on ne dépense pas sans que ce soit demandé.
  it('préfère Groq quand les deux clés sont présentes', () => {
    const r = resolveProvider({ GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' });
    expect(r?.provider.name).toBe('groq');
    expect(r?.model).toBe(GROQ_DEFAULT_MODEL);
  });

  it('retombe sur Anthropic si Groq manque', () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'a' })?.provider.name).toBe('anthropic');
  });

  it("renvoie undefined sans aucune clé — l'appelant bascule en hors-ligne", () => {
    expect(resolveProvider({})).toBeUndefined();
  });

  it('AGENT_PROVIDER force le choix', () => {
    const r = resolveProvider({
      AGENT_PROVIDER: 'anthropic',
      GROQ_API_KEY: 'g',
      ANTHROPIC_API_KEY: 'a',
    });
    expect(r?.provider.name).toBe('anthropic');
  });

  it('AGENT_PROVIDER=offline désactive tout, même avec des clés', () => {
    expect(resolveProvider({ AGENT_PROVIDER: 'offline', GROQ_API_KEY: 'g' })).toBeUndefined();
  });

  it('ne force pas un fournisseur dont la clé manque', () => {
    expect(resolveProvider({ AGENT_PROVIDER: 'groq', ANTHROPIC_API_KEY: 'a' })).toBeUndefined();
  });

  it('respecte GROQ_MODEL', () => {
    const r = resolveProvider({ GROQ_API_KEY: 'g', GROQ_MODEL: 'openai/gpt-oss-120b' });
    expect(r?.model).toBe('openai/gpt-oss-120b');
  });
});

describe('createGroqProvider', () => {
  const request = { system: 'sys', user: 'usr', model: GROQ_DEFAULT_MODEL, maxTokens: 1500 };

  it("parle bien à l'endpoint compatible OpenAI", async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Les signaux divergent.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 6000, completion_tokens: 700 },
        }),
        { status: 200 },
      );
    });

    const result = await createGroqProvider('clé').complete(request);
    expect(seenUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(seenBody.model).toBe(GROQ_DEFAULT_MODEL);
    expect(result.text).toBe('Les signaux divergent.');
    expect(result.usage.input_tokens).toBe(6000);
    expect(result.usage.output_tokens).toBe(700);
  });

  it('envoie le system prompt et les données séparément', async () => {
    let msgs: { role: string; content: string }[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      msgs = (JSON.parse(String(init.body)) as { messages: typeof msgs }).messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    });
    await createGroqProvider('clé').complete(request);
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'usr' });
  });

  it('transforme une erreur Groq en UpstreamError', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { message: 'quota journalier atteint' } }), {
          status: 200,
        }),
    );
    await expect(createGroqProvider('clé').complete(request)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('tolère une réponse sans usage', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
    );
    const r = await createGroqProvider('clé').complete(request);
    expect(r.usage.input_tokens).toBe(0);
  });
});

describe('Anthropic', () => {
  /** A client that keeps what it was sent and answers with `content`. */
  function fakeClient(content: unknown[], stop = 'end_turn') {
    const sent: Record<string, unknown>[] = [];
    const client = {
      create: async (params: Record<string, unknown>) => {
        sent.push(params);
        return {
          content,
          stop_reason: stop,
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    } as unknown as Parameters<typeof createAnthropicProvider>[1];
    return { client, sent };
  }

  const ask = { system: 'sys', user: 'facts', maxTokens: 1500, model: 'claude-sonnet-5-5' };

  // Prod 26/11/2026: left to its default, Sonnet 5.5 thought with up to 1,100 of
  // the 1,500 tokens, and 4 calls in 31 stopped at max_tokens, served offline.
  it('turns thinking off on Claude Sonnet 5.5 with between_tools, the whole budget left to the text', async () => {
    const { client, sent } = fakeClient([{ type: 'text', text: 'ok' }]);
    await createAnthropicProvider('k', client).complete(ask);
    expect(sent[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 1500,
      thinking: { type: 'between_tools' },
    });
    // No other field next to it (a 400), and no effort above high (a 400 too).
    expect(sent[0]!.thinking).toEqual({ type: 'between_tools' });
    expect(sent[0]).not.toHaveProperty('output_config');
  });

  it('keeps thinking short on models that cannot turn it off', async () => {
    const { client, sent } = fakeClient([{ type: 'text', text: 'ok' }]);
    await createAnthropicProvider('k', client).complete({ ...ask, model: 'claude-opus-5-5' });
    expect(sent[0]).toMatchObject({ output_config: { effort: 'low' } });
    // between_tools is a 400 on any model but Sonnet 5.5.
    expect(sent[0]).not.toHaveProperty('thinking');
  });

  it('sends an unknown or older model id as before', () => {
    expect(thinkingParams('claude-haiku-4-5')).toEqual({});
    expect(thinkingParams('some-model')).toEqual({});
    expect(thinkingParams('claude-sonnet-5')).toEqual({ output_config: { effort: 'low' } });
  });

  it('reads the text by block type, after a thinking block', async () => {
    const { client } = fakeClient([
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'the text' },
    ]);
    const r = await createAnthropicProvider('k', client).complete(ask);
    expect(r).toMatchObject({ text: 'the text', stopReason: 'end_turn' });
    expect(r.usage.output_tokens).toBe(20);
  });
});
