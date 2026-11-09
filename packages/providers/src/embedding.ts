/**
 * Embedding provider (TRD §2, §3.2): bge-m3 behind Hugging Face Text Embeddings Inference (TEI).
 * Swappable: business logic depends only on `EmbeddingProvider`.
 */
export interface EmbeddingProvider {
  /** Recorded in `section_chunks.embedding_model`; a change triggers a re-embed. */
  readonly model: string;
  readonly dimensions: number;
  /** Returns one vector per input, in input order. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export type EmbedFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface TeiEmbeddingOptions {
  url: string;
  /** e.g. "BAAI/bge-m3@<revision>". */
  model: string;
  dimensions?: number;
  /** TEI max client batch; TRD §6.4 uses 64. */
  batchSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: EmbedFetch;
  sleep?: (ms: number) => Promise<void>;
}

export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingError';
  }
}

export class TeiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly endpoint: string;
  private readonly healthUrl: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly doFetch: EmbedFetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TeiEmbeddingOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions ?? 1024;
    this.endpoint = new URL('/embed', opts.url).toString();
    this.healthUrl = new URL('/health', opts.url).toString();
    this.batchSize = opts.batchSize ?? 64;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as EmbedFetch);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * True when TEI answers its health check: callers skip work while the model server is down
   * instead of counting failures against each item (the outbox would otherwise park every event).
   */
  async ready(timeoutMs = 3000): Promise<boolean> {
    try {
      const res = await fetch(this.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize))));
    }
    return out;
  }

  private async embedBatch(batch: readonly string[]): Promise<number[][]> {
    // normalize → unit vectors for cosine; truncate → over-long input is cut, not rejected.
    const body = JSON.stringify({ inputs: batch, normalize: true, truncate: true });
    for (let attempt = 0; ; attempt++) {
      // Never include input text in errors: they end up in logs and outbox.last_error.
      let failure: string;
      try {
        const res = await this.doFetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 200) return this.validate(await res.json(), batch.length);
        // 4xx (other than 429) means a bad request: retrying will not help.
        if (res.status !== 429 && res.status < 500) throw new EmbeddingError(`TEI /embed returned HTTP ${res.status}`);
        failure = `HTTP ${res.status}`;
      } catch (err) {
        if (err instanceof EmbeddingError) throw err;
        failure = (err as Error).name;
        if (attempt >= this.maxRetries) {
          throw new EmbeddingError(`TEI /embed failed after ${attempt + 1} attempts: ${failure}`, { cause: err });
        }
      }
      if (attempt >= this.maxRetries) throw new EmbeddingError(`TEI /embed failed after ${attempt + 1} attempts: ${failure}`);
      await this.sleep(500 * 2 ** attempt);
    }
  }

  private validate(json: unknown, expected: number): number[][] {
    if (!Array.isArray(json) || json.length !== expected) {
      throw new EmbeddingError(`TEI returned ${Array.isArray(json) ? json.length : 'no'} vectors for ${expected} inputs`);
    }
    for (const v of json) {
      if (!Array.isArray(v) || v.length !== this.dimensions || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new EmbeddingError(`TEI returned a vector that is not ${this.dimensions}-dim numeric`);
      }
    }
    return json as number[][];
  }
}
