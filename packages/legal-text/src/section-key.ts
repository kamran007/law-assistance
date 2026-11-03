import { toAsciiDigits } from './digits';

/**
 * Bangla sub-section letters used for inserted sections (e.g. ৩২৬ক = 326A) map to Latin letters
 * in consonant order. Confirm the ordering with the legal SME when parsing statutes that go past ঙ.
 */
const BN_LETTER_TO_LATIN: Record<string, string> = {
  'ক': 'A', 'খ': 'B', 'গ': 'C', 'ঘ': 'D', 'ঙ': 'E',
  'চ': 'F', 'ছ': 'G', 'জ': 'H', 'ঝ': 'I', 'ঞ': 'J',
};

const PREFIX = /^(?:section|sec|s|ধারা|অনুচ্ছেদ|article|art|rule|বিধি|u\/s)\.?\s*/i;

/**
 * Normalize a section identifier to the ASCII key stored in `statute_sections.normalized_section_key`.
 *   "৫৬১ক" → "561A", "Sec. 302" → "302", "561 - a" → "561A", "ধারা ৪২০" → "420"
 * Returns null if the input does not look like a single section identifier.
 */
export function normalizeSectionKey(raw: string): string | null {
  let s = raw.normalize('NFC').trim();
  s = s.replace(PREFIX, '');
  s = toAsciiDigits(s);
  s = s.replace(/[ক-ঞ]/g, (c) => BN_LETTER_TO_LATIN[c] ?? c);
  s = s.replace(/[\s\-–—.()]/g, '').toUpperCase();
  return /^\d{1,4}[A-Z]{0,2}$/.test(s) ? s : null;
}
