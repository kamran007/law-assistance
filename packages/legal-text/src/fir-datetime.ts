import { toAsciiDigits } from './digits';

/**
 * FIR date-time parsing and filing delay (TRD §8.2 stage 4, BE-24). Input is the raw string the
 * extraction step copied from the FIR ("১২/০৩/২০২৪ খ্রিঃ রাত অনুমান ০৯.৩০ ঘটিকা",
 * "12.03.2024 at about 9.30 p.m."). Times are Bangladesh local time (Asia/Dhaka; UTC+6, and UTC+7
 * during the 2009 daylight-saving period, which Node's ICU time-zone data knows).
 *
 * The parser reads only what is written. When the text leaves something open it says so in
 * `flags` instead of guessing silently: a lawyer reads the delay off this, so a quiet wrong answer
 * is worse than a flagged one.
 */
export type FirDateTimeFlag =
  /** "৯.৩০ ঘটিকা" with no সকাল/রাত/a.m./p.m.: read as written (09:30). */
  | 'AMBIGUOUS_MERIDIEM'
  /** "রাত ১২.৩০" / "রাত ২টা": kept on the written date, though the writer may mean the night after it. */
  | 'NIGHT_AFTER_MIDNIGHT'
  /** "১২/০৩/২৪": century assumed (20xx). */
  | 'TWO_DIGIT_YEAR'
  /** A Bangla-calendar date (বঙ্গাব্দ) was present but not used; the Gregorian date was. */
  | 'BANGLA_CALENDAR_IGNORED';

export interface FirDateTime {
  /** Local date in Dhaka, YYYY-MM-DD. */
  date: string;
  /** Local time in Dhaka, HH:mm, or null when the text gives no time. */
  time: string | null;
  /** UTC instant (ISO 8601), only when the time is known. */
  instant: string | null;
  /** "অনুমান", "আনুমানিক", "about", "approx." … */
  approximate: boolean;
  flags: FirDateTimeFlag[];
}

const n = (s: string) => s.normalize('NFC');
const alt = (words: string[]) => words.map(n).join('|');

const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const BN_MONTHS: Record<string, number> = Object.fromEntries(
  [
    ['জানুয়ারি', 1], ['জানুয়ারী', 1], ['ফেব্রুয়ারি', 2], ['ফেব্রুয়ারী', 2], ['মার্চ', 3], ['এপ্রিল', 4], ['মে', 5],
    ['জুন', 6], ['জুলাই', 7], ['আগস্ট', 8], ['আগষ্ট', 8], ['সেপ্টেম্বর', 9], ['অক্টোবর', 10], ['নভেম্বর', 11], ['ডিসেম্বর', 12],
  ].map(([k, v]) => [n(k as string), v as number]),
);

