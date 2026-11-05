/**
 * Detects legacy Bijoy/ANSI-encoded Bangla (TRD §8.2 stage 2). Bijoy fonts (SutonnyMJ and the other
 * "…MJ" fonts) draw Bangla glyphs over ASCII/Latin-1 code points, so text extracted from such a
 * document comes out as Latin letters mixed with symbols like ‡ † ˆ © ¯ and contains no Bengali
 * script at all. Conversion to Unicode is DATA-11; this only decides whether it is needed.
 */

/** Font names used for Bijoy text ("SutonnyMJ", "SutonnyOMJ", "AdorshoLipiMJ" …). */
const BIJOY_FONT = /sutonny|bijoy|MJ(?:[-_ ]?(?:Bold|Italic|Regular|BoldItalic))?$/i;

/**
 * Latin-1 / Windows-1252 symbols that Bijoy maps to frequent Bangla vowel signs and conjuncts
 * (e.g. ‡ and † for the e-kar, ˆ for the ai-kar). Built from code points so the source shows which.
 */
const BIJOY_MARKS = new Set(
  [
    0x2021, 0x2020, 0x02c6, 0x2030, 0x0160, 0x00a9, 0x00af, 0x00a8, 0x00a6, 0x00a4, 0x00a2, 0x00a1, 0x00ff, 0x00b1, 0x00b0, 0x00b5, 0x00b8,
    // ` (da), Û (nda), Ö (the r-phala in pra): very frequent in Bijoy, rare in English legal text.
    0x0060, 0x00db, 0x00d6,
  ].map((c) => String.fromCodePoint(c)),
);

const BENGALI = /\p{Script=Bengali}/u;

export interface BijoyEvidence {
  text: string;
  /** Font names from the document (pdffonts / DOCX styles), if known. */
  fontNames?: string[];
}

/** Minimum share of Bijoy marks among non-space characters for text-only detection. */
export const BIJOY_MARK_RATIO = 0.02;

export function looksLikeBijoy({ text, fontNames = [] }: BijoyEvidence): boolean {
  if (fontNames.some((f) => BIJOY_FONT.test(f.replace(/^[A-Z]{6}\+/, '')))) return true; // strip PDF subset prefix "ABCDEF+"
  const sample = text.slice(0, 20_000);
  if (BENGALI.test(sample)) return false; // real Unicode Bangla is present
  let chars = 0;
  let marks = 0;
  for (const ch of sample) {
    if (/\s/u.test(ch)) continue;
    chars++;
    if (BIJOY_MARKS.has(ch)) marks++;
  }
  return chars >= 20 && marks >= 2 && marks / chars >= BIJOY_MARK_RATIO;
}
