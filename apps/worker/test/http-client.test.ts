import { describe, expect, it } from 'vitest';
import { decodeBody, HttpError, MemoryConditionalCache, PoliteHttpClient, RobotsDisallowedError, type FetchLike } from '../src/scrape/http-client';
import { IntervalLimiter } from '../src/scrape/rate-limiter';
import { MemorySnapshotStore, snapshotKey } from '../src/scrape/snapshot-store';
import { DEFAULT_SOURCE_CONFIG, loadSourceConfig } from '../src/scrape/source-config';

type Reply = { status: number; body?: string | Uint8Array; headers?: Record<string, string> } | Error;

const bytesOf = (body: string | Uint8Array | undefined): ArrayBuffer => {
  const u8 = typeof body === 'string' || body === undefined ? new TextEncoder().encode(body ?? '') : body;
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};

/** Fake fetch: per-URL reply queues; records every call. */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const queue = routes[url] ?? [];
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (!reply) return { status: 404, headers: new Headers(), arrayBuffer: async () => bytesOf('') };
    if (reply instanceof Error) throw reply;
    return { status: reply.status, headers: new Headers(reply.headers ?? {}), arrayBuffer: async () => bytesOf(reply.body) };
  };
  return { fetch, calls };
}

/** "<p>আইন</p>" as UTF-16 big-endian bytes, optionally with a BOM: how bdlaws serves index pages. */
function utf16be(text: string, bom: boolean): Uint8Array {
  const out = new Uint8Array((bom ? 2 : 0) + text.length * 2);
  let o = 0;
  if (bom) {
    out[o++] = 0xfe;
    out[o++] = 0xff;
  }
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    out[o++] = c >> 8;
    out[o++] = c & 0xff;
  }
  return out;
}

const BASE = DEFAULT_SOURCE_CONFIG.baseUrl;
const ROBOTS = `${BASE}/robots.txt`;
const PAGE = `${BASE}/act-print-11.html`;

function client(routes: Record<string, Reply[]>, overrides: Partial<typeof DEFAULT_SOURCE_CONFIG> = {}) {
  const { fetch, calls } = fakeFetch(routes);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const http = new PoliteHttpClient({
    config: { ...DEFAULT_SOURCE_CONFIG, ...overrides },
    fetch,
    sleep,
    random: () => 0.5,
    limiter: new IntervalLimiter(1000, () => 0, async () => undefined),
  });
  return { http, calls, sleeps };
}

