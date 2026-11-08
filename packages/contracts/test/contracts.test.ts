import { describe, expect, it } from 'vitest';
import { artifactStatusEvents, createApiClient, isProblem, readSse } from '../src/index';

/** WEB-01 contracts: typed client middleware and the fetch-based SSE reader. */
const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('createApiClient', () => {
  it('adds the bearer token and language, sends cookies, and returns typed data or a problem', async () => {
    const seen: Request[] = [];
    const fetch = (async (req: Request) => {
      seen.push(req);
      return req.url.endsWith('/api/v1/me')
        ? Response.json({ user_id: 'u1' })
        : Response.json({ type: 'x', title: 'Not found', status: 404, code: 'NOT_FOUND' }, { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const api = createApiClient({ baseUrl: 'http://api.test', getAccessToken: () => 'tok', getLanguage: () => 'bn', fetch });

    const me = await api.GET('/api/v1/me');
    expect(me.response.status).toBe(200);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(seen[0]!.headers.get('accept-language')).toBe('bn');
    expect(seen[0]!.credentials).toBe('include');

    const missing = await api.GET('/api/v1/cases/{id}', { params: { path: { id: '00000000-0000-0000-0000-000000000000' } } });
    expect(isProblem(missing.error)).toBe(true);
    expect(missing.error).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('sends no authorization header when signed out', async () => {
    let auth: string | null = 'unset';
    const fetch = (async (req: Request) => {
      auth = req.headers.get('authorization');
      return Response.json({ items: [] });
    }) as unknown as typeof globalThis.fetch;
    await createApiClient({ baseUrl: 'http://api.test', getAccessToken: () => null, fetch }).GET('/api/v1/statutes');
    expect(auth).toBeNull();
  });
});

describe('readSse', () => {
  it('parses events split across chunks, multi-line data, ids and comments', async () => {
    const events = await collect(readSse(stream([': keep-alive\n\nevent: sta', 'tus\nid: 1\ndata: {"a":1}\n\n', 'data: line1\ndata: line2\n\n'])));
    expect(events).toEqual([
      { event: 'status', data: '{"a":1}', id: '1' },
      { event: 'message', data: 'line1\nline2', id: '1' },
    ]);
  });

  it('handles CRLF and CR line ends, including a CRLF split between chunks', async () => {
    const events = await collect(readSse(stream(['event: a\r', '\ndata: x\r\n\r\n', 'data: y\r\r'])));
    expect(events).toEqual([
      { event: 'a', data: 'x', id: null },
      { event: 'message', data: 'y', id: null },
    ]);
  });

  it('drops an unterminated last event', async () => {
    expect(await collect(readSse(stream(['data: complete\n\n', 'data: cut off'])))).toHaveLength(1);
  });
});

describe('artifactStatusEvents', () => {
  it('yields status events and skips other event types', async () => {
    const body = stream([
      'event: status\ndata: {"artifact_id":"a1","status":"ANALYZING","error":null,"at":"t"}\n\n',
      'event: other\ndata: {}\n\n',
      'event: status\ndata: {"artifact_id":"a1","status":"READY","error":null,"at":"t"}\n\n',
    ]);
    expect((await collect(artifactStatusEvents(body))).map((e) => e.status)).toEqual(['ANALYZING', 'READY']);
  });
});
