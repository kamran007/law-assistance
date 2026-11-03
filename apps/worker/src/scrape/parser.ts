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
 * "420." / "৪২০।" / "[326A." / "561 A -" at the start of a section body. Inputs are already trimmed
 * and whitespace-collapsed. The pattern is anchored with bounded quantifiers and no two unbounded
 * quantifiers over the same characters, so matching is linear (no ReDoS).
 */
const SECTION_NUMBER = /^[[(]?\s?([0-9০-৯]{1,4}\s?[A-Zক-ঞ]{0,2})\s?[.।:-]/u;
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

  const title = normalizeForDisplay($(sel.title).first().text());
  if (!title) warnings.push('title not found');
  const preamble = $(sel.preamble)
    .toArray()
    .map((el) => normalizeForDisplay($(el).text()))
    .join(' ');

  const footnoteTexts = collectFootnotes($, sel.footnote, sel.footnoteMarker);
  const sections: ParsedSection[] = [];
  const seenKeys = new Set<string>();
  let chapter: string | null = null;

  $(`${sel.chapter}, ${sel.section}`).each((i, el) => {
    const node = $(el);
    if (!node.is(sel.section)) {
      chapter = normalizeForDisplay(node.text()) || chapter;
      return;
    }
    const headingEl = node.find(sel.sectionHeading).first();
    const bodyEl = node.find(sel.sectionBody).first();
    if (!bodyEl.length) {
      warnings.push(`section block #${i}: body selector matched nothing`);
      return;
    }

    const markers = new Set<string>();
    for (const m of [...headingEl.find(sel.footnoteMarker).toArray(), ...bodyEl.find(sel.footnoteMarker).toArray()]) {
      const n = toAsciiDigits($(m).text()).replace(/\D/g, '');
      if (n) markers.add(n);
    }

    const heading = normalizeForDisplay(headingEl.text()) || null;
    const displayLines = paragraphs($, bodyEl);
    // Footnote reference markers are stripped for hashing only (TRD §6.2 step 2).
    const hashLines = paragraphs($, withoutMarkers(bodyEl, sel.footnoteMarker));
    const hashHeading = headingEl.length ? normalizeForDisplay(withoutMarkers(headingEl, sel.footnoteMarker).text()) : '';

    const numberMatch = SECTION_NUMBER.exec(hashLines[0] ?? '') ?? SECTION_NUMBER.exec(hashHeading);
    const sectionNumber = numberMatch?.[1]?.replace(/\s+/g, '') ?? null;
    const key = sectionNumber ? normalizeSectionKey(sectionNumber) : null;
    if (!sectionNumber || !key) {
      warnings.push(`section block #${i}: no section number`);
      return;
    }
    if (seenKeys.has(key)) {
      warnings.push(`duplicate section key ${key}; kept the first occurrence`);
      return;
    }
    seenKeys.add(key);

    const footnotes: ParsedFootnote[] = [];
    for (const n of [...markers].sort((a, b) => +a - +b)) {
      const text = footnoteTexts.get(n);
      if (text) footnotes.push(parseFootnoteAction(text));
      else warnings.push(`section ${key}: footnote ${n} referenced but not found`);
    }

    sections.push({
      sectionNumber,
      normalizedSectionKey: key,
      chapterReference: chapter,
      marginalHeading: heading,
      contentBody: displayLines.join('\n'),
      parts: splitParts(hashLines),
      footnotes,
      contentHash: hashSectionContent(hashHeading, hashLines.join('\n')),
      footnotesHash: hashFootnotes(footnotes.map((f) => f.text)),
    });
  });

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
    isRepealed: new RegExp(cfg.repealedPattern, 'iu').test(`${title} ${preamble}`),
    sections,
    warnings,
  };
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

/** One line per <p>/<li>/<br>-separated paragraph, whitespace-collapsed, empties dropped. */
function paragraphs($: cheerio.CheerioAPI, el: Cheerio<AnyNode>): string[] {
  const copy = el.clone();
  copy.find('br').replaceWith('\n');
  const blocks = copy.find('p, li');
  const raw = blocks.length ? blocks.toArray().map((b) => $(b).text()) : [copy.text()];
  return raw
    .flatMap((t) => t.split('\n'))
    .map(normalizeForDisplay)
    .filter(Boolean);
}

function splitParts(lines: string[]): SectionPart[] {
  return lines.map((line, idx) => {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- SECTION_NUMBER is linear-time (see its definition)
    const text = idx === 0 ? line.replace(SECTION_NUMBER, '').trim() : line;
    const sub = SUBSECTION.exec(text);
    if (sub) return { kind: 'SUBSECTION', label: `(${sub[1]})`, text };
    if (PROVISO.test(text)) return { kind: 'PROVISO', label: null, text };
    if (EXPLANATION.test(text)) return { kind: 'EXPLANATION', label: null, text };
    if (ILLUSTRATION.test(text)) return { kind: 'ILLUSTRATION', label: null, text };
    return { kind: 'TEXT', label: null, text };
  });
}
