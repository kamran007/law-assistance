import { describe, expect, it } from 'vitest';
import { EmbeddingError, OPEN_ENDED_VALID_TO, TeiEmbeddingProvider, buildFilter, toPayloadDate, type EmbedFetch } from '../src/index';

const vec = (dim: number, x = 0.1) => Array.from({ length: dim }, () => x);

function tei(replies: Array<{ status: number; body?: unknown } | Error>, dims = 4) {
  const calls: { url: string; inputs: string[] }[] = [];
  const fetch: EmbedFetch = async (url, init) => {
    const { inputs } = JSON.parse(init.body) as { inputs: string[] };
    calls.push({ url, inputs });
    const r = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.body ?? inputs.map(() => vec(dims)) };
  };
  const sleeps: number[] = [];
  const provider = new TeiEmbeddingProvider({
    url: 'http://tei:80',
    model: 'BAAI/bge-m3',
    dimensions: dims,
    batchSize: 3,
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { provider, calls, sleeps };
}

describe('TeiEmbeddingProvider', () => {
  it('posts to /embed in batches and keeps input order', async () => {
    const { provider, calls } = tei([{ status: 200 }]);
    const out = await provider.embed(['a', 'b', 'c', 'd', 'e']);
    expect(out).toHaveLength(5);
    expect(calls.map((c) => c.inputs)).toEqual([['a', 'b', 'c'], ['d', 'e']]);
    expect(calls[0]!.url).toBe('http://tei/embed');
  });

  it('retries 5xx, 429 and network errors with backoff', async () => {
    const { provider, sleeps } = tei([{ status: 503 }, new TypeError('fetch failed'), { status: 429 }, { status: 200 }]);
    expect(await provider.embed(['a'])).toHaveLength(1);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('does not retry a 4xx and never puts input text in the error', async () => {
    const { provider, calls } = tei([{ status: 413 }]);
    const err = await provider.embed(['SECRET SECTION TEXT']).then(
      () => new Error('expected a rejection'),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.message).toBe('TEI /embed returned HTTP 413');
    expect(err.message).not.toContain('SECRET');
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const { provider, calls } = tei([new TypeError('fetch failed')]);
    await expect(provider.embed(['a'])).rejects.toThrow('TEI /embed failed after 4 attempts: TypeError');
    expect(calls).toHaveLength(4);
  });

  it('rejects wrong vector counts or dimensions', async () => {
    await expect(tei([{ status: 200, body: [vec(4)] }]).provider.embed(['a', 'b'])).rejects.toThrow('1 vectors for 2 inputs');
    await expect(tei([{ status: 200, body: [vec(3)] }]).provider.embed(['a'])).rejects.toThrow('not 4-dim');
    await expect(tei([{ status: 200, body: [[0, Number.NaN, 0, 0]] }]).provider.embed(['a'])).rejects.toThrow('not 4-dim');
  });
});

describe('Qdrant filters (TRD §4.4 point-in-time)', () => {
  it('maps MySQL dates to RFC 3339 with an open-ended sentinel', () => {
    expect(toPayloadDate('2025-03-01')).toBe('2025-03-01T00:00:00Z');
    expect(toPayloadDate(null)).toBe(OPEN_ENDED_VALID_TO);
  });

  it('current law: is_current and ACTIVE Acts only', () => {
    expect(buildFilter({ temporal: { kind: 'current' } })).toEqual({
      must: [
        { key: 'is_current', match: { value: true } },
        { key: 'act_status', match: { value: 'ACTIVE' } },
      ],
    });
  });

  it('as-of date: valid_from <= date < valid_to, optional repealed Acts and statute scope', () => {
    expect(buildFilter({ temporal: { kind: 'asOf', date: '2020-01-01' }, includeRepealed: true, statuteIds: ['s1'] })).toEqual({
      must: [
        { key: 'valid_from', range: { lte: '2020-01-01T00:00:00Z' } },
        { key: 'valid_to', range: { gt: '2020-01-01T00:00:00Z' } },
        { key: 'statute_id', match: { any: ['s1'] } },
      ],
    });
  });
});
