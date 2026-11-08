import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, NoObjectGeneratedError, Output, type FlexibleSchema, type LanguageModel, type ModelMessage } from 'ai';

/**
 * LLM provider (TRD §7.6, BE-08): Anthropic through `@ai-sdk/anthropic`, optionally via a relay
 * (`ANTHROPIC_BASE_URL`). Keys and model IDs come from config only.
 *
 * Model notes for claude-opus-5-5 (the configured default):
 * - thinking cannot be disabled and its effort defaults to `medium`, so every call states its effort;
 * - forced tool choice and sampling parameters (temperature …) are rejected, so structured output
 *   goes through native `output_config.format` (the provider's `structuredOutputMode: 'auto'`
 *   picks it for this model) and no sampling options are ever sent;
 * - a safety refusal ends the turn with `finishReason: 'content-filter'`; server-side fallbacks
 *   (`fallbacks: 'default'`) let the API retry a declined request on a fallback model first.
 *
 * Telemetry never records prompts or outputs: they are FIR text and user queries (TRD §12.3).
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type LlmPurpose = 'extraction' | 'assistant';

export interface LlmConfig {
  baseURL?: string | undefined;
  apiKey?: string | undefined;
  models: Record<LlmPurpose, string>;
  /** Per call, including retries' waits. Default 120 s. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network errors (AI SDK, exponential backoff). Default 2. */
  maxRetries?: number;
  /** Server-side refusal fallbacks (beta). Default on; turn off if the relay rejects the beta. */
  refusalFallbacks?: boolean;
  breaker?: { failureThreshold?: number; cooldownMs?: number };
  /** Injected for tests. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('LLM_NOT_CONFIGURED');
    this.name = 'LlmNotConfiguredError';
  }
}
/** The circuit is open after repeated provider failures: callers fail fast instead of piling up. */
export class LlmUnavailableError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('LLM_UNAVAILABLE');
    this.name = 'LlmUnavailableError';
  }
}
/** The model declined (safety classifiers), also after any fallback. */
export class LlmRefusalError extends Error {
  constructor() {
    super('LLM_REFUSED');
    this.name = 'LlmRefusalError';
  }
}
/** Output hit max tokens before the structured object was complete. */
export class LlmTruncatedError extends Error {
  constructor() {
    super('LLM_TRUNCATED');
    this.name = 'LlmTruncatedError';
  }
}

/**
 * Minimal circuit breaker: after `failureThreshold` consecutive provider failures the circuit opens
 * for `cooldownMs`; then one trial call is let through (half-open). A success closes it again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.openedAt !== null) {
      const waited = this.now() - this.openedAt;
      if (waited < this.cooldownMs || this.trialInFlight) throw new LlmUnavailableError(Math.max(0, this.cooldownMs - waited));
      this.trialInFlight = true; // half-open: this call is the trial
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.openedAt = null;
      return result;
    } catch (err) {
      // Refusals and truncation are answers about the input, not provider health.
      if (!(err instanceof LlmRefusalError) && !(err instanceof LlmTruncatedError)) {
        this.failures++;
        if (this.openedAt !== null || this.failures >= this.failureThreshold) this.openedAt = this.now();
      }
      throw err;
    } finally {
      this.trialInFlight = false;
    }
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt < this.cooldownMs ? 'open' : 'half-open';
  }
}

export interface StructuredRequest<T> {
  purpose: LlmPurpose;
  schema: FlexibleSchema<T>;
  schemaName: string;
  /** Frozen per use case: it is the cacheable prefix. Put nothing per-request in here. */
  system: string;
  messages: ModelMessage[];
  effort: Effort;
  maxOutputTokens?: number;
  /** Short label for telemetry grouping, never content. */
  functionId: string;
  abortSignal?: AbortSignal;
}

export interface StructuredResult<T> {
  object: T;
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined; cachedInputTokens?: number | undefined };
  model: string;
}

export interface LlmClient {
  readonly configured: boolean;
  readonly breaker: CircuitBreaker;
  model(purpose: LlmPurpose): LanguageModel;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  const configured = !!cfg.apiKey;
  const anthropic = createAnthropic({
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    apiKey: cfg.apiKey ?? 'not-configured',
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
  });
  const breaker = new CircuitBreaker(cfg.breaker?.failureThreshold, cfg.breaker?.cooldownMs, cfg.now);
  const model = (purpose: LlmPurpose) => anthropic(cfg.models[purpose]);

  return {
    configured,
    breaker,
    model,
    async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      if (!configured) throw new LlmNotConfiguredError();
      return breaker.run(async () => {
        const result = await generateText({
          model: model(req.purpose),
          output: Output.object({ schema: req.schema, name: req.schemaName }),
          // Frozen system prompt, marked for caching (TRD §7.6: cacheable prefix).
          instructions: { role: 'system', content: req.system, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
          messages: req.messages,
          maxOutputTokens: req.maxOutputTokens ?? 16_000,
          maxRetries: cfg.maxRetries ?? 2,
          timeout: { totalMs: cfg.timeoutMs ?? 120_000 },
          ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
          providerOptions: {
            anthropic: {
              effort: req.effort,
              structuredOutputMode: 'outputFormat',
              ...(cfg.refusalFallbacks === false ? {} : { fallbacks: 'default' as const }),
            },
          },
          telemetry: { recordInputs: false, recordOutputs: false, functionId: req.functionId },
        }).catch((err: unknown) => {
          // An unparseable object (cut off, or empty after a refusal) surfaces as NoObjectGeneratedError.
          if (NoObjectGeneratedError.isInstance(err)) {
            if (err.finishReason === 'length') throw new LlmTruncatedError();
            if (err.finishReason === 'content-filter') throw new LlmRefusalError();
          }
          throw err;
        });
        if (result.finishReason === 'content-filter') throw new LlmRefusalError();
        if (result.finishReason === 'length') throw new LlmTruncatedError();
        return {
          object: result.output as T,
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.inputTokenDetails?.cacheReadTokens,
          },
          model: result.response.modelId,
        };
      });
    },
  };
}
