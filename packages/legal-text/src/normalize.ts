/**
 * Text normalization for amendment detection (TRD §6.2, FR-A2).
 *
 * `normalizeForHash` is ONLY used to compute content hashes. Display text is always stored verbatim.
 * Rules must stay stable: any change alters every hash and would look like a mass amendment
 * (the scraper's 20% safety valve would quarantine the run). Bump HASH_NORMALIZATION_VERSION when changing.
 *
 * Special characters are built from code points (not escape sequences) so invisible characters
 * are explicit and reviewable.
 */
export const HASH_NORMALIZATION_VERSION = 1;

const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const escapeForClass = (s: string) => s.replace(/[\]\\^-]/g, (c) => `\\${c}`);
const charClass = (codePoints: number[]) => `[${escapeForClass(ch(...codePoints))}]`;

const TA = 0x09a4;
const VIRAMA = 0x09cd;
const ZWJ = 0x200d;
const KHANDA_TA = 0x09ce;

/** Khanda-ta written as TA + VIRAMA + ZWJ (legacy encoding) → U+09CE. */
const LEGACY_KHANDA_TA = new RegExp(ch(TA, VIRAMA, ZWJ), 'g');

/** Zero-width chars that affect rendering only: ZWSP, ZWNJ, ZWJ, WORD JOINER, BOM. */
const ZERO_WIDTH = new RegExp(charClass([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]), 'g');

/** Unicode whitespace beyond \s coverage differences: NBSP, en/em/thin spaces, LS/PS, NNBSP, MMSP, ideographic. */
const EXTRA_SPACES = [0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
const ANY_WHITESPACE = new RegExp(`(?:\\s|${charClass(EXTRA_SPACES)})+`, 'g');

/** Typographic quotes/dashes that differ between portal revisions → ASCII. */
const PUNCT_MAP = new Map<string, string>([
  ...[0x2018, 0x2019, 0x201a, 0x201b].map((c) => [ch(c), "'"] as const),
  ...[0x201c, 0x201d, 0x201e, 0x201f].map((c) => [ch(c), '"'] as const),
  ...[0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212].map((c) => [ch(c), '-'] as const),
]);
const PUNCT_RE = new RegExp(charClass([...PUNCT_MAP.keys()].map((k) => k.codePointAt(0)!)), 'g');

export function normalizeForHash(text: string): string {
  return (
    text
      // Fix legacy khanda-ta before removing ZWJ (otherwise TA + VIRAMA would remain).
      .replace(LEGACY_KHANDA_TA, ch(KHANDA_TA))
      // NFC also unifies য়/ড়/ঢ় (composition-excluded → canonical decomposed form).
      .normalize('NFC')
      .replace(ZERO_WIDTH, '')
      .replace(PUNCT_RE, (c) => PUNCT_MAP.get(c) ?? c)
      .replace(ANY_WHITESPACE, ' ')
      .trim()
  );
}

/** Light normalization for display/search input: NFC + whitespace collapse, keeps everything else. */
export function normalizeForDisplay(text: string): string {
  return text.normalize('NFC').replace(ANY_WHITESPACE, ' ').trim();
}
