import { toAsciiDigits } from '@lawassist/legal-text';

/**
 * Metadata from the first pages of a judgment PDF (SRS §4.4: the list has no decision date or case
 * number). Input: `pdftotext -layout` of pages 1–4. Layout mode keeps "Date of Judgment : 15-01-2025"
 * on one line; plain mode splits two-column headers so labels and values no longer line up
 * (seen in 20 SCOB AD-3, JUD-01).
 */
export interface JudgmentHeader {
  /** From the running head of page 1 ("Begum Khaleda Zia & ors vs The State & anr"); null if not found. */
  parties: string | null;
  /** "(Syed Refaat Ahmed, CJ)" in the running head, without parentheses. */
  authoringJudge: string | null;
  /** "20 SCOB [2025] AD" from the running head of page 1, normalised spacing; null if absent. */
  citation: string | null;
  /** ISO date, or null when not found. */
  decisionDate: string | null;
  hearingDates: string[];
  /** "CRIMINAL APPEAL NO. 64 OF 2024", "WRIT PETITION NO. 1774 OF 2017" … in order of appearance. */
  caseNumbers: string[];
  /** Judges listed under "Present:" (AD and newer HCD headers). */
  bench: string[];
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH = '(January|February|March|April|May|June|July|August|September|October|November|December|Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
/** "25.8.2019", "15-01-2025", "03. 12. 2012", "19.01,2014", "30.01 2017", "13.04.15" (two-digit year, labelled values only). */
const NUMERIC = /(?<!\d)(\d{1,2})\s?[.\-/]\s?(\d{1,2})(?:\s?[.\-/,]\s?|\s)(\d{4}|\d{2})(?!\d)/g;
/** "11th March, 2015", "The 13th day of August, 2015", "5th of June, 2007", "18th June,2015". */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const DAY_MONTH = new RegExp(`(\\d{1,2})\\s?(?:st|nd|rd|th)?\\s{0,2}(?:day\\s+of\\s+|of\\s+)?${MONTH}\\.?,?\\s{0,2}(\\d{4})`, 'gi');
/** "March 11, 2015". */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const MONTH_DAY = new RegExp(`${MONTH}\\.?\\s{1,2}(\\d{1,2})\\s?(?:st|nd|rd|th)?,?\\s{0,2}(\\d{4})`, 'gi');

/** "15" → 2015, "98" → 1998; four digits as written. */
const fullYear = (y: string) => (y.length === 2 ? (Number(y) < 50 ? 2000 : 1900) + Number(y) : Number(y));

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1950 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null; // 31.02 etc.
}

/** Every valid date in a short value, numeric or written, Bangla digits included, in text order. */
export function isoDates(raw: string): string[] {
  const text = toAsciiDigits(raw);
  const found: { at: number; date: string }[] = [];
  for (const m of text.matchAll(NUMERIC)) {
    const d = iso(fullYear(m[3]!), Number(m[2]), Number(m[1]));
    if (d) found.push({ at: m.index, date: d });
  }
  for (const m of text.matchAll(DAY_MONTH)) {
    const d = iso(Number(m[3]), MONTHS[m[2]!.toLowerCase()]!, Number(m[1]));
    if (d) found.push({ at: m.index, date: d });
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    const d = iso(Number(m[3]), MONTHS[m[1]!.toLowerCase()]!, Number(m[2]));
    if (d) found.push({ at: m.index, date: d });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.date);
}

