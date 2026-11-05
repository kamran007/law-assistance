import { ACT_DICTIONARY, DEFAULT_FIR_ACT, type ActEntry } from './act-dictionary';
import { toAsciiDigits } from './digits';
import { normalizeSectionKey } from './section-key';

/**
 * Deterministic section detector (TRD §8.4, DATA-12): finds statutory citations in FIR / document
 * text in Bangla and English, expands lists ("302/34" → 302 and 34, cited together) and resolves
 * the Act named nearby. No LLM: the scan pipeline keeps an LLM-proposed section only if this
 * detector also finds it in the text (TRD §8.2 stage 4).
 *
 * Positions refer to the NFC-normalized input.
 */
export interface DetectedAct {
  key: string;
  bdlawsActId: number;
  name: string;
}

export interface SectionCitation {
  /** The whole citation group as written, e.g. "দণ্ডবিধির ৩০২/৩৪ ধারা" minus the Act name. */
  raw: string;
  /** This section as written: "৩০২", "561A", "১১". */
  section: string;
  /** Normalized key for lookups: "302", "561A", "11". */
  key: string;
  /** Sub-section / clause in ASCII digits, e.g. "(1)(b)", "(গ)"; null if none. */
  subsection: string | null;
  act: DetectedAct | null;
  /** True when no Act was named and the FIR default (Penal Code) was applied. */
  actInferred: boolean;
  /** Keys of every section in the same group ("302/34" → ["302","34"]); empty for a single one. */
  citedTogether: string[];
  start: number;
  end: number;
}

export interface DetectOptions {
  /** FIRs: an unnamed Act is the Penal Code, flagged `actInferred` (TRD §8.4). Otherwise null. */
  defaultAct?: 'PENAL_CODE' | null;
}

const NUKTA = String.fromCodePoint(0x09bc);
const YA_NUKTA = String.fromCodePoint(0x09df); // precomposed য়; NFC decomposes it, both are accepted
const DIGIT = '[0-9০-৯]';
/**
 * One section: 1–4 digits, an optional inserted-section letter glued to it (561A, ১১ক; Bangla only
 * ক–ঙ so "৩৪ধারা" is not read as section 34ধ), an optional "-I" style suffix, then up to three
 * bracketed sub-parts: (1), (b), (গ), (১)(ক).
 */
/**
 * Letter of an inserted section, glued to the number: "265K" (a capital not followed by another
 * letter, so "302 And" stays 302), "১১ক" (ক–ঙ only, so "৩৪ধারা" is not 34ধ), or the Bangla
 * transliteration of A–D that FIRs use for English letters: "২৫বি" = 25B, "৩২৬এ" = 326A.
 */
const LETTER = `(?:[A-Z](?![A-Za-z])|[ক-ঙ](?![\\p{L}\\p{M}])|(?:এ|বি|সি|ডি)(?![\\p{L}\\p{M}]))`;
const TRANSLIT: Record<string, string> = { এ: 'A', বি: 'B', সি: 'C', ডি: 'D' };
const SUB = `(?:\\s?\\(\\s?[0-9০-৯A-Za-zক-হ]{1,4}\\s?\\)){0,3}`;
const NUM = `${DIGIT}{1,4}${LETTER}?(?:-[A-Z])?${SUB}`;
const SEP = `\\s{0,2}(?:/|,|&|\\band\\b|\\bor\\b|এবং|ও|সহ)\\s{0,2}`;
const LIST = `${NUM}(?:${SEP}${NUM}){0,15}`;
const DHARA = `ধারা(?:য${NUKTA}?|${YA_NUKTA}|র|মতে|সমূহ(?:ের)?|সহ)?`;
const KEYWORD = `(?:${DHARA}|সেকশন|\\bsections?\\b|\\bsecs?\\b\\.?|\\bss?\\.|\\bu/s\\b\\.?|\\bunder\\s+section\\b)`;

// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
// Lookbehinds include \p{M}: Bangla vowel signs are marks, so "সুধারা" must not yield "ধারা".
const KEYWORD_FIRST = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${KEYWORD}[\\s:.\\-–]{0,3}(${LIST})`, 'giu');
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const NUMBER_FIRST = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}/])(${LIST})\\s{0,2}(?:নং\\s{0,2})?${DHARA}`, 'gu');
/**
 * Narcotics Act style: "৩৬(১) সারণির ১০(ক) ধারা" = section 36(1), serial 10(ক) of its table. The
 * section is the FIRST number; the serial is kept with the sub-section.
 */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const TABLE_CITATION = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}/])(${NUM})\\s{0,2}সারণি(?:র)?\\s{0,2}(?:ক্রমিক\\s{0,2}(?:নং\\s{0,2})?)?(${NUM})\\s{0,2}(?:নং\\s{0,2})?(?:${DHARA})?`,
  'gu',
);
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const ONE = new RegExp(`(${DIGIT}{1,4}${LETTER}?(?:-[A-Z])?)(${SUB})`, 'gu');

/** Act mention immediately after a citation: "302 of the Penal Code", "ধারা ৪২০ দণ্ডবিধি". */
const CONNECTOR_AFTER = /^[\s,]*(?:(?:of|under|r\/w|read\s+with)\s+)?(?:the\s+)?$/i;
/** Act mention before: "দণ্ডবিধির ৩০২", "… দমন আইন, ২০০০ (সংশোধিত ২০০৩) এর ১১(গ)", "Penal Code s. 302". */
const CONNECTOR_BEFORE = /^[\s,]*(?:আইন[^\n]{0,40}?)?(?:এর|র|ের|'s)?[\s,]*$/u;
const ACT_WINDOW = 80;
const CONNECTOR_BONUS = 60;

interface ActMention {
  act: ActEntry;
  start: number;
  end: number;
}

// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- dictionary constants, not input
const ACT_REGEXES = ACT_DICTIONARY.map((act) => ({ act, re: new RegExp(act.patterns.join('|'), 'giu') }));

function findActs(text: string): ActMention[] {
  const all: ActMention[] = [];
  for (const { act, re } of ACT_REGEXES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) all.push({ act, start: m.index, end: m.index + m[0].length });
  }
  // Longest first, then drop anything overlapping a kept mention ("Cr.P.C." hides its "P.C.").
  all.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: ActMention[] = [];
  for (const m of all) if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
  return kept.sort((a, b) => a.start - b.start);
}

function resolveAct(text: string, start: number, end: number, acts: ActMention[]): ActEntry | null {
  let best: { act: ActEntry; score: number } | null = null;
  for (const m of acts) {
    let score: number;
    if (m.start >= end) {
      const gap = m.start - end;
      if (gap > ACT_WINDOW) continue;
      // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- input is a slice of at most ACT_WINDOW (80) chars
      score = gap - (CONNECTOR_AFTER.test(text.slice(end, m.start)) ? CONNECTOR_BONUS : 0);
    } else if (m.end <= start) {
      const gap = start - m.end;
      if (gap > ACT_WINDOW) continue;
      // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- input is a slice of at most ACT_WINDOW (80) chars
      score = gap - (CONNECTOR_BEFORE.test(text.slice(m.end, start)) ? CONNECTOR_BONUS : 0);
    } else continue;
    if (!best || score < best.score) best = { act: m.act, score };
  }
  return best?.act ?? null;
}

interface Group {
  start: number;
  end: number;
  list: string;
  /** Set for a table citation: the serial ("১০(ক)") that follows the section. */
  tableSerial?: string;
}

function findGroups(text: string): Group[] {
  const groups: Group[] = [];
  TABLE_CITATION.lastIndex = 0;
  for (const m of text.matchAll(TABLE_CITATION)) {
    groups.push({ start: m.index, end: m.index + m[0].length, list: m[1]!, tableSerial: m[2]! });
  }
  for (const re of [KEYWORD_FIRST, NUMBER_FIRST]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) groups.push({ start: m.index, end: m.index + m[0].length, list: m[1]! });
  }
  // Keep the longest of overlapping matches ("ধারা ৩০২/৩৪ ধারায়" is one group).
  groups.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Group[] = [];
  for (const g of groups) if (!kept.some((k) => g.start < k.end && k.start < g.end)) kept.push(g);
  return kept.sort((a, b) => a.start - b.start);
}

const asciiSub = (s: string) => toAsciiDigits(s).replace(/\s+/g, '');

export function detectSections(input: string, opts: DetectOptions = {}): SectionCitation[] {
  const text = input.normalize('NFC');
  const acts = findActs(text);
  const fallback = opts.defaultAct === 'PENAL_CODE' ? DEFAULT_FIR_ACT : null;
  const out: SectionCitation[] = [];

  for (const g of findGroups(text)) {
    const resolved = resolveAct(text, g.start, g.end, acts);
    const act = resolved ?? fallback;
    const parts: { section: string; key: string; subsection: string | null }[] = [];
    ONE.lastIndex = 0;
    for (const m of g.list.matchAll(ONE)) {
      const key = normalizeSectionKey(m[1]!.replace(/(এ|বি|সি|ডি)$/u, (l) => TRANSLIT[l]!));
      if (!key) continue;
      parts.push({ section: m[1]!, key, subsection: m[2] ? asciiSub(m[2]) : null });
    }
    if (g.tableSerial && parts[0]) {
      // "৩৬(১) সারণির ১০(ক)" → section 36, sub-section "(1) table 10(ক)".
      parts[0].subsection = `${parts[0].subsection ?? ''} table ${asciiSub(g.tableSerial)}`.trim();
    }
    const together = parts.length > 1 ? parts.map((p) => p.key) : [];
    for (const p of parts) {
      out.push({
        raw: text.slice(g.start, g.end),
        ...p,
        act: act ? { key: act.key, bdlawsActId: act.bdlawsActId, name: act.name } : null,
        actInferred: !resolved && !!fallback,
        citedTogether: together,
        start: g.start,
        end: g.end,
      });
    }
  }
  return out;
}

/** One entry per (Act, section, sub-section), first occurrence kept: the FIR's list of offences. */
export function uniqueCitations(citations: SectionCitation[]): SectionCitation[] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const k = `${c.act?.key ?? '-'}|${c.key}|${c.subsection ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
