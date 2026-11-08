import { toAsciiDigits } from './digits';
import { normalizeSectionKey } from './section-key';
import { detectSections, resolveActName, uniqueCitations, type DetectedAct, type SectionCitation } from './section-detector';

/**
 * Detector + LLM merge (TRD §8.2 stage 4, BE-24). The deterministic detector is authoritative: every
 * section it finds is kept. A section that only the LLM proposed is kept only if the text the LLM
 * quoted for it (`raw`) really occurs in the document and contains that section number; otherwise
 * it is rejected and reported, never silently added.
 */
export interface LlmCitedSection {
  act_hint: string | null;
  section: string;
  raw: string;
}

export type SectionSource = 'DETECTOR' | 'DETECTOR_AND_LLM' | 'LLM_QUOTE_IN_TEXT' | 'USER_CORRECTED';

export interface MergedSection {
  /** Normalized section key: "302", "561A", "11". */
  key: string;
  /** As written in the document. */
  section: string;
  subsection: string | null;
  act: DetectedAct | null;
  actInferred: boolean;
  citedTogether: string[];
  source: SectionSource;
}

export interface RejectedSection {
  section: string;
  actHint: string | null;
  reason: 'NOT_FOUND_IN_TEXT' | 'UNREADABLE_SECTION' | 'ACT_MISMATCH';
}

export interface MergeResult {
  sections: MergedSection[];
  rejected: RejectedSection[];
}

/** Same Act, or the LLM named none / one the dictionary does not know. */
const actAgrees = (hint: DetectedAct | null, found: DetectedAct | null) => !hint || !found || hint.key === found.key;

const comparable = (s: string) => toAsciiDigits(s.normalize('NFC')).replace(/\s+/g, ' ').trim().toLowerCase();

export function mergeCitedSections(text: string, llm: LlmCitedSection[], opts: { defaultAct?: 'PENAL_CODE' | null } = {}): MergeResult {
  const detected = uniqueCitations(detectSections(text, { defaultAct: opts.defaultAct ?? null }));
  const sections: MergedSection[] = detected.map((c) => fromDetector(c));
  const rejected: RejectedSection[] = [];
  const haystack = comparable(text);

  for (const proposal of llm) {
    const key = normalizeSectionKey(proposal.section.trim());
    if (!key) {
      rejected.push({ section: proposal.section, actHint: proposal.act_hint, reason: 'UNREADABLE_SECTION' });
      continue;
    }
    const hint = resolveActName(proposal.act_hint);
    const match = sections.find((s) => s.key === key && actAgrees(hint, s.act));
    if (match) {
      if (match.source === 'DETECTOR') match.source = 'DETECTOR_AND_LLM';
      continue;
    }
    // The detector read this number under another Act ("19A of the Arms Act", LLM says Penal Code):
    // the detector's reading of the text wins.
    if (sections.some((s) => s.key === key && s.source !== 'LLM_QUOTE_IN_TEXT')) {
      rejected.push({ section: proposal.section, actHint: proposal.act_hint, reason: 'ACT_MISMATCH' });
      continue;
    }
    const quote = comparable(proposal.raw ?? '');
    const number = key.match(/^\d+/)?.[0];
    const numbersInQuote: string[] = quote.match(/\d+/g) ?? [];
    const quoteHasNumber = number !== undefined && numbersInQuote.includes(number);
    if (quote.length >= 3 && quoteHasNumber && haystack.includes(quote)) {
      const act = hint ?? (opts.defaultAct === 'PENAL_CODE' ? resolveActName('Penal Code') : null);
      sections.push({ key, section: proposal.section.trim(), subsection: null, act, actInferred: !hint && !!act, citedTogether: [], source: 'LLM_QUOTE_IN_TEXT' });
      continue;
    }
    rejected.push({ section: proposal.section, actHint: proposal.act_hint, reason: 'NOT_FOUND_IN_TEXT' });
  }
  return { sections, rejected };
}

function fromDetector(c: SectionCitation): MergedSection {
  return {
    key: c.key,
    section: c.section,
    subsection: c.subsection,
    act: c.act,
    actInferred: c.actInferred,
    citedTogether: c.citedTogether,
    source: 'DETECTOR',
  };
}

/**
 * Sections the user corrected (TRD §8.5; BE-26). They replace the detector's reading: the user
 * fixes exactly what OCR or the detector got wrong ("৩২৮" misread for "৩২৩"). "11(গ)" keeps its
 * clause as the sub-section; an unnamed Act gets the FIR default, flagged as inferred.
 */
export function userCitedSections(list: { act_hint: string | null; section: string }[], opts: { defaultAct?: 'PENAL_CODE' | null } = {}): MergeResult {
  const sections: MergedSection[] = [];
  const rejected: RejectedSection[] = [];
  const fallback = opts.defaultAct === 'PENAL_CODE' ? resolveActName('Penal Code') : null;
  for (const item of list) {
    const raw = item.section.normalize('NFC').trim();
    const m = /^([^(]+?)\s*((?:\([^)]{1,8}\)\s*){0,3})$/u.exec(raw);
    const key = m ? normalizeSectionKey(m[1]!.trim()) : null;
    if (!m || !key) {
      rejected.push({ section: item.section, actHint: item.act_hint, reason: 'UNREADABLE_SECTION' });
      continue;
    }
    const hint = resolveActName(item.act_hint);
    const act = hint ?? fallback;
    const subsection = m[2] ? toAsciiDigits(m[2]).replace(/\s+/g, '') : null;
    if (sections.some((s) => s.key === key && s.subsection === subsection && s.act?.key === act?.key)) continue;
    sections.push({ key, section: m[1]!.trim(), subsection, act, actInferred: !hint && !!act, citedTogether: [], source: 'USER_CORRECTED' });
  }
  return { sections, rejected };
}
