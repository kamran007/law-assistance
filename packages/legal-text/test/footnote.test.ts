import { describe, expect, it } from 'vitest';
import { parseFootnoteAction, parseLegalDate } from '../src/index';

describe('parseFootnoteAction', () => {
  it.each([
    [
      'Substituted by section 2 of the Penal Code (Amendment) Act, 2004 (Act No. IX of 2004)',
      { action: 'SUBSTITUTED', byAct: 'Act No. IX of 2004', date: null },
    ],
    [
      'Inserted by the Penal Code (Second Amendment) Act, 1984 (Act No. XXIV of 1984), with effect from 1st July, 1984',
      { action: 'INSERTED', byAct: 'Act No. XXIV of 1984', date: '1984-07-01' },
    ],
    [
      'The words "five hundred taka" were substituted for the words "five hundred rupees" by the Ordinance No. X of 1982',
      { action: 'SUBSTITUTED', byAct: 'Ordinance No. X of 1982', date: null },
    ],
    ['Omitted by the Bangladesh Laws (Revision And Declaration) Act, 1973 (Act No. VIII of 1973), w.e.f. 26-03-1971', { action: 'OMITTED', byAct: 'Act No. VIII of 1973', date: '1971-03-26' }],
    ['Clause (b) was repealed by P.O. No. 48 of 1972', { action: 'OMITTED', byAct: 'P.O. No. 48 of 1972', date: null }],
    ['২০০৯ সনের ৫০ নং আইনের ২ ধারাবলে প্রতিস্থাপিত', { action: 'SUBSTITUTED', byAct: 'Act No. 50 of 2009', date: null }],
    ['২০০৩ সনের ৩০ নং আইনের ৩ ধারাবলে সন্নিবেশিত, যাহা ১৫ জুলাই, ২০০৩ তারিখ হইতে কার্যকর', { action: 'INSERTED', byAct: 'Act No. 30 of 2003', date: '2003-07-15' }],
    ['১৯৮২ সনের ১০ নং অধ্যাদেশ দ্বারা বিলুপ্ত', { action: 'OMITTED', byAct: 'Ordinance No. 10 of 1982', date: null }],
    ['See also the Code of Criminal Procedure', { action: 'OTHER', byAct: null, date: null }],
  ])('%s', (text, expected) => {
    const r = parseFootnoteAction(text);
    expect(r).toMatchObject(expected);
    expect(r.text).toBe(text.normalize('NFC'));
  });

  it('does not take an un-anchored date as the effective date', () => {
    expect(parseFootnoteAction('Substituted by the Act No. 5 of 2004, dated 5th March, 2004').date).toBeNull();
  });
});

describe('parseLegalDate', () => {
  it.each([
    ['[6th October, 1860]', '1860-10-06'],
    ['1st day of July 1984', '1984-07-01'],
    ['October 6, 1860', '1860-10-06'],
    ['Sept. 3, 1999', '1999-09-03'],
    ['26.03.1971', '1971-03-26'],
    ['[ ১৪ ফেব্রুয়ারি, ২০০০ ]', '2000-02-14'],
    ['১লা জানুয়ারী, ২০০৪', '2004-01-01'],
    ['31st February, 2000', null],
    ['1860', null],
    ['42-13-2000', null],
  ])('%s → %s', (input, expected) => expect(parseLegalDate(input)).toBe(expected));
});
