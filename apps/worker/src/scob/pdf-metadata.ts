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

const DATE = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/g;

function isoDates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATE)) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1950 || y > 2100) continue;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCDate() !== d) continue; // 31.02 etc.
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

/** A continuation line holding nothing but dates and separators ("30.01.2013, 12.02.2013,"). Linear: no nested quantifiers. */
function onlyDates(line: string): boolean {
  if (!/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/.test(line)) return false;
  return line.replace(/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/g, '').replace(/\band\b/gi, '').replace(/[\s,.&]/g, '') === '';
}

/** The value after a label on the same line, plus continuation lines that only hold dates. */
function labelled(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]!);
    if (!m) continue;
    let value = lines[i]!.slice(m.index + m[0].length);
    for (let j = i + 1; j < lines.length && onlyDates(lines[j]!); j++) value += ` ${lines[j]}`;
    return value;
  }
  return null;
}

export function parseJudgmentHeader(layoutText: string): JudgmentHeader {
  const lines = layoutText.split(/\r?\n/);
  const judgmentLine = labelled(lines, /date\s+of\s+judg(?:e)?ment\s*:?|judg(?:e)?ment\s+(?:on|delivered\s+on)\s*:?/i);
  const hearingLine = labelled(lines, /date\s+of\s+hearing\s*:?|heard\s+on\s*:?/i);
  const hearingDates = hearingLine ? isoDates(hearingLine) : [];
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
