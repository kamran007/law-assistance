import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/index/chunker';
import { chunkJudgment, judgmentChunkHeader, judgmentChunkId } from '../src/index/judgment-chunker';
import { cleanPages, markParagraphs } from '../src/scob/text';

/** JUD-06 chunker (TRD §6A.4): paragraph boundaries, header per chunk, key ratio on its own. */
const meta = { parties: 'Grameenphone Limited Vs. BTRC & ors', citation: '14 SCOB [2020] HCD', division: 'HCD' as const };
const para = (n: number, words: number) => `[para ${n}] ${Array.from({ length: words }, (_, i) => `word${n}x${i}`).join(' ')}.`;

describe('chunkJudgment', () => {
  it('a real judgment: preamble chunks first, then chunks of whole paragraphs within the token budget', () => {
    const fullText = markParagraphs(cleanPages([readFileSync(new URL('./fixtures/scob/header_hd14_1.txt', import.meta.url), 'utf8')])).text;
    const all = chunkJudgment({ ...meta, fullText, keyRatioParagraphs: [] });
    // The header page (case no., parties, counsel, dates) comes before paragraph 1, never mixed with it.
    const first = all.findIndex((c) => c.paragraphFrom !== null);
    expect(first).toBeGreaterThan(0);
    expect(all.slice(0, first).every((c) => c.paragraphTo === null && c.text.startsWith('Grameenphone Limited Vs. BTRC & ors, 14 SCOB [2020] HCD (HCD)\n'))).toBe(true);
    const chunks = [null, ...all.slice(first)];
    expect(chunks[1]!.paragraphFrom).toBe(1);
    expect(chunks.at(-1)!.paragraphTo).toBe(23);
    expect(all.every((c) => estimateTokens(c.text) <= 500)).toBe(true);
    for (const c of all.slice(first)) {
      expect(c.text.split('\n')[0]).toBe(judgmentChunkHeader(meta, c.paragraphFrom, c.paragraphTo));
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(500);
    }
    // Consecutive, no paragraph lost, none split across chunks (all of them are short).
    const ranges = all.slice(first).map((c) => [c.paragraphFrom!, c.paragraphTo!] as const);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1);
    // Paragraph text is unwrapped onto one line.
    expect(all.some((c) => c.text.includes('[para 2] The Petitioner is a company'))).toBe(true);
  });

  it('key-ratio paragraphs start and end their own chunk', () => {
    const fullText = [1, 2, 3, 4, 5].map((n) => para(n, 40)).join('\n');
    const chunks = chunkJudgment({ ...meta, fullText, keyRatioParagraphs: ['3'] });
    expect(chunks.map((c) => [c.paragraphFrom, c.paragraphTo])).toEqual([
      [1, 2],
      [3, 3],
      [4, 5],
    ]);
    expect(chunks[1]!.text.split('\n')[0]).toBe('Grameenphone Limited Vs. BTRC & ors, 14 SCOB [2020] HCD (HCD) — para 3');
  });

  it('splits a paragraph longer than the budget, keeping its number on every piece', () => {
    const chunks = chunkJudgment({ ...meta, fullText: para(7, 900), keyRatioParagraphs: [] });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.paragraphFrom === 7 && c.paragraphTo === 7)).toBe(true);
    expect(chunks.every((c) => estimateTokens(c.text) <= 500)).toBe(true);
  });

  it('is deterministic: same input, same chunks and ids', () => {
    const input = { ...meta, fullText: [1, 2, 3].map((n) => para(n, 200)).join('\n'), keyRatioParagraphs: [] };
    expect(chunkJudgment(input)).toEqual(chunkJudgment(input));
    expect(judgmentChunkId('j1', 0)).toBe(judgmentChunkId('j1', 0));
    expect(judgmentChunkId('j1', 0)).not.toBe(judgmentChunkId('j1', 1));
    expect(judgmentChunkId('j1', 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
