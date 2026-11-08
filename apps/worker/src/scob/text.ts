/**
 * Judgment text from `pdftotext -layout` pages (TRD §6A.3 steps 3–4).
 */

/** Under this many characters per page on average, a PDF is treated as scanned (needs OCR). */
export const MIN_CHARS_PER_PAGE = 200;

export const averageCharsPerPage = (pages: string[]) => (pages.length ? pages.reduce((n, p) => n + p.replace(/\s+/g, '').length, 0) / pages.length : 0);

const norm = (l: string) => l.replace(/\s+/g, ' ').trim();

/**
 * Joins pages and removes what repeats on most pages — the running head ("20 SCOB [2025] AD",
 * parties, judge) and page numbers — so paragraphs and chunks carry only the judgment's text.
 */
export function cleanPages(pages: string[]): string {
  const counts = new Map<string, number>();
  for (const p of pages) for (const l of new Set(p.split('\n').map(norm).filter(Boolean))) counts.set(l, (counts.get(l) ?? 0) + 1);
  const repeated = pages.length >= 3 ? new Set([...counts].filter(([, n]) => n >= Math.max(3, pages.length * 0.5)).map(([l]) => l)) : new Set<string>();
  return pages
    .map((p) =>
      p
        .split('\n')
        .filter((l) => {
          const t = norm(l);
          return !repeated.has(t) && !/^\d{1,4}$/.test(t); // running head, bare page numbers
        })
        .map((l) => l.replace(/\s+$/, ''))
        .join('\n'),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toAscii = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));

/**
 * Marks numbered paragraphs as `[para n]` (TRD §6A.3 step 4). A line starting "n." counts only if n
 * continues the sequence (n = last + 1, or a small jump of up to 3 for pages the extraction lost),
 * so numbered lists inside a paragraph ("1. the accused …") don't become paragraphs. Bangla digits
 * work too.
 */
export function markParagraphs(text: string): { text: string; paragraphs: number } {
  let last = 0;
  const out = text.split('\n').map((line) => {
    const m = /^(\s*)([0-9০-৯]{1,3})\.\s+(\S.*)$/.exec(line);
    if (!m) return line;
    const n = Number(toAscii(m[2]!));
    if (n <= last || n > last + 3) return line;
    last = n;
    return `[para ${n}] ${m[3]}`;
  });
  return { text: out.join('\n'), paragraphs: last };
}

/** EN, BN or MIXED by the share of Bangla letters among all letters. */
export function detectLanguage(text: string): 'EN' | 'BN' | 'MIXED' {
  let bn = 0;
  let latin = 0;
  for (const ch of text) {
    if (/\p{Script=Bengali}/u.test(ch)) bn++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  const total = bn + latin;
  if (total === 0) return 'EN';
  const share = bn / total;
  return share > 0.8 ? 'BN' : share < 0.2 ? 'EN' : 'MIXED';
}

/**
 * Very frequent Bangla words in judgments. Text converted from a legacy font the converter doesn't
 * know comes out as Bengali letters that form almost none of them (seen in 7 SCOB judgments).
 */
const COMMON_BANGLA = new Set(
  ['এবং', 'ও', 'এই', 'যে', 'না', 'করা', 'করে', 'হয়', 'হইয়া', 'হইতে', 'থেকে', 'তারিখ', 'আদালত', 'ধারা', 'মামলা', 'মামলার', 'বিভাগ', 'আইন', 'আইনের', 'রায়', 'আদেশ', 'দরখাস্ত', 'পক্ষ', 'বনাম', 'সরকার', 'জন্য', 'সাথে', 'তার', 'তাহার', 'কোন', 'কোনো', 'এর', 'বা'].map((w) => w.normalize('NFC')),
);
/** Below this share of common words among Bangla words, Bangla text is not readable. Readable SCOB judgments: 11–20 %; garbled ones: under 5 %. */
export const MIN_COMMON_BANGLA_SHARE = 0.08;

/** Share of very common Bangla words among the Bangla words of a text (1 when there are fewer than 50). */
export function commonBanglaShare(text: string): number {
  const words = text.normalize('NFC').match(/[\p{Script=Bengali}\p{M}]+/gu) ?? [];
  if (words.length < 50) return 1;
  return words.filter((w) => COMMON_BANGLA.has(w)).length / words.length;
}
