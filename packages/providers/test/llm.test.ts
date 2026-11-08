import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CircuitBreaker, createLlmClient, LlmNotConfiguredError, LlmRefusalError, LlmTruncatedError, LlmUnavailableError, type LlmConfig } from '../src/llm';

/**
 * LLM provider (BE-08) against a fake Anthropic endpoint: the request shape that claude-opus-5-5
 * needs, result mapping, refusal / truncation handling, retries and the circuit breaker.
 */
const schema = z.object({ city: z.string(), population_millions: z.number().nullable() });

function message(over: { text?: string; stop_reason?: string; status?: number } = {}) {
  if (over.status && over.status >= 400) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream down' } }), { status: over.status, headers: { 'content-type': 'application/json' } });
  }
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: over.text ?? '{"city":"Dhaka","population_millions":null}' }],
      stop_reason: over.stop_reason ?? 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fakeEndpoint(responses: (() => Response)[]) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  };
  return { fetch, requests };
}

const base = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  baseURL: 'https://relay.example/v1',
  apiKey: 'test-key-not-real',
  models: { extraction: 'claude-opus-5-5', assistant: 'claude-opus-5-5' },
  maxRetries: 0,
  ...over,
});

const ask = (llm: ReturnType<typeof createLlmClient>) =>
  llm.generateStructured({
    purpose: 'extraction',
    schema,
    schemaName: 'place',
    system: 'Extract the place as JSON.',
    messages: [{ role: 'user', content: 'Dhaka is the capital of Bangladesh.' }],
    effort: 'medium',
    functionId: 'test',
  });

describe('createLlmClient', () => {
  it('sends what claude-opus-5-5 accepts: native structured output, explicit effort, fallbacks, cached system prompt', async () => {
    const ep = fakeEndpoint([() => message()]);
    const r = await ask(createLlmClient(base({ fetch: ep.fetch })));
    expect(r.object).toEqual({ city: 'Dhaka', population_millions: null });
    expect(r.usage).toEqual({ inputTokens: 220, outputTokens: 12, cachedInputTokens: 100 });

    const req = ep.requests[0]!;
    expect(req.url).toBe('https://relay.example/v1/messages');
    expect(req.headers.get('x-api-key')).toBe('test-key-not-real');
    expect(req.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } } },
    });
    expect(req.body.system).toEqual([{ type: 'text', text: 'Extract the place as JSON.', cache_control: { type: 'ephemeral' } }]);
    // Rejected by this model: forced tool choice, sampling parameters, disabled thinking / budgets.
    for (const key of ['tool_choice', 'tools', 'temperature', 'top_p', 'top_k', 'thinking']) expect(req.body).not.toHaveProperty(key);
  });

  it('can leave refusal fallbacks off for a relay that rejects the beta', async () => {
    const ep = fakeEndpoint([() => message()]);
    await ask(createLlmClient(base({ fetch: ep.fetch, refusalFallbacks: false })));
    expect(ep.requests[0]!.body).not.toHaveProperty('fallbacks');
    expect(ep.requests[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
  });

  it('maps a refusal and a max_tokens stop to typed errors', async () => {
    await expect(ask(createLlmClient(base({ fetch: fakeEndpoint([() => message({ text: '', stop_reason: 'refusal' })]).fetch })))).rejects.toBeInstanceOf(LlmRefusalError);
    await expect(ask(createLlmClient(base({ fetch: fakeEndpoint([() => message({ text: '{"city":"Dh', stop_reason: 'max_tokens' })]).fetch })))).rejects.toBeInstanceOf(
      LlmTruncatedError,
    );
  });

  it('fails clearly without an API key, without calling out', async () => {
    const ep = fakeEndpoint([() => message()]);
    await expect(ask(createLlmClient(base({ apiKey: undefined, fetch: ep.fetch })))).rejects.toBeInstanceOf(LlmNotConfiguredError);
    expect(ep.requests).toHaveLength(0);
  });

  it('retries 5xx, then opens the circuit after repeated failures and recovers after the cooldown', async () => {
    let now = 0;
    const ep = fakeEndpoint([() => message({ status: 529 })]);
    const llm = createLlmClient(base({ fetch: ep.fetch, maxRetries: 1, breaker: { failureThreshold: 2, cooldownMs: 1_000 }, now: () => now }));
    await expect(ask(llm)).rejects.toThrow();
    expect(ep.requests).toHaveLength(2); // first try + 1 retry
    await expect(ask(llm)).rejects.toThrow();
    expect(llm.breaker.state).toBe('open');
    await expect(ask(llm)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(ep.requests).toHaveLength(4); // the open circuit sent nothing

    now = 1_500; // cooldown over: one trial call goes through and succeeds
    const healthy = fakeEndpoint([() => message()]);
    const llm2 = createLlmClient(base({ fetch: healthy.fetch, breaker: { failureThreshold: 1, cooldownMs: 1_000 }, now: () => now }));
    expect((await ask(llm2)).object.city).toBe('Dhaka');
  });
});

describe('CircuitBreaker', () => {
  it('does not count refusals or truncation as provider failures', async () => {
    const b = new CircuitBreaker(1, 1_000, () => 0);
    await expect(b.run(() => Promise.reject(new LlmRefusalError()))).rejects.toBeInstanceOf(LlmRefusalError);
    await expect(b.run(() => Promise.reject(new LlmTruncatedError()))).rejects.toBeInstanceOf(LlmTruncatedError);
    expect(b.state).toBe('closed');
  });

  it('half-open: one trial; a failed trial reopens, a successful one closes', async () => {
    let now = 0;
    const b = new CircuitBreaker(1, 100, () => now);
    await expect(b.run(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(b.state).toBe('open');
    now = 150;
    expect(b.state).toBe('half-open');
    await expect(b.run(() => Promise.reject(new Error('still down')))).rejects.toThrow('still down');
    expect(b.state).toBe('open');
    now = 300;
    await expect(b.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(b.state).toBe('closed');
  });
});
