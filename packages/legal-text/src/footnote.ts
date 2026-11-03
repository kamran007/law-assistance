import { toAsciiDigits } from './digits';

/**
 * Amendment footnote parsing (TRD §6.2 step 4).
 *
 * bdlaws footnotes look like:
 *   "Substituted by section 2 of the Penal Code (Amendment) Act, 2004 (Act No. IX of 2004)"
 *   "Inserted by the ... Ordinance, 1982 (Ordinance No. XXIV of 1982), with effect from 1st July, 1982"
 *   "২০০৯ সনের ৫০ নং আইনের ২ ধারাবলে প্রতিস্থাপিত"
 * The rules are deliberately conservative: anything not recognised becomes action OTHER with nulls,
 * and the verbatim text is always kept.
 */
export type FootnoteAction = 'SUBSTITUTED' | 'INSERTED' | 'OMITTED' | 'OTHER';

export interface ParsedFootnote {
  action: FootnoteAction;
  /** Canonical form, e.g. "Act No. IX of 2004" or "Ordinance No. 24 of 1982". */
  byAct: string | null;
  /** ISO date (YYYY-MM-DD) the amendment took effect, if the footnote states one. */
  date: string | null;
  text: string;
}

const ACTION_RULES: ReadonlyArray<[FootnoteAction, RegExp]> = [
  ['SUBSTITUTED', /substitut|replaced|প্রতিস্থাপিত/i],
  ['INSERTED', /insert|added|সন্নিবেশিত|সংযোজিত|যোগ করা/i],
  ['OMITTED', /omitted|repealed|deleted|বিলুপ্ত|রহিত|বাদ দেওয়া/i],
];

const EN_ACT_NO = /\b(Act|Ordinance|Order|P\.\s?O\.)\s*No\.?\s*([IVXLCDM]+|\d+)\s*(?:of|,)\s*(\d{4})/i;
const BN_ACT_NO = new RegExp(`(\\d{4})\\s*${nfc('সনের')}\\s*(\\d+)\\s*${nfc('নং')}\\s*(${nfc('আইন')}|${nfc('অধ্যাদেশ')}|${nfc('আদেশ')})`);

export function parseFootnoteAction(raw: string): ParsedFootnote {
  const text = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  const ascii = toAsciiDigits(text);
  const action = ACTION_RULES.find(([, re]) => re.test(text))?.[0] ?? 'OTHER';
  return { action, byAct: extractAmendingAct(ascii), date: extractEffectiveDate(ascii), text };
}

function extractAmendingAct(ascii: string): string | null {
  const en = EN_ACT_NO.exec(ascii);
  if (en) {
    const kind = /^p\.?\s?o\.?$/i.test(en[1]!) ? 'P.O.' : capitalize(en[1]!);
    return `${kind} No. ${en[2]!.toUpperCase()} of ${en[3]}`;
  }
  const bn = BN_ACT_NO.exec(ascii);
  if (bn) {
    const kind = bn[3] === nfc('আইন') ? 'Act' : bn[3] === nfc('অধ্যাদেশ') ? 'Ordinance' : 'Order';
    return `${kind} No. ${bn[2]} of ${bn[1]}`;
  }
  return null;
}

const WEF_EN = /(?:with effect from|w\.\s?e\.\s?f\.?|deemed to have (?:come into force|been (?:substituted|inserted|omitted)) (?:on|from))\s*/i;
const WEF_BN = new RegExp(`${nfc('তারিখ')}\\s*(?:${nfc('হইতে')}|${nfc('থেকে')})\\s*${nfc('কার্যকর')}`);

/** Only a date tied to "with effect from" (or the Bangla equivalent) counts as the effective date. */
function extractEffectiveDate(ascii: string): string | null {
  const wef = WEF_EN.exec(ascii);
  if (wef) return parseLegalDate(ascii.slice(wef.index + wef[0].length, wef.index + wef[0].length + 40));
  const bn = WEF_BN.exec(ascii);
  if (bn) return parseLegalDate(ascii.slice(Math.max(0, bn.index - 40), bn.index));
  return null;
}

const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'].map(nfc);
const BN_MONTH_ALIASES: Record<string, number> = {
  [nfc('জানুয়ারী')]: 1,
  [nfc('ফেব্রুয়ারী')]: 2,
  [nfc('আগষ্ট')]: 8,
};

const EN_DATE = /(\d{1,2})\s*(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?([A-Za-z]+)\.?,?\s+(\d{4})/;
const EN_DATE_MDY = /([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/;
const NUMERIC_DATE = /\b(\d{1,2})[-./](\d{1,2})[-./](\d{4})\b/;
const BN_DATE = /(\d{1,2})\s*(?:ই|লা|রা|শে|ঠা)?\s+(\p{Script=Bengali}+),?\s+(\d{4})/u;

/**
 * Parses the first full date in a fragment of legal text ("6th October, 1860", "October 6, 1860",
 * "06-10-1860", "১৫ জুলাই, ২০০৯"). Day-month order is assumed for numeric dates (Bangladesh usage).
 * Returns ISO YYYY-MM-DD or null.
 */
export function parseLegalDate(fragment: string): string | null {
  const s = toAsciiDigits(fragment.normalize('NFC'));
  let m = EN_DATE.exec(s);
  if (m) {
    const month = monthFromEnglish(m[2]!);
    if (month) return iso(+m[3]!, month, +m[1]!);
  }
  m = EN_DATE_MDY.exec(s);
  if (m) {
    const month = monthFromEnglish(m[1]!);
    if (month) return iso(+m[3]!, month, +m[2]!);
  }
  m = BN_DATE.exec(s);
  if (m) {
    const name = m[2]!;
    const month = BN_MONTHS.indexOf(name) + 1 || BN_MONTH_ALIASES[name] || 0;
    if (month) return iso(+m[3]!, month, +m[1]!);
  }
  m = NUMERIC_DATE.exec(s);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  return null;
}

function monthFromEnglish(name: string): number {
  const n = name.toLowerCase();
  if (n.length < 3) return 0;
  return EN_MONTHS.findIndex((full) => full.startsWith(n)) + 1;
}

function iso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function nfc(s: string): string {
  return s.normalize('NFC');
}
