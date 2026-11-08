import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

/**
 * Typed API contract shared by the web and (via openapi.json) the mobile app.
 * `schema.ts` and `openapi.json` are generated from the API's Zod route schemas; never edit them.
 */
export type { components, paths };
export type ApiClient = Client<paths>;

/** RFC 9457 problem details, as every API error is returned (TRD §5). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
}

export const isProblem = (v: unknown): v is Problem =>
  typeof v === 'object' && v !== null && typeof (v as Problem).status === 'number' && typeof (v as Problem).code === 'string';

export interface ApiClientOptions {
  /** API origin, e.g. `http://localhost:3000` (paths already start with /api/v1). */
  baseUrl: string;
  /** Current access token, or null when signed out. Read on every request. */
  getAccessToken?: () => string | null | Promise<string | null>;
  /** Language for server messages (`Accept-Language`). */
  getLanguage?: () => 'bn' | 'en';
  fetch?: typeof fetch;
}

/**
 * openapi-fetch client with the bearer token and language added to every request. Cookies are
 * sent (`credentials: 'include'`) because the web keeps its refresh token in an HttpOnly cookie
 * scoped to /api/v1/auth/refresh.
 */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, credentials: 'include', ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const auth: Middleware = {
    async onRequest({ request }) {
      const token = await opts.getAccessToken?.();
      if (token) request.headers.set('authorization', `Bearer ${token}`);
      const lang = opts.getLanguage?.();
      if (lang) request.headers.set('accept-language', lang);
      return request;
    },
  };
  client.use(auth);
  return client;
}

/** One server-sent event. `data` is the joined data lines (raw text). */
export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/**
 * Parses a text/event-stream body (WHATWG SSE rules: `event`, `data`, `id` fields, comments
 * ignored, events end at a blank line, CRLF / LF / CR line ends). Used with `fetch` because
 * `EventSource` can't send the bearer token.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | null = null;
  let lastWasCR = false;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      // A CRLF split across chunks: the CR already ended the line, so drop the LF.
      const chunk = lastWasCR && value.startsWith('\n') ? value.slice(1) : value;
      lastWasCR = value.endsWith('\r');
      buffer += chunk;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n'), id };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
        else if (field === 'id' && !val.includes('\0')) id = val;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** Document status event from `GET …/artifacts/{id}/events` (BE-26): ids and status only. */
export interface ArtifactStatusEvent {
  artifact_id: string;
  status: 'UPLOADED' | 'OCR' | 'EXTRACTING' | 'SCHEDULE_LOOKUP' | 'ANALYZING' | 'READY' | 'FAILED';
  error: string | null;
  at: string;
}

/** Status events of one document; ends when the server closes the stream (READY / FAILED / time cap). */
export async function* artifactStatusEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ArtifactStatusEvent> {
  for await (const e of readSse(body, signal)) {
    if (e.event === 'status') yield JSON.parse(e.data) as ArtifactStatusEvent;
  }
}
