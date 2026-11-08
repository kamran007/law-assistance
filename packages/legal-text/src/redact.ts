/**
 * Data minimization before LLM calls (TRD §7.6): phone and national ID numbers are replaced by
 * placeholders. Neither is needed to read an FIR's offences, dates or parties. Bangla and ASCII
 * digits are both handled; dates, case / GR numbers and section numbers are left alone.
 */
export const PHONE_PLACEHOLDER = '[ফোন নম্বর]';
export const NID_PLACEHOLDER = '[NID]';

const D = '[0-9০-৯]';
const SEP = '[-\\s.]?';
/** Bangladeshi mobile: 01[3-9] + 8 digits, optional +88 / 88 / ০০৮৮ prefix, optional separators. */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const PHONE = new RegExp(`(?<![0-9০-৯])(?:(?:\\+|00|০০)?(?:88|৮৮)${SEP})?[0০]${SEP}[1১]${SEP}[3-9৩-৯](?:${SEP}${D}){8}(?![0-9০-৯])`, 'gu');
/** NID: 10, 13 or 17 digits in one run (smart card, old 13-digit, 17-digit with birth year). */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const NID = new RegExp(`(?<![0-9০-৯/])(?:${D}{17}|${D}{13}|${D}{10})(?![0-9০-৯/])`, 'gu');

export interface RedactionResult {
  text: string;
  phones: number;
  nids: number;
}

export function redactContactIds(input: string): RedactionResult {
  let phones = 0;
  let nids = 0;
  const text = input
    .replace(PHONE, () => {
      phones++;
      return PHONE_PLACEHOLDER;
    })
    .replace(NID, () => {
      nids++;
      return NID_PLACEHOLDER;
    });
  return { text, phones, nids };
}
