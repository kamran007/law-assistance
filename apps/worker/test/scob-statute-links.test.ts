import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMixedUtf8 } from '../src/scob/decode';
import { parseDivisionList } from '../src/scob/list-parser';
import { findStatuteRefs, normalizeActName } from '../src/scob/statute-links';
import { cleanPages, markParagraphs } from '../src/scob/text';

/** JUD-05: which Act a cited section belongs to, from SCOB key words (real list rows) and bodies. */
const brief = (keyWords: string, body: string | null = null) =>
  findStatuteRefs(keyWords, body).map((r) => [r.act?.key ?? r.actName, r.sectionKey, r.foundIn, r.paragraphs.join(',')].join(' | '));

const rows = (file: string, issue: number, division: 'AD' | 'HCD') =>
  parseDivisionList(decodeMixedUtf8(readFileSync(new URL(`./fixtures/scob/${file}`, import.meta.url))), { issue, division });

describe('findStatuteRefs: key words', () => {
  it('several Acts in one entry list: each section goes to the Act written next to it, not the nearest', () => {
    const kw = rows('list_AD_20.html', 20, 'AD').find((r) => r.serial === 1)!.keyWords;
    expect(brief(kw)).toEqual([
      'PENAL_CODE | 109 | KEY_WORDS | ',
      'PENAL_CODE | 405 | KEY_WORDS | ',
      'PENAL_CODE | 409 | KEY_WORDS | ',
      // "…Penal Code,1860; Section 5(1),(2) of the Prevention of Corruption Act" — not the Penal Code
      'Prevention of Corruption Act, 1947 | 5 | KEY_WORDS | ',
      'Criminal Law Amendment Act,1958 | 5 | KEY_WORDS | ',
      'Criminal Law Amendment Act,1958 | 10 | KEY_WORDS | ',
      'MONEY_LAUNDERING_2012 | 22 | KEY_WORDS | ',
    ]);
  });

  it('older one-per-line lists: an Act line applies to the section line under it', () => {
    const kw = rows('list_HD_5.html', 5, 'HCD').find((r) => r.serial === 12)!.keyWords; // Penal Code / 201, 302/34 / CrPC / 236 and 237
    expect(brief(kw)).toEqual(['PENAL_CODE | 201 | KEY_WORDS | ', 'PENAL_CODE | 302 | KEY_WORDS | ', 'PENAL_CODE | 34 | KEY_WORDS | ', 'CRPC | 236 | KEY_WORDS | ', 'CRPC | 237 | KEY_WORDS | ']);
    expect(brief('Evidence Act, 1872\nSection 57\nJudicial notice')).toEqual(['EVIDENCE | 57 | KEY_WORDS | ']);
  });

  it('Acts outside the dictionary keep the name as written (brackets, line breaks, "Ain")', () => {
    expect(brief('The Abandoned Buildings (Supplementary Provisions) Ordinance, 1985\nSection 5(1)(b)')).toEqual(['Abandoned Buildings (Supplementary Provisions) Ordinance, 1985 | 5 | KEY_WORDS | ']);
    expect(brief('Section 5(1), (2) of the Prevention of\nCorruption Act, 1947;')).toEqual(['Prevention of Corruption Act, 1947 | 5 | KEY_WORDS | ']);
    expect(brief('Artha Rin Adalat Ain 2003\nSection 6')).toEqual(['Artha Rin Adalat Ain 2003 | 6 | KEY_WORDS | ']);
    expect(brief('Section 21A, Specific Relief Act, 1877;')).toEqual(['Specific Relief Act, 1877 | 21A | KEY_WORDS | ']);
  });

  it('abbreviations and Bangla resolve through the dictionary', () => {
    expect(brief('Section 342 and 537 of CrPC; Section 138, N.I. Act')).toEqual(['CRPC | 342 | KEY_WORDS | ', 'CRPC | 537 | KEY_WORDS | ', 'NI_ACT | 138 | KEY_WORDS | ']);
    expect(brief('আসামী দণ্ডবিধির ৩০২/৩৪ ধারায় দোষী')).toEqual(['PENAL_CODE | 302 | KEY_WORDS | ', 'PENAL_CODE | 34 | KEY_WORDS | ']);
  });

  it('a section with no Act next to it is kept without one; "Order 20, Rule 18" is not an Act name', () => {
    expect(brief('Partition Suit, Ubi Jus ibi remedium, Section 54, Order 20, Rule 18;')).toEqual([' | 54 | KEY_WORDS | ']);
    expect(brief('Rape\nDelay in lodging FIR')).toEqual([]);
  });
});

describe('findStatuteRefs: body', () => {
  it('records the [para n] of every citation and merges repeats', () => {
    const body = markParagraphs(
      ['1. The accused was convicted under section 302 of the Penal Code.', 'The appeal followed.', '2. Nothing turns on it.', '3. Section 302 of the Penal Code and section 342 of the Code of Criminal Procedure apply.'].join('\n'),
    ).text;
    expect(brief('', body)).toEqual(['PENAL_CODE | 302 | BODY | 1,3', 'CRPC | 342 | BODY | 3']);
  });

  it('a real header: names wrapped over lines and key words inside the PDF', () => {
    const text = markParagraphs(cleanPages([readFileSync(new URL('./fixtures/scob/header_hd14_1.txt', import.meta.url), 'utf8')])).text;
    const refs = findStatuteRefs('The Bangladesh Telecommunication Regulation Act Section 63 and 65;', text);
    expect(refs.filter((r) => r.foundIn === 'KEY_WORDS').map((r) => [r.actName, r.sectionKey])).toEqual([
      ['Bangladesh Telecommunication Regulation Act', '63'],
      ['Bangladesh Telecommunication Regulation Act', '65'],
    ]);
    expect(refs).toContainEqual(expect.objectContaining({ actName: 'Bangladesh Telecommunication Regulation Act 2001', sectionKey: '65', foundIn: 'BODY', raw: 'under section 65(5) of the Bangladesh Telecommunication Regulation Act 2001' }));
  });
});

describe('normalizeActName', () => {
  it('compares titles without "The", case and punctuation', () => {
    expect(normalizeActName('The Bangladesh Telecommunication Regulation Act, 2001')).toBe(normalizeActName('Bangladesh Telecommunication Regulation Act 2001'));
  });
});
