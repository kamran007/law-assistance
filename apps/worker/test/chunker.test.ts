import { describe, expect, it } from 'vitest';
import { chunkHeader, chunkId, chunkSection, estimateTokens } from '../src/index/chunker';

/** One token per whitespace-separated word: makes budgets easy to reason about in tests. */
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const w = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const base = { actTitle: 'THE PENAL CODE, 1860', sectionNumber: '420', marginalHeading: 'Cheating' };

describe('chunkSection', () => {
  it('keeps a short section in one chunk that starts with the Act/section heading', () => {
    const chunks = chunkSection({ ...base, contentBody: '420. Whoever cheats shall be punished.' });
    expect(chunks).toEqual(['THE PENAL CODE, 1860 | s. 420: Cheating\n420. Whoever cheats shall be punished.']);
  });

  it('splits on sub-section / proviso boundaries once the minimum is reached', () => {
    const body = [`54. (1) ${w(40, 'a')}`, `(2) ${w(40, 'b')}`, `Provided that ${w(40, 'c')}`].join('\n');
    const chunks = chunkSection({ ...base, contentBody: body }, { minTokens: 30, maxTokens: 100, estimateTokens: words });
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.split('\n')[1]!.slice(0, 12))).toEqual(['54. (1) a0 a', '(2) b0 b1 b2', 'Provided tha']);
    expect(chunks.every((c) => c.startsWith('THE PENAL CODE, 1860 | s. 420: Cheating\n'))).toBe(true);
  });

  it('packs small parts together below the minimum instead of making tiny chunks', () => {
    const body = ['1. Intro.', '(1) a b c', '(2) d e f', '(3) g h i'].join('\n');
    expect(chunkSection({ ...base, contentBody: body }, { minTokens: 50, maxTokens: 100, estimateTokens: words })).toHaveLength(1);
  });

  it('never exceeds the max: overflow forces a split, long paragraphs split at sentences then words', () => {
    const longSentence = `${w(150, 'x')}.`;
    const body = [`1. ${w(60, 'p')}`, `${w(60, 'q')}`, `${longSentence} ${w(30, 'y')}.`].join('\n');
    const opts = { minTokens: 40, maxTokens: 80, estimateTokens: words };
    const chunks = chunkSection({ ...base, contentBody: body }, opts);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(words(c)).toBeLessThanOrEqual(80);
    // No text lost or duplicated.
    const bodyOut = chunks.map((c) => c.split('\n').slice(1).join(' ')).join(' ');
    expect(bodyOut.split(/\s+/).sort()).toEqual(body.split(/\s+/).sort());
  });

  it('is deterministic', () => {
    const input = { ...base, contentBody: [`1. ${w(300)}`, `(2) ${w(300)}`].join('\n') };
    expect(chunkSection(input)).toEqual(chunkSection(input));
  });

  it('gives a heading-only chunk to an empty section (e.g. "[Omitted]")', () => {
    expect(chunkSection({ ...base, marginalHeading: null, contentBody: '' })).toEqual(['THE PENAL CODE, 1860 | s. 420']);
  });

  it('builds headers without missing parts', () => {
    expect(chunkHeader({ actTitle: null, sectionNumber: '11A', marginalHeading: null })).toBe('s. 11A');
  });
});

describe('estimateTokens', () => {
  it('counts Bangla words heavier than English words, and numbers/punctuation as tokens', () => {
    expect(estimateTokens('whoever cheats')).toBe(3); // 2 × 1.3 → 3
    expect(estimateTokens('যদি কোন পুরুষ')).toBe(7); // 3 × 2.2 → 7
    expect(estimateTokens('420.')).toBe(2);
  });
});

describe('chunkId', () => {
  const section = '01a1a16c-acbe-70af-bef9-f3586265587f';

  it('is a stable, valid UUID (v8, RFC 9562 variant) per (section, index)', () => {
    const id = chunkId(section, 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chunkId(section, 0)).toBe(id);
  });

  it('differs across indexes and sections', () => {
    const ids = new Set([chunkId(section, 0), chunkId(section, 1), chunkId('01a1a16c-acbe-70af-bef9-f3586265587e', 0)]);
    expect(ids.size).toBe(3);
  });
});
