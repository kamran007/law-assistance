/**
 * SCOB pages declare UTF-8, but rows of the older list template contain raw Windows-1252 bytes
 * (smart quotes 0x91–0x94, dashes 0x96/0x97) mixed into otherwise valid UTF-8 — seen on issues
 * 1–14 (JUD-01, 2026-11-08). Decoding the whole page as UTF-8 turns them into U+FFFD. This decoder
 * keeps every valid UTF-8 sequence and reads each invalid byte as Windows-1252 instead.
 */
const CP1252_C1: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const cp1252 = (b: number) => String.fromCodePoint(b >= 0x80 && b <= 0x9f ? (CP1252_C1[b] ?? 0xfffd) : b);

/** Length of a valid UTF-8 sequence starting at `i`, or 0 if the bytes there aren't one. */
function utf8SeqLength(bytes: Uint8Array, i: number): number {
  const b = bytes[i]!;
  const need = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
  if (need === 0 || i + need > bytes.length) return 0;
  for (let k = 1; k < need; k++) if ((bytes[i + k]! & 0xc0) !== 0x80) return 0;
  // Overlong / surrogate / out-of-range forms are not valid UTF-8.
  const b1 = bytes[i + 1]!;
  if (b === 0xe0 && b1 < 0xa0) return 0;
  if (b === 0xed && b1 > 0x9f) return 0;
  if (b === 0xf0 && b1 < 0x90) return 0;
  if (b === 0xf4 && b1 > 0x8f) return 0;
  return need;
}

export function decodeMixedUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Mixed page: walk it.
  }
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let start = 0;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b < 0x80) {
      i++;
      continue;
    }
    const len = utf8SeqLength(bytes, i);
    if (len > 0) {
      i += len;
      continue;
    }
    out += decoder.decode(bytes.subarray(start, i)) + cp1252(b);
    i++;
    start = i;
  }
  return out + decoder.decode(bytes.subarray(start));
}