const YA = `য${String.fromCodePoint(0x09bc)}`; // NFC keeps য় decomposed
const RAY = `রা${YA}`; // রায় (judgment)
const JUDGMENT = String.raw`judg(?:e)?ment`;
/**
 * Labels at the start of a header cell. Requiring the start of a cell keeps "(From the judgment and
 * order dated …)" — the lower court's date — and body sentences out.
 */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const JUDGMENT_LABEL = new RegExp(
  String.raw`^[\s"'(]*(?:date\s+of\s+(?:hearing\s*(?:and|&)\s*)?(?:delivery\s+of\s+)?${JUDGMENT}|heard\s*(?:and|&)\s*${JUDGMENT}(?:\s*(?:delivered\s+)?on)?|(?:and\s+)?${JUDGMENT}\s*(?:delivered\s+on|pronounced\s+on|dated|on)|${RAY}\s*(?:ঘোষণার|প্রদানের|এর|ের)?\s*তারিখ|${RAY}ের\s*তারিখ|শুনানি\s*ও\s*${RAY}(?:\s*ঘোষণা)?(?:র)?\s*(?:তারিখ)?)\s*[:.\-–]?`,
  'iu',
);
/** "… 15.12.2014 and judgment on 18.12.2014": inside a hearing cell, after a date. */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const AND_JUDGMENT = new RegExp(String.raw`(?:\band|&)\s*${JUDGMENT}(?:\s*(?:delivered\s+)?on)?\s*[:.\-–]?`, 'i');
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const HEARING_LABEL = new RegExp(
  String.raw`^[\s"'(]*(?:dates?\s+of\s+hearing(?:\s*(?:and|&)\s*${JUDGMENT})?|heard(?:\s*(?:and|&)\s*${JUDGMENT})?(?:\s+on)?|শুনানি(?:র)?(?:\s*ও\s*${RAY}(?:\s*ঘোষণা)?(?:র)?)?\s*(?:তারিখ)?)\s*[:.\-–]?`,
  'iu',
);

interface Cell {
  line: number;
  start: number;
  text: string;
}

/** `pdftotext -layout` lines split into column cells (3+ spaces apart), with their start column. */
function cells(lines: string[]): Cell[][] {
  return lines.map((l, line) => {
    const out: Cell[] = [];
    for (const m of l.matchAll(/\S(?:.*?\S)??(?=\s{3,}|\s*$)/g)) out.push({ line, start: m.index, text: m[0] });
    return out;
  });
}

/** A continuation cell holds only dates, a year or a date fragment ("2015.", "on 18.12.2014", "02-03-"). */
function dateish(text: string): boolean {
  const rest = toAsciiDigits(text)
    .replace(/(\d)\s?(?:st|nd|rd|th)\b/gi, '$1') // 18th, 5 th
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- one header cell, a few dozen characters
    .replace(new RegExp(MONTH, 'gi'), '')
    .replace(/\b(?:and|on|the|day|of|st|nd|rd|th|judg(?:e)?ment|delivered)\b/gi, '')
    .replace(/[\d\s,.&:\-–/]/g, '');
  return rest === '' && /\d/.test(text);
}

/**
 * The value of the first cell matching `label`, plus the cells right below it in the same column
 * that only continue the dates ("The 18th September," ↵ "2015.").
 */
function labelled(grid: Cell[][], label: RegExp, midCell?: RegExp): string | null {
  for (const row of grid) {
    for (const cell of row) {
      let m = label.exec(cell.text);
      let value: string | null = m ? cell.text.slice(m[0].length) : null;
      if (value === null && midCell) {
        m = midCell.exec(cell.text);
        // Only after a date in the same cell ("…, 15.12.2014 and judgment").
        if (m && isoDates(cell.text.slice(0, m.index)).length) value = cell.text.slice(m.index + m[0].length);
      }
      if (value === null) continue;
      // "Date of hearing          : 07-01-2025": label and value can be separate cells.
      // The next cell with content (a lone ":" can be a cell of its own).
      const next = row.slice(row.indexOf(cell) + 1).find((c) => !/^[:.\-–]+$/.test(c.text));
      // Continuation lines line up under whichever cell held the value.
      let col = cell.start;
      if (!isoDates(value).length && next && dateish(next.text.replace(/^[:\s]+/, ''))) {
        value += ` ${next.text}`;
        col = next.start;
      } else if (m && /\S/.test(value)) {
        col = cell.start + cell.text.indexOf(value.trim()); // "Date of hearing   :15.01.2013, …" in one cell
      }
      for (let j = cell.line + 1; j < grid.length && j <= cell.line + 3; j++) {
        const below = grid[j]!.find((c) => Math.abs(c.start - col) <= 15 || Math.abs(c.start - cell.start) <= 15 || (c.start <= col && c.start + c.text.length > col));
        if (!below || !dateish(below.text)) break;
        value += ` ${below.text}`;
      }
      return value;
    }
  }
  return null;
}

