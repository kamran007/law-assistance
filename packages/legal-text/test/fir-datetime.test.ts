import { describe, expect, it } from 'vitest';
import { dhakaToUtc, filingDelay, parseFirDateTime as parse, type FirDateTimeFlag } from '../src/fir-datetime';

/** [raw, date, time (Dhaka), flags, approximate] */
const CASES: [string, string, string | null, FirDateTimeFlag[], boolean][] = [
  // Bangla FIR forms
  ['১২/০৩/২০২৪ খ্রিঃ রাত অনুমান ০৯.৩০ ঘটিকা', '2024-03-12', '21:30', [], true],
  ['তারিখ: ১২-০৩-২০২৪ ইং, সময়: রাত্রি ১১.৪৫ ঘটিকা', '2024-03-12', '23:45', [], false],
  ['১২.০৩.২০২৪ ইং তারিখ সন্ধ্যা ৭টার সময়', '2024-03-12', '19:00', [], false],
  ['১২/০৩/২০২৪ বিকাল অনুমান ৪.১৫ ঘটিকা', '2024-03-12', '16:15', [], true],
  ['১২/০৩/২০২৪ বিকেল ৩টায়', '2024-03-12', '15:00', [], false],
  ['১২/০৩/২০২৪ দুপুর ১টা', '2024-03-12', '13:00', [], false],
  ['১২/০৩/২০২৪ দুপুর ১২.৩০ ঘটিকা', '2024-03-12', '12:30', [], false],
  ['১২/০৩/২০২৪ সকাল ১০.০০ ঘটিকা', '2024-03-12', '10:00', [], false],
  ['১২/০৩/২০২৪ ভোর ৫.৩০ ঘটিকা', '2024-03-12', '05:30', [], false],
  ['১৫ জানুয়ারী, ২০২৩ সকাল ১১টার সময়', '2023-01-15', '11:00', [], false],
  ['১লা বৈশাখ ১৪৩১ বঙ্গাব্দ মোতাবেক ১৪ এপ্রিল ২০২৪ খ্রিঃ সকাল ৯টা', '2024-04-14', '09:00', ['BANGLA_CALENDAR_IGNORED'], false],
  ['২৯ ফাল্গুন ১৪৩০ বঙ্গাব্দ মোতাবেক ১২ মার্চ ২০২৪ খ্রিস্টাব্দ', '2024-03-12', null, ['BANGLA_CALENDAR_IGNORED'], false],
  ['গত ১৪/০২/২০২৪ তারিখ', '2024-02-14', null, [], false],
  ['১৪-০২-২০২৪ ইং আনুমানিক ২২:১০', '2024-02-14', '22:10', [], true],
  // Night after midnight: kept on the written date, flagged
  ['তারিখ: ১২-০৩-২০২৪ ইং, সময়: রাত্রি ০২.১৫ ঘটিকা', '2024-03-12', '02:15', ['NIGHT_AFTER_MIDNIGHT'], false],
  ['১২/০৩/২০২৪ রাত ১২.৩০ ঘটিকা', '2024-03-12', '00:30', ['NIGHT_AFTER_MIDNIGHT'], false],
  // English forms
  ['12.03.2024 at about 9.30 p.m.', '2024-03-12', '21:30', [], true],
  ['12/03/2024 at 2130 hrs', '2024-03-12', '21:30', [], false],
  ['March 12, 2024 at 10 am', '2024-03-12', '10:00', [], false],
  ['12th March, 2024 at 6.45 PM', '2024-03-12', '18:45', [], false],
  ['on 12 Mar 2024 around 23:05', '2024-03-12', '23:05', [], true],
  ['12-03-2024 in the evening at 8 o’clock', '2024-03-12', '20:00', [], false],
  // Ambiguities flagged, not hidden
  ['12/03/2024 9.30', '2024-03-12', '09:30', ['AMBIGUOUS_MERIDIEM'], false],
  ['05/08/24 সকাল ৯টা', '2024-08-05', '09:00', ['TWO_DIGIT_YEAR'], false],
];

describe('parseFirDateTime', () => {
  it.each(CASES)('%s', (raw, date, time, flags, approximate) => {
    const r = parse(raw)!;
    expect(r).not.toBeNull();
    expect({ date: r.date, time: r.time, flags: r.flags, approximate: r.approximate }).toEqual({ date, time, flags, approximate });
  });

  it('gives the UTC instant in Dhaka time (UTC+6)', () => {
    expect(parse('১২/০৩/২০২৪ রাত ৯.৩০ ঘটিকা')!.instant).toBe('2024-03-12T15:30:00.000Z');
    expect(parse('০১/০১/২০২৪ রাত ২টা')!.instant).toBe('2023-12-31T20:00:00.000Z');
  });

  it('knows the 2009 daylight-saving period (UTC+7, 19 June – 31 December 2009)', () => {
    expect(parse('০১/০৭/২০০৯ বিকাল ৫.০০ ঘটিকা')!.instant).toBe('2009-07-01T10:00:00.000Z');
    expect(parse('০১/০৬/২০০৯ বিকাল ৫.০০ ঘটিকা')!.instant).toBe('2009-06-01T11:00:00.000Z');
    expect(dhakaToUtc(2010, 1, 15, 12, 0).toISOString()).toBe('2010-01-15T06:00:00.000Z');
  });

  it('never reads the date itself as a time', () => {
    expect(parse('12.03.2024')).toMatchObject({ date: '2024-03-12', time: null, instant: null });
  });

  it('returns null without a valid date', () => {
    expect(parse(null)).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse('রাত ৯টা')).toBeNull();
    expect(parse('31/02/2024 10:00')).toBeNull();
    expect(parse('৩০২/৩৪ ধারা')).toBeNull();
  });
});

describe('filingDelay', () => {
  it('counts minutes when both times are known', () => {
    expect(filingDelay(parse('১২/০৩/২০২৪ রাত ০৯.৩০ ঘটিকা'), parse('১৪/০৩/২০২৪ সকাল ১০.০০ ঘটিকা'))).toEqual({
      minutes: 2190,
      days: 2,
      basis: 'DATETIME',
      warning: null,
    });
  });

  it('falls back to calendar days when a time is missing', () => {
    expect(filingDelay(parse('গত ১০/০৩/২০২৪ তারিখ'), parse('১৪/০৩/২০২৪ সকাল ১০টা'))).toEqual({ minutes: null, days: 4, basis: 'DATE', warning: null });
  });

  it('crosses the 2009 daylight-saving change correctly', () => {
    // 31 Dec 2009 22:00 (UTC+7) → 1 Jan 2010 01:00 (UTC+6): 3 hours of wall clock, 4 hours real.
    // (23:00–23:59 that night happened twice when the clocks went back; 22:00 is unambiguous.)
    const d = filingDelay(parse('31/12/2009 22:00'), parse('01/01/2010 01:00'));
    expect(d.minutes).toBe(240);
  });

  it('refuses a report dated before the occurrence', () => {
    expect(filingDelay(parse('14/03/2024 10:00'), parse('12/03/2024 10:00')).warning).toBe('REPORTED_BEFORE_OCCURRENCE');
    expect(filingDelay(parse('14/03/2024'), parse('12/03/2024'))).toMatchObject({ days: null, warning: 'REPORTED_BEFORE_OCCURRENCE' });
  });

  it('is UNKNOWN when either date is missing', () => {
    expect(filingDelay(null, parse('12/03/2024'))).toEqual({ minutes: null, days: null, basis: 'UNKNOWN', warning: null });
  });
});
