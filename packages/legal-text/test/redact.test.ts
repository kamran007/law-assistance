import { describe, expect, it } from 'vitest';
import { NID_PLACEHOLDER as N, PHONE_PLACEHOLDER as P, redactContactIds } from '../src/redact';

describe('redactContactIds (TRD §7.6 data minimization)', () => {
  it.each([
    ['মোবাইল: ০১৭১১-১২৩৪৫৬', `মোবাইল: ${P}`],
    ['মোবাইল নং ০১৯১২৩৪৫৬৭৮', `মোবাইল নং ${P}`],
    ['phone 01711123456.', `phone ${P}.`],
    ['Cell: +880 1711 123456', `Cell: ${P}`],
    ['+8801811223344', P],
    ['8801511223344', P],
    ['০০৮৮০১৬১১২২৩৩৪৪', P],
    ['জাতীয় পরিচয়পত্র নং ১৯৯০২৬৯২৬১৫০০০০১২', `জাতীয় পরিচয়পত্র নং ${N}`],
    ['NID 2695012345678', `NID ${N}`],
    ['NID: 4612345678', `NID: ${N}`],
  ])('%s', (input, expected) => {
    expect(redactContactIds(input).text).toBe(expected);
  });

  it('counts what it replaced', () => {
    expect(redactContactIds('০১৭১১১২৩৪৫৬ ও 01811223344, NID 4612345678')).toMatchObject({ phones: 2, nids: 1 });
  });

  it.each([
    'দণ্ডবিধির ৩২৩/৩২৫/৩৪ ধারা',
    'ঘটনার তারিখ ১২/০৩/২০২৪ খ্রিঃ রাত ০৯.৩০ ঘটিকা',
    'জি.আর নং: ৩২১/২০২৪, মামলা নং ১৭',
    'স্মারক নং ১৭.০০.০০০০.০২৫.৪৪.০১৩.১৫',
    'টাকা ১,২৫,০০০/-',
    'ref 1234567890/2024', // a numbered reference with a slash is not an NID
    '02-9123456', // landline: not a mobile pattern, and not personal enough to need it
    '012345678901', // 12 digits: neither a mobile nor an NID length
  ])('leaves legal references, dates and amounts alone: %s', (input) => {
    expect(redactContactIds(input).text).toBe(input);
  });
});