// Dates. All run on ASCII-digit text; the first valid match by position wins.
const NUMERIC_DATE = /(?<!\d)(\d{1,2})\s?[-./]\s?(\d{1,2})\s?[-./]\s?(\d{4}|\d{2})(?!\d)/gu;
const EN_DMY = /(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?([A-Za-z]{3,})\.?,?\s+(\d{4})(?!\d)/gu;
const EN_MDY = /\b([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/gu;
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const BN_DMY = new RegExp(`(?<!\\d)(\\d{1,2})\\s?(?:${alt(['ই', 'লা', 'রা', 'শে', 'ঠা'])})?\\s+(\\p{Script=Bengali}+),?\\s+(\\d{4})(?!\\d)`, 'gu');
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const BANGLA_CALENDAR = new RegExp(alt(['বঙ্গাব্দ', 'বাং', 'বাংলা সন']), 'u');

// Times.
const HM = /(?<!\d)(\d{1,2})\s?[:.]\s?(\d{2})(?!\d)/u;
const MILITARY = /(?<!\d)([01]\d|2[0-3])([0-5]\d)\s?(?:hrs|hours|hr)\b/iu;
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const HOUR_ONLY = new RegExp(`(?<!\\d)(\\d{1,2})\\s?(?:${alt(['ঘটিকা', 'টা', 'টার', 'টায়', 'ঘঃ'])}|o['${String.fromCodePoint(0x2019)}]?clock|hrs|hours|hr|(?=\\s?[ap]\\.?\\s?m\\b))`, 'iu');
const MERIDIEM = /\b([ap])\.?\s?m\b\.?/iu;

type DayPart = 'DAWN' | 'MORNING' | 'NOON' | 'AFTERNOON' | 'EVENING' | 'NIGHT';
const DAY_PARTS: [DayPart, RegExp][] = (
  [
    ['NIGHT', ['মধ্যরাত', 'গভীর রাত', 'রাত্রি', 'রাত', 'night', 'midnight']],
    ['DAWN', ['ভোর', 'dawn']],
    ['MORNING', ['সকাল', 'morning']],
    ['NOON', ['দুপুর', 'মধ্যাহ্ন', 'noon']],
    ['AFTERNOON', ['বিকাল', 'বিকেল', 'অপরাহ্ন', 'afternoon']],
    ['EVENING', ['সন্ধ্যা', 'সন্ধা', 'evening']],
  ] as [DayPart, string[]][]
).map(([part, words]) => [part, new RegExp(alt(words), 'iu')]); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- constants

// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const APPROXIMATE = new RegExp(`${alt(['অনুমান', 'আনুমানিক', 'প্রায়', 'আনুঃ'])}|\\b(?:about|approx(?:imately|\\.)?|around|circa)\\b`, 'iu');

interface DateMatch {
  y: number;
  m: number;
  d: number;
  start: number;
  end: number;
  twoDigitYear: boolean;
}

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function findDate(s: string): DateMatch | null {
  const found: DateMatch[] = [];
  const push = (y: number, m: number, d: number, start: number, len: number, twoDigitYear = false) => {
    if (m && validDate(y, m, d)) found.push({ y, m, d, start, end: start + len, twoDigitYear });
  };
  for (const r of s.matchAll(NUMERIC_DATE)) {
    const short = r[3]!.length === 2;
    push(short ? 2000 + +r[3]! : +r[3]!, +r[2]!, +r[1]!, r.index, r[0].length, short); // day first (BD usage)
  }
  for (const r of s.matchAll(EN_DMY)) push(+r[3]!, enMonth(r[2]!), +r[1]!, r.index, r[0].length);
  for (const r of s.matchAll(EN_MDY)) push(+r[3]!, enMonth(r[1]!), +r[2]!, r.index, r[0].length);
  for (const r of s.matchAll(BN_DMY)) push(+r[3]!, BN_MONTHS[r[2]!] ?? 0, +r[1]!, r.index, r[0].length);
  found.sort((a, b) => a.start - b.start);
  return found[0] ?? null;
}

function enMonth(name: string): number {
  const lower = name.toLowerCase();
  return EN_MONTHS.findIndex((full) => full.startsWith(lower)) + 1;
}

interface TimeMatch {
  h: number;
  min: number;
}

function findTime(s: string): TimeMatch | null {
  const mil = MILITARY.exec(s);
  if (mil) return { h: +mil[1]!, min: +mil[2]! };
  const hm = HM.exec(s);
  if (hm && +hm[1]! <= 23 && +hm[2]! <= 59) return { h: +hm[1]!, min: +hm[2]! };
  const h = HOUR_ONLY.exec(s);
  if (h && +h[1]! <= 23) return { h: +h[1]!, min: 0 };
  return null;
}

/** Applies a.m./p.m. or the Bangla part of day to a 12-hour clock reading. */
function to24h(h: number, s: string, flags: FirDateTimeFlag[]): number {
  if (h > 12) return h; // already a 24-hour reading
  const mer = MERIDIEM.exec(s)?.[1]?.toLowerCase();
  if (mer) return mer === 'p' ? (h % 12) + 12 : h % 12;
  const part = DAY_PARTS.find(([, re]) => re.test(s))?.[0];
  switch (part) {
    case 'DAWN':
    case 'MORNING':
      return h % 12;
    case 'NOON':
      return h === 12 ? 12 : h <= 5 ? h + 12 : h; // দুপুর ১টা = 13:00, দুপুর ১২টা = 12:00
    case 'AFTERNOON':
    case 'EVENING':
      return (h % 12) + 12;
    case 'NIGHT':
      if (h >= 6 && h < 12) return h + 12; // রাত ৯টা = 21:00
      flags.push('NIGHT_AFTER_MIDNIGHT'); // রাত ১২টা / রাত ২টা: 00:xx / 02:xx on the written date
      return h % 12;
    default:
      if (h > 0) flags.push('AMBIGUOUS_MERIDIEM');
      return h;
  }
}

const pad = (v: number) => String(v).padStart(2, '0');

/** Offset of Asia/Dhaka from UTC, in minutes, at a UTC instant. */
function dhakaOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => +parts.find((p) => p.type === t)!.value;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Dhaka wall-clock time → UTC instant (two passes settle the offset, DST included). */
export function dhakaToUtc(y: number, m: number, d: number, h: number, min: number): Date {
  const wall = Date.UTC(y, m - 1, d, h, min);
  let utc = wall - 360 * 60_000;
  utc = wall - dhakaOffsetMinutes(utc) * 60_000;
  utc = wall - dhakaOffsetMinutes(utc) * 60_000;
  return new Date(utc);
}

export function parseFirDateTime(raw: string | null | undefined): FirDateTime | null {
  if (!raw) return null;
  const s = toAsciiDigits(raw.normalize('NFC'));
  const date = findDate(s);
  if (!date) return null;
  const flags: FirDateTimeFlag[] = [];
  if (date.twoDigitYear) flags.push('TWO_DIGIT_YEAR');
  if (BANGLA_CALENDAR.test(s)) flags.push('BANGLA_CALENDAR_IGNORED');

  // Look for the time outside the date, so "12.03.2024" never reads as 12:03.
  const rest = s.slice(0, date.start) + ' '.repeat(date.end - date.start) + s.slice(date.end);
  const t = findTime(rest);
  const isoDate = `${date.y}-${pad(date.m)}-${pad(date.d)}`;
  if (!t) return { date: isoDate, time: null, instant: null, approximate: APPROXIMATE.test(s), flags };

  const h = to24h(t.h, rest, flags);
  return {
    date: isoDate,
    time: `${pad(h)}:${pad(t.min)}`,
    instant: dhakaToUtc(date.y, date.m, date.d, h, t.min).toISOString(),
    approximate: APPROXIMATE.test(s),
    flags,
  };
}

export interface FilingDelay {
  /** Minutes from occurrence to report, when both times are known. */
  minutes: number | null;
  /** Whole calendar days between the two dates (Dhaka), when both dates are known. */
  days: number | null;
  basis: 'DATETIME' | 'DATE' | 'UNKNOWN';
  /** The report is dated before the occurrence: a reading or writing error, so no delay is given. */
  warning: 'REPORTED_BEFORE_OCCURRENCE' | null;
}

const dayNumber = (isoDate: string) => Date.UTC(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10)) / 86_400_000;

/** Delay between occurrence and FIR filing (TRD §8.2 stage 4: `filing_delay_minutes`). */
export function filingDelay(occurred: FirDateTime | null, reported: FirDateTime | null): FilingDelay {
  if (!occurred || !reported) return { minutes: null, days: null, basis: 'UNKNOWN', warning: null };
  const days = dayNumber(reported.date) - dayNumber(occurred.date);
  if (occurred.instant && reported.instant) {
    const minutes = Math.round((Date.parse(reported.instant) - Date.parse(occurred.instant)) / 60_000);
    if (minutes < 0) return { minutes: null, days: null, basis: 'DATETIME', warning: 'REPORTED_BEFORE_OCCURRENCE' };
    return { minutes, days, basis: 'DATETIME', warning: null };
  }
  if (days < 0) return { minutes: null, days: null, basis: 'DATE', warning: 'REPORTED_BEFORE_OCCURRENCE' };
  return { minutes: null, days, basis: 'DATE', warning: null };
}
