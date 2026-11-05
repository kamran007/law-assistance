export { toAsciiDigits, toBanglaDigits } from './digits';
export { normalizeForHash, normalizeForDisplay, HASH_NORMALIZATION_VERSION } from './normalize';
export { normalizeSectionKey } from './section-key';
export { hashSectionContent, hashFootnotes } from './hash';
export { parseFootnoteAction, parseLegalDate, type ParsedFootnote, type FootnoteAction } from './footnote';
export { looksLikeBijoy, BIJOY_MARK_RATIO, type BijoyEvidence } from './bijoy';
export { convertBijoyToUnicode, convertBijoyDocument } from './bijoy-convert';
export { ACT_DICTIONARY, DEFAULT_FIR_ACT, type ActEntry } from './act-dictionary';
export { detectSections, uniqueCitations, type SectionCitation, type DetectedAct, type DetectOptions } from './section-detector';
