/** Bangla digits ০–৯ occupy U+09E6–U+09EF. */
const BN_ZERO = 0x09e6;

/** Convert Bangla digits to ASCII digits; other characters are untouched. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - BN_ZERO));
}

/** Convert ASCII digits to Bangla digits; other characters are untouched. */
export function toBanglaDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => String.fromCharCode(BN_ZERO + Number(d)));
}
