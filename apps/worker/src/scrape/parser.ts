import * as cheerio from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  hashFootnotes,
  hashSectionContent,
  normalizeForDisplay,
  normalizeSectionKey,
  parseFootnoteAction,
  parseLegalDate,
  toAsciiDigits,
  type ParsedFootnote,
} from '@lawassist/legal-text';
import type { SourceConfig } from './source-config';

/**
 * Act print-view parser (TRD §6.2): Act → Part/Chapter → Section → Sub-section/Proviso/Explanation
 * → Footnotes. Pure function of (html, config), so a stored snapshot always re-parses identically.
 */
export type PartKind = 'TEXT' | 'SUBSECTION' | 'PROVISO' | 'EXPLANATION' | 'ILLUSTRATION';

export interface SectionPart {
  kind: PartKind;
  /** "(1)", "(২)" for sub-sections; null otherwise. */
  label: string | null;
  text: string;
}

export interface ParsedSection {
  /** As printed, e.g. "৫৬১ক" or "420". */
  sectionNumber: string;
  normalizedSectionKey: string;
  chapterReference: string | null;
  marginalHeading: string | null;
  /** Display text, verbatim apart from whitespace collapsing; paragraphs joined with "\n". */
  contentBody: string;
  parts: SectionPart[];
  footnotes: ParsedFootnote[];
  contentHash: string;
  footnotesHash: string;
}

export interface ParsedAct {
  bdlawsActId: number;
  sourceUrl: string;
  title: string;
  actNumber: string | null;
  language: 'BN' | 'EN';
  enactedDate: string | null;
  isRepealed: boolean;
  sections: ParsedSection[];
  /** Structural problems found while parsing (no document text, safe to log). */
  warnings: string[];
}

const BN_LETTER = /\p{Script=Bengali}/gu;
const LATIN_LETTER = /[A-Za-z]/g;

/**
 * bdlaws ends Bangla section numbers with either the danda (U+0964) or U+09F7, a different character
 * that looks the same ("১৷"). Built from its code point so the source shows which one it is.
 */
const BN_DANDA_LOOKALIKE = String.fromCodePoint(0x09f7);

/**
 * "420." / "৪২০।" / "১৷" / "[326A." / "561 A -" / "171-I." at the start of a section body. The
 * portal writes a letter I with a hyphen ("171-I") so it isn't read as "171l". Inputs are already
 * trimmed and whitespace-collapsed. The pattern is anchored with bounded quantifiers and no two
 * unbounded quantifiers over the same characters, so matching is linear (no ReDoS). It is built from
 * constants only (no input), so the RegExp constructor is safe here.
 */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- constant pattern, see above
const SECTION_NUMBER = new RegExp(
  String.raw`^[[(]?\s?([0-9০-৯]{1,4}(?:\s?[A-Zক-ঞ]{1,2}|-[A-Z]{1,2})?)\s?[.।${BN_DANDA_LOOKALIKE}:-]`,
  'u',
);

