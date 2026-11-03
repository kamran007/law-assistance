import { describe, expect, it } from 'vitest';
import {
  hashFootnotes,
  hashSectionContent,
  normalizeForHash,
  normalizeSectionKey,
  toAsciiDigits,
  toBanglaDigits,
} from '../src/index';

const ch = (...cp: number[]) => String.fromCodePoint(...cp);
const NBSP = ch(0xa0);
const ZWNJ = ch(0x200c);
const ZWJ = ch(0x200d);
const LINE_SEP = ch(0x2028);

describe('digits', () => {
  it('converts Bangla → ASCII', () => expect(toAsciiDigits('ধারা ৪২০/৪০৬')).toBe('ধারা 420/406'));
  it('converts ASCII → Bangla', () => expect(toBanglaDigits('302/34')).toBe('৩০২/৩৪'));
  it('round-trips all digits', () => expect(toAsciiDigits(toBanglaDigits('0123456789'))).toBe('0123456789'));
});

describe('normalizeForHash', () => {
  it('collapses all whitespace kinds incl. NBSP, line separator and newlines', () => {
    expect(normalizeForHash(`  Whoever${NBSP} cheats\n\tand${LINE_SEP} is punished `)).toBe(
      'Whoever cheats and is punished',
    );
  });

  it('unifies precomposed and decomposed য়', () => {
    const precomposed = `বিষ${ch(0x09df)}`; // য় as one code point
    const decomposed = `বিষ${ch(0x09af, 0x09bc)}`; // য + nukta
    expect(precomposed).not.toBe(decomposed);
    expect(normalizeForHash(precomposed)).toBe(normalizeForHash(decomposed));
  });

  it('unifies legacy khanda-ta with ৎ', () => {
    const legacy = `হঠা${ch(0x09a4, 0x09cd)}${ZWJ}`;
    const modern = `হঠা${ch(0x09ce)}`;
    expect(normalizeForHash(legacy)).toBe(normalizeForHash(modern));
  });

  it('removes zero-width characters', () => {
    expect(normalizeForHash(`দণ্ড${ZWNJ}বিধি`)).toBe('দণ্ডবিধি');
  });

  it('unifies typographic quotes and dashes', () => {
    const input = `${ch(0x201c)}Court${ch(0x201d)} ${ch(0x2013)} ${ch(0x2018)}Session${ch(0x2019)}`;
    expect(normalizeForHash(input)).toBe(`"Court" - 'Session'`);
  });
});

describe('normalizeSectionKey', () => {
  it.each([
    ['302', '302'],
    ['৪২০', '420'],
    ['৫৬১ক', '561A'],
    ['561A', '561A'],
    ['561-a', '561A'],
    ['Sec. 302', '302'],
    ['section 497', '497'],
    ['ধারা ৪২০', '420'],
    ['s.34', '34'],
    ['৩২৬খ', '326B'],
  ])('%s → %s', (input, expected) => expect(normalizeSectionKey(input)).toBe(expected));

  it.each(['', 'abc', '302/34', '12345', 'Chapter XVII'])('rejects %j', (input) =>
    expect(normalizeSectionKey(input)).toBeNull(),
  );
});

describe('hashing', () => {
  it('is stable across insignificant whitespace changes', () => {
    expect(hashSectionContent('Cheating', 'Whoever  cheats\nshall be punished')).toBe(
      hashSectionContent('Cheating ', 'Whoever cheats shall be punished'),
    );
  });

  it('detects real text changes', () => {
    expect(hashSectionContent('Cheating', 'seven years')).not.toBe(hashSectionContent('Cheating', 'ten years'));
  });

  it('distinguishes heading from body boundary', () => {
    expect(hashSectionContent('A B', 'C')).not.toBe(hashSectionContent('A', 'B C'));
  });

  it('hashes footnotes independently', () => {
    expect(hashFootnotes(['Substituted by Act No. 1 of 2023'])).toMatch(/^[0-9a-f]{64}$/);
  });
});