export function parseJudgmentHeader(layoutText: string): JudgmentHeader {
  const lines = layoutText.normalize('NFC').split(/\r?\n/);
  const grid = cells(lines);
  const judgmentLine = labelled(grid, JUDGMENT_LABEL, AND_JUDGMENT);
  const hearingLine = labelled(grid, HEARING_LABEL);
  // A hearing cell may run on into "and judgment on …": those dates are the judgment's.
  const hearingDates = hearingLine ? isoDates(hearingLine.split(/(?:\band|&)\s*judg(?:e)?ment\b/i)[0]!) : [];
  const judgmentDates = judgmentLine ? isoDates(judgmentLine) : [];

  const caseNumbers: string[] = [];
  for (const m of layoutText.matchAll(/\b((?:CRIMINAL|CIVIL|JAIL|WRIT|CIVIL REVISION|CRIMINAL REVISION|CRIMINAL MISCELLANEOUS|DEATH REFERENCE|CIVIL PETITION FOR LEAVE TO APPEAL|CRIMINAL PETITION FOR LEAVE TO APPEAL|FIRST APPEAL|CIVIL MISCELLANEOUS|REVIEW)\s+(?:APPEAL|PETITION|REVISION|CASE|REFERENCE|MATTER)?\s*NOS?\.?\s*[\d,\s&and-]+?\s+OF\s+\d{4})/gi)) {
    // "NO.9935" and "NO. 9935" are the same case number.
    const v = m[1]!.replace(/\s+/g, ' ').replace(/\b(NOS?)\.\s*/i, '$1. ').trim().toUpperCase();
    if (!caseNumbers.includes(v)) caseNumbers.push(v);
  }

  const bench: string[] = [];
  const present = lines.findIndex((l) => /^\s*present\s*:?\s*$/i.test(l));
  if (present >= 0) {
    for (const l of lines.slice(present + 1, present + 12)) {
      const m = /^\s*((?:Mr|Mrs|Ms|Madam)\.?\s+Justice\s+[^,]+?)\s*(?:,.*)?\.?\s{2,}|^\s*((?:Mr|Mrs|Ms|Madam)\.?\s+Justice\s+.+?)\.?\s*$/.exec(l);
      const name = (m?.[1] ?? m?.[2])?.replace(/[.,]\s*$/, '').trim();
      if (name) bench.push(name);
      else if (bench.length && !/^\s*(and|chief justice,?)\s*$/i.test(l) && l.trim()) break;
    }
  }
  const cite = /(\d+)\s*SCOB\s*\[\s*(\d{4})\s*\]\s*(AD|HCD|HD)\b/i.exec(layoutText);

  // Running head of page 1: "<citation> <parties> (<Judge>, J)", over one to four lines.
  const head: string[] = [];
  for (const l of lines.map((x) => x.trim()).filter(Boolean).slice(0, 6)) {
    head.push(l);
    if (/\([^()]*,\s*(?:CJ|J|JJ)\.?\)/.test(l)) break;
  }
  const headText = head.join(' ').replace(/\s+/g, ' ');
  const judgeMatch = /\(([^()]*?,\s*(?:CJ|J|JJ)\.?)\)/.exec(headText);
  let parties: string | null = null;
  if (judgeMatch) {
    const before = headText.slice(0, judgeMatch.index).replace(/^\s*\d+\s*SCOB\s*\[\s*\d{4}\s*\]\s*(?:AD|HCD|HD)\b(?:\s*\d+\b)?/i, '').trim();
    if (/\bv(?:s|ersus)?\.?\s/i.test(before)) parties = before;
  }

  return {
    parties,
    authoringJudge: judgeMatch ? judgeMatch[1]!.trim() : null,
    citation: cite ? `${cite[1]} SCOB [${cite[2]}] ${cite[3]!.toUpperCase() === 'HD' ? 'HCD' : cite[3]!.toUpperCase()}` : null,
    // The judgment date is never before the last hearing; take the latest date on that line.
    decisionDate: judgmentDates.length ? [...judgmentDates].sort().at(-1)! : null,
    hearingDates,
    caseNumbers,
    bench,
  };
}
