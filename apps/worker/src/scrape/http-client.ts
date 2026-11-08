import robotsParser from 'robots-parser';
import { fetch as undiciFetch } from 'undici';
import { IntervalLimiter } from './rate-limiter';
import type { SourceConfig } from './source-config';

/** The subset of fetch this client needs; lets tests inject a fake without network access. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Decodes a response body. fetch's `text()` always assumes UTF-8, but bdlaws serves its index and
 * Act detail pages as `charset=UTF-16` (big-endian, with a BOM) and its print views as UTF-8.
 * Order: byte-order mark, then the Content-Type charset, then UTF-8. A UTF-16 body without a BOM is
 * read as big-endian (RFC 2781). Unknown charsets fall back to UTF-8 rather than failing the crawl.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'utf-8';
  else {
    const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
    if (charset === 'utf-16') encoding = 'utf-16be';
    else if (charset) encoding = charset;
  }
  try {
    return new TextDecoder(encoding).decode(bytes); // strips a matching BOM
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export interface Validators {
  etag?: string;
  lastModified?: string;
}

/** Stores ETag / Last-Modified per URL so the nightly crawl can use conditional GET. */
export interface ConditionalCache {
  get(url: string): Promise<Validators | undefined>;
  set(url: string, v: Validators): Promise<void>;
}

export class MemoryConditionalCache implements ConditionalCache {
  private readonly map = new Map<string, Validators>();
  async get(url: string) {
    return this.map.get(url);
  }
  async set(url: string, v: Validators) {
    this.map.set(url, v);
  }
}

export type FetchResult =
  | { kind: 'ok'; url: string; body: string; fetchedAt: Date; validators: Validators }
  | { kind: 'not-modified'; url: string; fetchedAt: Date };

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

/** The settings the client uses; bdlaws and SCOB each pass their own (TRD §6.1, §6A.1). */
export type HttpClientConfig = Pick<SourceConfig, 'baseUrl' | 'userAgent' | 'minIntervalMs' | 'requestTimeoutMs' | 'maxRetries'>;

export interface PoliteHttpClientOptions {
  config: HttpClientConfig;
  fetch?: FetchLike;
  limiter?: IntervalLimiter;
  cache?: ConditionalCache;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 60_000;

/**
 * HTTP client for the portal (TRD §6.1): one shared 1 req/s limiter, robots.txt honoured,
 * conditional GET, exponential backoff with jitter on 5xx/429/timeouts/network errors.
 * Every attempt, including retries and the robots.txt fetch, goes through the limiter.
 */
export class PoliteHttpClient {
  private readonly cfg: HttpClientConfig;
  private readonly doFetch: FetchLike;
  private readonly limiter: IntervalLimiter;
  private readonly cache: ConditionalCache;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => Date;
  private robots: Promise<ReturnType<typeof robotsParser>> | undefined;

  constructor(opts: PoliteHttpClientOptions) {
    this.cfg = opts.config;
    this.doFetch = opts.fetch ?? (undiciFetch as unknown as FetchLike);
    this.limiter = opts.limiter ?? new IntervalLimiter(opts.config.minIntervalMs);
    this.cache = opts.cache ?? new MemoryConditionalCache();
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => new Date());
  }

  /** Fetches a page. `conditional: false` forces a full download (weekly full re-crawl). */
  async get(url: string, opts: { conditional?: boolean } = {}): Promise<FetchResult> {
    if (!(await this.isAllowed(url))) throw new RobotsDisallowedError(url);
    const headers: Record<string, string> = { 'user-agent': this.cfg.userAgent, accept: 'text/html' };
    if (opts.conditional !== false) {
      const v = await this.cache.get(url);
      if (v?.etag) headers['if-none-match'] = v.etag;
      if (v?.lastModified) headers['if-modified-since'] = v.lastModified;
    }
    const res = await this.request(url, headers);
    const fetchedAt = this.now();
    if (res.status === 304) return { kind: 'not-modified', url, fetchedAt };
    const body = decodeBody(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'));
    const validators: Validators = {};
    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    if (etag) validators.etag = etag;
    if (lastModified) validators.lastModified = lastModified;
    if (etag || lastModified) await this.cache.set(url, validators);
    return { kind: 'ok', url, body, fetchedAt, validators };
  }

  /**
   * Raw bytes (no decoding, no conditional GET): for pages whose encoding needs special handling
   * (SCOB mixes UTF-8 and Windows-1252) and for binary files such as judgment PDFs.
   */
  async getBytes(url: string, accept = '*/*'): Promise<{ url: string; bytes: Uint8Array; contentType: string | null; fetchedAt: Date }> {
    if (!(await this.isAllowed(url))) throw new RobotsDisallowedError(url);
    const res = await this.request(url, { 'user-agent': this.cfg.userAgent, accept });
    return { url, bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type'), fetchedAt: this.now() };
  }

  private async request(url: string, headers: Record<string, string>) {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      let retryAfterMs: number | undefined;
      try {
        const res = await this.doFetch(url, { headers, signal: AbortSignal.timeout(this.cfg.requestTimeoutMs) });
        if (res.status === 200 || res.status === 304) return res;
        if (!RETRYABLE_STATUS.has(res.status) || attempt >= this.cfg.maxRetries) throw new HttpError(res.status, url);
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // Network errors, resets and timeouts are retryable.
        if (attempt >= this.cfg.maxRetries) throw err;
      }
      await this.sleep(retryAfterMs ?? this.backoff(attempt));
    }
  }

  private backoff(attempt: number): number {
    const base = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** attempt);
    return Math.round(base / 2 + this.random() * (base / 2)); // "equal jitter"
  }

  private async isAllowed(url: string): Promise<boolean> {
    this.robots ??= this.loadRobots();
    const robots = await this.robots;
    return robots.isAllowed(url, this.cfg.userAgent) ?? true;
  }

  private async loadRobots() {
    const robotsUrl = new URL('/robots.txt', this.cfg.baseUrl).toString();
    let body = '';
    try {
      const res = await this.request(robotsUrl, { 'user-agent': this.cfg.userAgent });
      body = decodeBody(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'));
    } catch (err) {
      // A missing robots.txt (4xx) means no restrictions. Anything else (unreachable) is fatal for
      // this run: we do not crawl without knowing the rules. The next run tries again.
      if (!(err instanceof HttpError && err.status >= 400 && err.status < 500)) {
        this.robots = undefined;
        throw err;
      }
    }
    return robotsParser(robotsUrl, body);
  }
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(MAX_BACKOFF_MS, secs * 1000);
  return undefined;
}