describe('PoliteHttpClient', () => {
  it('sends the product User-Agent and returns the body', async () => {
    const { http, calls } = client({ [ROBOTS]: [{ status: 200, body: 'User-agent: *\nAllow: /' }], [PAGE]: [{ status: 200, body: '<html>ok</html>' }] });
    const res = await http.get(PAGE);
    expect(res).toMatchObject({ kind: 'ok', body: '<html>ok</html>' });
    expect(calls.map((c) => c.url)).toEqual([ROBOTS, PAGE]);
    expect(calls[1]!.headers['user-agent']).toBe(DEFAULT_SOURCE_CONFIG.userAgent);
  });

  it('decodes UTF-16 pages by BOM or charset, not as UTF-8 (bdlaws index and detail pages)', async () => {
    const page = '<a href="/act-835.html">নারী ও শিশু নির্যাতন দমন আইন, ২০০০</a>';
    const { http } = client({
      [ROBOTS]: [{ status: 404 }],
      [PAGE]: [{ status: 200, body: utf16be(page, true), headers: { 'content-type': 'text/html;charset=UTF-16' } }],
    });
    expect(await http.get(PAGE)).toMatchObject({ kind: 'ok', body: page });

    expect(decodeBody(utf16be(page, false), 'text/html; charset=UTF-16')).toBe(page);
    expect(decodeBody(new TextEncoder().encode(page), 'text/html;charset=UTF-8')).toBe(page);
    expect(decodeBody(new TextEncoder().encode(page), null)).toBe(page);
    expect(decodeBody(new TextEncoder().encode('ok'), 'text/html; charset=x-unknown')).toBe('ok');
  });

  it('honours robots.txt disallow rules', async () => {
    const { http, calls } = client({ [ROBOTS]: [{ status: 200, body: 'User-agent: *\nDisallow: /act-print-' }] });
    await expect(http.get(PAGE)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(calls.map((c) => c.url)).toEqual([ROBOTS]);
  });

  it('treats a missing robots.txt as allow-all and fetches it only once', async () => {
    const { http, calls } = client({ [ROBOTS]: [{ status: 404 }], [PAGE]: [{ status: 200, body: 'x' }] });
    await http.get(PAGE);
    await http.get(PAGE);
    expect(calls.filter((c) => c.url === ROBOTS)).toHaveLength(1);
  });

  it('refuses to crawl when robots.txt is unreachable, and retries robots on the next call', async () => {
    const { http, calls } = client({ [ROBOTS]: [new TypeError('fetch failed')] }, { maxRetries: 1 });
    await expect(http.get(PAGE)).rejects.toThrow('fetch failed');
    await expect(http.get(PAGE)).rejects.toThrow('fetch failed');
    expect(calls.filter((c) => c.url === PAGE)).toHaveLength(0);
    expect(calls.filter((c) => c.url === ROBOTS)).toHaveLength(4);
  });

  it('uses conditional GET with stored validators and reports 304 as not-modified', async () => {
    const { http, calls } = client({
      [ROBOTS]: [{ status: 404 }],
      [PAGE]: [{ status: 200, body: 'v1', headers: { etag: '"abc"', 'last-modified': 'Tue, 03 Nov 2026 00:00:00 GMT' } }, { status: 304 }],
    });
    expect((await http.get(PAGE)).kind).toBe('ok');
    expect((await http.get(PAGE)).kind).toBe('not-modified');
    expect(calls[2]!.headers).toMatchObject({ 'if-none-match': '"abc"', 'if-modified-since': 'Tue, 03 Nov 2026 00:00:00 GMT' });
  });

  it('skips validators when conditional is false (weekly full crawl)', async () => {
    const cache = new MemoryConditionalCache();
    await cache.set(PAGE, { etag: '"abc"' });
    const { fetch, calls } = fakeFetch({ [ROBOTS]: [{ status: 404 }], [PAGE]: [{ status: 200, body: 'x' }] });
    const http = new PoliteHttpClient({ config: DEFAULT_SOURCE_CONFIG, fetch, cache, limiter: new IntervalLimiter(1000, () => 0, async () => undefined) });
    await http.get(PAGE, { conditional: false });
    expect(calls[1]!.headers['if-none-match']).toBeUndefined();
  });

  it('retries 5xx and network errors with exponential backoff, then succeeds', async () => {
    const { http, sleeps } = client({
      [ROBOTS]: [{ status: 404 }],
      [PAGE]: [{ status: 503 }, new TypeError('fetch failed'), { status: 502 }, { status: 200, body: 'ok' }],
    });
    expect(await http.get(PAGE)).toMatchObject({ kind: 'ok', body: 'ok' });
    // base 2s, 4s, 8s with "equal jitter" at random()=0.5 → 75% of base.
    expect(sleeps).toEqual([1500, 3000, 6000]);
  });

  it('respects Retry-After on 429', async () => {
    const { http, sleeps } = client({ [ROBOTS]: [{ status: 404 }], [PAGE]: [{ status: 429, headers: { 'retry-after': '7' } }, { status: 200 }] });
    await http.get(PAGE);
    expect(sleeps).toEqual([7000]);
  });

  it('does not retry client errors and gives up after maxRetries', async () => {
    const a = client({ [ROBOTS]: [{ status: 404 }], [PAGE]: [{ status: 404 }] });
    await expect(a.http.get(PAGE)).rejects.toMatchObject({ name: 'HttpError', status: 404 });
    expect(a.sleeps).toEqual([]);

    const b = client({ [ROBOTS]: [{ status: 404 }], [PAGE]: [{ status: 500 }] }, { maxRetries: 2 });
    await expect(b.http.get(PAGE)).rejects.toBeInstanceOf(HttpError);
    expect(b.sleeps).toHaveLength(2);
  });
});

describe('IntervalLimiter', () => {
  it('spaces acquisitions by at least the interval, in FIFO order', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new IntervalLimiter(
      1000,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => limiter.acquire().then(() => order.push(i))));
    expect(order).toEqual([1, 2, 3]);
    expect(waits).toEqual([1000, 1000]);
    now += 5000; // idle time: next request goes immediately
    await limiter.acquire();
    expect(waits).toHaveLength(2);
  });
});

describe('snapshots and source config', () => {
  it('builds the TRD key layout and round-trips gzip content', async () => {
    const at = new Date('2026-11-03T20:00:01.234Z');
    expect(snapshotKey(11, at)).toBe('raw/bdlaws/11/2026-11-03T20-00-01.234Z.html.gz');
    const store = new MemorySnapshotStore();
    const key = await store.put(11, at, '<p>৪২০</p>');
    expect(await store.get(key)).toBe('<p>৪২০</p>');
    expect(store.objects.get(key)!.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it('uses defaults without an override file and rejects too-fast crawl intervals', () => {
    expect(loadSourceConfig(undefined)).toBe(DEFAULT_SOURCE_CONFIG);
    expect(() => loadSourceConfig('does-not-exist.json')).toThrow();
  });
});