/** "23 and 24. [Repealed …]" / "100-103. [Omitted …]": one row standing for several spent sections. */
const SECTION_RANGE = /^\[?\s?([0-9]{1,4})\s?(and|to|-|–)\s?([0-9]{1,4})\s?\./u;
const MAX_RANGE = 30;

/** Short lines a stray marginal note can occupy before a section number ("“Payee”" ⏎ "8. The …"). */
const MAX_STRAY_NOTE_LINES = 2;
const MAX_STRAY_NOTE_LENGTH = 60;
/** Rows before the first section that are not sections. */
const PREAMBLE_HEADING = /^(?:Preamble|প্রস্তাবনা)$/iu;

const SUBSECTION = /^\(\s*([0-9০-৯]{1,3}[a-zক-ঞ]?)\s*\)/u;
const PROVISO = /^(?:\[?\s*Provided\b|তবে শর্ত)/u;
const EXPLANATION = /^(?:\[?\s*Explanation\b|ব্যাখ্যা)/u;
const ILLUSTRATION = /^(?:\[?\s*Illustrations?\b|দৃষ্টান্ত)/u;

const EN_ACT_NO = /\(\s*((?:ACT|ORDINANCE|ORDER|P\.\s?O\.|REGULATION)\s+NO\.?\s*[^)]{1,40})\)/i;
const BN_ACT_NO = /(\d{4}\s*সনের\s*\d+\s*নং\s*(?:আইন|অধ্যাদেশ|আদেশ))/u;

export function parseActPrint(html: string, meta: { bdlawsActId: number; sourceUrl: string }, cfg: SourceConfig): ParsedAct {
  const $ = cheerio.load(html);
  const sel = cfg.selectors;
  const warnings: string[] = [];

  // The title carries Act-wide footnote markers ("1The Penal Code, 1860"); drop them.
  const titleEl = $(sel.title).first();
  const title = titleEl.length ? normalizeForDisplay(withoutMarkers(titleEl, sel.footnoteMarker).text()) : '';
  if (!title) warnings.push('title not found');
  const preamble = $(sel.preamble)
    .toArray()
    .map((el) => normalizeForDisplay($(el).text()))
    .join(' ');

  const footnoteTexts = collectFootnotes($, sel.footnote, sel.footnoteMarker);
  const drafts: SectionDraft[] = [];
  const seenKeys = new Set<string>();
  let current: SectionDraft | null = null;
  let chapter: string | null = null;
  let sectionBlocks = 0;
  let repealedBlocks = 0;
  /** Blocks with text but no number and no section above them (a one-section Act has exactly one). */
  const unnumbered: SectionDraft[] = [];

  $(`${sel.chapter}, ${sel.section}`).each((i, el) => {
    const node = $(el);
    if (!node.is(sel.section)) {
      // A chapter heading nested in a section block was already applied when that block was visited
      // (document order visits the block before its children).
      if (!node.parents(sel.section).length) chapter = normalizeForDisplay(node.text()) || chapter;
      return;
    }
    sectionBlocks++;
    if (node.is(sel.repealedSection)) repealedBlocks++;
    const nestedChapter = node.find(sel.chapter).first();
    if (nestedChapter.length) chapter = normalizeForDisplay(nestedChapter.text()) || chapter;

    const headingEl = node.find(sel.sectionHeading).first();
    const bodyEl = node.find(sel.sectionBody).first();
    if (!bodyEl.length) {
      warnings.push(`section block #${i}: body selector matched nothing`);
      return;
    }

    const markers: string[] = [];
    for (const m of [...headingEl.find(sel.footnoteMarker).toArray(), ...bodyEl.find(sel.footnoteMarker).toArray()]) {
      const n = toAsciiDigits($(m).text()).replace(/\D/g, '');
      if (n) markers.push(n);
    }

    const heading = normalizeForDisplay(headingEl.text()) || null;
    const displayLines = paragraphs($, bodyEl, sel.lineBreak);
    // Footnote reference markers are stripped for hashing only (TRD §6.2 step 2).
    const hashLines = paragraphs($, withoutMarkers(bodyEl, sel.footnoteMarker), sel.lineBreak);
    const hashHeading = headingEl.length ? normalizeForDisplay(withoutMarkers(headingEl, sel.footnoteMarker).text()) : '';
    if (!hashLines.length) return; // empty layout row

    const range = SECTION_RANGE.exec(hashLines[0]!);
    const rangeNumbers = range ? expandRange(range) : null;
    let sectionNumber = rangeNumbers?.[0] ?? matchedNumber(SECTION_NUMBER.exec(hashLines[0]!) ?? SECTION_NUMBER.exec(hashHeading));

    if (!sectionNumber && current && displayLines.length === hashLines.length) {
      // A stray marginal note printed on its own line(s) before the number ("“Payee”" ⏎ "8. The
      // “holder” …"). Accept it only as the start of a new, later, unseen section, so a numbered
      // line inside a continuation is never split off. The note lines join the previous section's
      // marginal notes (hash only), not any section body.
      for (let j = 1; j <= MAX_STRAY_NOTE_LINES && j < hashLines.length; j++) {
        if (hashLines[j - 1]!.length > MAX_STRAY_NOTE_LENGTH) break;
        const n = matchedNumber(SECTION_NUMBER.exec(hashLines[j]!));
        if (!n) continue;
        const k = normalizeSectionKey(n);
        if (k && !seenKeys.has(k) && sectionOrdinal(n) > sectionOrdinal(current.sectionNumber)) {
          current.hashHeadings.push(...hashLines.slice(0, j));
          displayLines.splice(0, j);
          hashLines.splice(0, j);
          sectionNumber = n;
        }
        break;
      }
    }

    if (!sectionNumber) {
      if (current) {
        // The portal splits long sections into several rows, each with its own marginal note
        // ("(2) …", "Provided that …", "Second Exception …"). They belong to the section above.
        if (hashHeading) current.hashHeadings.push(hashHeading);
        current.displayLines.push(...displayLines);
        current.hashLines.push(...hashLines);
        current.markers.push(...markers);
      } else if (!PREAMBLE_HEADING.test(hashHeading)) {
        warnings.push(`section block #${i}: no section number`);
        unnumbered.push({ sectionNumber: '1', key: '1', chapter, heading, hashHeadings: [hashHeading], displayLines: [...displayLines], hashLines: [...hashLines], markers: [...markers] });
      }
      return;
    }

    current = null; // set again below; never attach continuation rows to the wrong section
    for (const number of rangeNumbers ?? [sectionNumber]) {
      const key = normalizeSectionKey(number);
      if (!key || seenKeys.has(key)) {
        warnings.push(key ? `duplicate section key ${key}; kept the first occurrence` : `section block #${i}: bad section number`);
        continue;
      }
      seenKeys.add(key);
      // Each section of a range gets its own copy of the shared "[Repealed …]" text.
      current = {
        sectionNumber: number,
        key,
        chapter,
        heading,
        hashHeadings: [hashHeading],
        displayLines: [...displayLines],
        hashLines: [...hashLines],
        markers: [...markers],
      };
      drafts.push(current);
    }
  });

  // A one-section Act prints its only section without a number (The Districts Act, 1836): it is
  // section 1. Anything else unnumbered is reported, never guessed.
  if (title && !drafts.length && unnumbered.length === 1) {
    drafts.push(unnumbered[0]!);
    warnings.splice(warnings.findIndex((w) => w.endsWith(': no section number')), 1, 'single unnumbered section stored as section 1');
  }
  const sections = drafts.map((d) => finishSection(d, footnoteTexts, warnings));
  if (!sections.length) warnings.push('no sections parsed');

  const sample = `${title} ${sections[0]?.contentBody.slice(0, 500) ?? ''}`;
  const bn = sample.match(BN_LETTER)?.length ?? 0;
  const en = sample.match(LATIN_LETTER)?.length ?? 0;
  const asciiPreamble = toAsciiDigits(preamble);
  const actNumber = EN_ACT_NO.exec(asciiPreamble)?.[1] ?? BN_ACT_NO.exec(asciiPreamble)?.[1] ?? null;
  const dateText = /\[([^\]]{6,40})\]/.exec(preamble)?.[1];

  return {
    bdlawsActId: meta.bdlawsActId,
    sourceUrl: meta.sourceUrl,
    title,
    actNumber: actNumber ? normalizeForDisplay(actNumber) : null,
    language: bn > en ? 'BN' : 'EN',
    enactedDate: dateText ? parseLegalDate(dateText) : null,
    // The portal marks every section block of a repealed Act (`repealed` / `bn-repealed`); the title
    // usually doesn't say so. The text pattern is kept as a fallback.
    isRepealed:
      (sectionBlocks > 0 && repealedBlocks === sectionBlocks) ||
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the pattern comes from the scraper's source config (operator-controlled), not request input; it runs on one title + preamble
      new RegExp(cfg.repealedPattern, 'iu').test(`${title} ${preamble}`),
    sections,
    warnings,
  };
}

/** A section while its rows are being collected. */
interface SectionDraft {
  sectionNumber: string;
  key: string;
  chapter: string | null;
  heading: string | null;
  /** Marginal notes of every row, without footnote markers; all of them feed the content hash. */
  hashHeadings: string[];
  displayLines: string[];
  hashLines: string[];
  markers: string[];
}

function finishSection(d: SectionDraft, footnoteTexts: Map<string, string>, warnings: string[]): ParsedSection {
  const footnotes: ParsedFootnote[] = [];
  for (const n of [...new Set(d.markers)].sort((a, b) => +a - +b)) {
    const text = footnoteTexts.get(n);
    if (text) footnotes.push(parseFootnoteAction(text));
    else warnings.push(`section ${d.key}: footnote ${n} referenced but not found`);
  }
  return {
    sectionNumber: d.sectionNumber,
    normalizedSectionKey: d.key,
    chapterReference: d.chapter,
    marginalHeading: d.heading,
    contentBody: d.displayLines.join('\n'),
    parts: splitParts(d.hashLines),
    footnotes,
    // For a single-row section this is hash(heading, body), as before continuation rows existed.
    contentHash: hashSectionContent(d.hashHeadings.join('\n'), d.hashLines.join('\n')),
    footnotesHash: hashFootnotes(footnotes.map((f) => f.text)),
  };
}

/** "23 and 24" → [23, 24]; "100-103" → [100 … 103]. Null for a range that doesn't make sense. */
function expandRange(m: RegExpExecArray): string[] | null {
  const from = Number(m[1]);
  const to = Number(m[3]);
  if (!(to > from) || to - from > MAX_RANGE) return null;
  if (m[2] === 'and') return [String(from), String(to)];
  return Array.from({ length: to - from + 1 }, (_, k) => String(from + k));
}

function matchedNumber(m: RegExpExecArray | null): string | null {
  return m?.[1]?.replace(/\s+/g, '') || null;
}

/** Numeric part of a section number ("120B" → 120, "৫৬১ক" → 561). */
function sectionOrdinal(sectionNumber: string): number {
  return Number.parseInt(toAsciiDigits(sectionNumber), 10) || 0;
}

/** Footnote number → footnote text (number removed). */
function collectFootnotes($: cheerio.CheerioAPI, selector: string, markerSel: string): Map<string, string> {
  const out = new Map<string, string>();
  $(selector).each((_, el) => {
    const node = $(el);
    const marker = node.find(markerSel).first();
    let num = marker.length ? toAsciiDigits(marker.text()).replace(/\D/g, '') : '';
    let text = normalizeForDisplay((marker.length ? withoutMarkers(node, markerSel) : node).text());
    if (!num) {
      const lead = /^\s*([0-9০-৯]+)[.)]?\s+/u.exec(text);
      if (lead) {
        num = toAsciiDigits(lead[1]!);
        text = text.slice(lead[0].length);
      }
    }
    if (num && text && !out.has(num)) out.set(num, text);
  });
  return out;
}

function withoutMarkers(el: Cheerio<AnyNode>, markerSel: string): Cheerio<AnyNode> {
  const copy = el.clone();
  copy.find(markerSel).remove();
  return copy;
}

/**
 * One line per paragraph, whitespace-collapsed, empties dropped. Paragraphs are separated by
 * `lineBreakSel` elements (bdlaws uses <div class="clbr"> / <div class="na"> in English Acts) and by
 * block elements (<p> in Bangla Acts). Text outside any block element is kept.
 */
function paragraphs($: cheerio.CheerioAPI, el: Cheerio<AnyNode>, lineBreakSel: string): string[] {
  const copy = el.clone();
  copy.find(lineBreakSel).replaceWith('\n');
  copy.find('p, li, div, tr').each((_, b) => {
    $(b).before('\n').after('\n');
  });
  return copy.text().split('\n').map(normalizeForDisplay).filter(Boolean);
}

function splitParts(lines: string[]): SectionPart[] {
  return lines.map((line, idx) => {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- SECTION_NUMBER is linear-time (see its definition)
    const text = idx === 0 ? line.replace(SECTION_NUMBER, '').trim() : line;
    return classifyLine(text);
  });
}

/**
 * Classifies one paragraph of section text. Also used by the chunker (DATA-06) to split on
 * sub-section / proviso / explanation boundaries. Expects a line without the leading section number.
 */
export function classifyLine(text: string): SectionPart {
  const sub = SUBSECTION.exec(text);
  if (sub) return { kind: 'SUBSECTION', label: `(${sub[1]})`, text };
  if (PROVISO.test(text)) return { kind: 'PROVISO', label: null, text };
  if (EXPLANATION.test(text)) return { kind: 'EXPLANATION', label: null, text };
  if (ILLUSTRATION.test(text)) return { kind: 'ILLUSTRATION', label: null, text };
  return { kind: 'TEXT', label: null, text };
}

/** Removes the leading "420." / "৪২০।" section number from the first line of a section body. */
export function stripSectionNumber(line: string): string {
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- SECTION_NUMBER is linear-time (see its definition)
  return line.replace(SECTION_NUMBER, '').trim();
}
