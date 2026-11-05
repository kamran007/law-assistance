/**
 * Bijoy (SutonnyMJ and the other "…MJ" fonts) → Unicode Bangla (TRD §8.2 stage 2, DATA-11).
 *
 * Bijoy fonts draw Bangla glyphs over ASCII / Windows-1252 code points and store text in VISUAL
 * order: the pre-base vowel signs ি ে ৈ come before the consonant cluster they belong to, and the
 * reph (র্) comes after it. Conversion is therefore two steps:
 *   1. tokenize with the glyph table below (longest match, a few glyphs depend on what precedes them);
 *   2. rebuild Unicode logical order cluster by cluster: pre-base vowels move after the cluster
 *      (ে…া → ো, ে…ৗ → ৌ), the reph moves before it, and chandrabindu goes after the vowel sign.
 *
 * The table was written for this project and cross-checked against two published converters
 * (bahar/BijoyToUnicode, the bijoy2unicode npm package). Where they disagree with each other or
 * with SutonnyMJ as typed today, the choice is noted next to the glyph.
 *
 * Limitation: the converter sees text, not fonts. English words that a Bijoy document set in an
 * English font come out as Bangla letters ("Section" → garbage), because pdftotext does not say
 * which font each word used. Bengali-script characters already in the input pass through unchanged.
 */

type Kind =
  | 'C' // consonant or full conjunct: starts a cluster (ক, ক্ষ, গু …)
  | 'H' // half form ending in hasanta, glues to what follows (ন্, স্, ম্ …)
  | 'S' // subscript sign starting with hasanta, glues to what precedes (্র, ্য, ্ব …)
  | 'PRE' // pre-base vowel sign: ি ে ৈ
  | 'POST' // other vowel signs: া ী ু ূ ৃ ৗ
  | 'MOD' // ং ঃ ঁ
  | 'REPH' // র্ written after its cluster
  | 'X'; // anything else: independent vowels, digits, punctuation, spaces

interface Glyph {
  u: string;
  kind: Kind;
}

const g = (u: string, kind: Kind): Glyph => ({ u, kind });

/** Single ASCII keys. */
const ASCII: Record<string, Glyph> = {
  A: g('অ', 'X'), B: g('ই', 'X'), C: g('ঈ', 'X'), D: g('উ', 'X'), E: g('ঊ', 'X'), F: g('ঋ', 'X'),
  G: g('এ', 'X'), H: g('ঐ', 'X'), I: g('ও', 'X'), J: g('ঔ', 'X'),
  K: g('ক', 'C'), L: g('খ', 'C'), M: g('গ', 'C'), N: g('ঘ', 'C'), O: g('ঙ', 'C'),
  P: g('চ', 'C'), Q: g('ছ', 'C'), R: g('জ', 'C'), S: g('ঝ', 'C'), T: g('ঞ', 'C'),
  U: g('ট', 'C'), V: g('ঠ', 'C'), W: g('ড', 'C'), X: g('ঢ', 'C'), Y: g('ণ', 'C'),
  Z: g('ত', 'C'), _: g('থ', 'C'), '`': g('দ', 'C'), a: g('ধ', 'C'), b: g('ন', 'C'),
  c: g('প', 'C'), d: g('ফ', 'C'), e: g('ব', 'C'), f: g('ভ', 'C'), g: g('ম', 'C'),
  h: g('য', 'C'), i: g('র', 'C'), j: g('ল', 'C'), k: g('শ', 'C'), l: g('ষ', 'C'),
  m: g('স', 'C'), n: g('হ', 'C'), o: g('ড়', 'C'), p: g('ঢ়', 'C'), q: g('য়', 'C'), r: g('ৎ', 'C'),
  s: g('ং', 'MOD'), t: g('ঃ', 'MOD'), u: g('ঁ', 'MOD'),
  v: g('া', 'POST'), w: g('ি', 'PRE'), x: g('ী', 'POST'), y: g('ু', 'POST'), z: g('ু', 'POST'), '~': g('ূ', 'POST'),
  '|': g('।', 'X'),
  '&': g(`্${String.fromCodePoint(0x200c)}`, 'X'), // visible hasanta: ZWNJ stops a conjunct forming
  '^': g('্ব', 'S'),
  '0': g('০', 'X'), '1': g('১', 'X'), '2': g('২', 'X'), '3': g('৩', 'X'), '4': g('৪', 'X'),
  '5': g('৫', 'X'), '6': g('৬', 'X'), '7': g('৭', 'X'), '8': g('৮', 'X'), '9': g('৯', 'X'),
};

/** Windows-1252 / Latin-1 glyphs, by code point. */
const EXTENDED: [number, Glyph][] = [
  [0x2022, g('ঙ্', 'H')], // •
  [0x201e, g('ৃ', 'POST')], // „
  [0x2026, g('ৃ', 'POST')], // …
  [0x2020, g('ে', 'PRE')], // †
  [0x2021, g('ে', 'PRE')], // ‡
  [0x02c6, g('ৈ', 'PRE')], // ˆ
  [0x2030, g('ৈ', 'PRE')], // ‰
  [0x0160, g('ৗ', 'POST')], // Š (ou length mark: ‡KŠ = কৌ)
  [0x2039, g('্ক', 'S')], // ‹
  [0x0152, g('্ক্র', 'S')], // Œ
  [0x201d, g('চ্', 'H')], // ”
  [0x02dc, g('দ্', 'H')], // ˜
  [0x2122, g('দ্', 'H')], // ™
  [0x0161, g('ন্', 'H')], // š
  [0x203a, g('ন্', 'H')], // ›
  [0x0153, g('্ন', 'S')], // œ
  [0x0178, g('্ব', 'S')], // Ÿ
  [0x00a1, g('্ব', 'S')], // ¡
  [0x00a2, g('্ভ', 'S')], // ¢
  [0x00a3, g('্ভ্র', 'S')], // £
  [0x00a4, g('ম্', 'H')], // ¤
  [0x00a5, g('্ম', 'S')], // ¥
  [0x00a6, g('্ব', 'S')], // ¦
  [0x00a7, g('্ম', 'S')], // §
  [0x00a8, g('্য', 'S')], // ¨ ya-phala
  [0x00a9, g('র্', 'REPH')], // ©
  [0x00aa, g('্র', 'S')], // ª
  [0x00ab, g('্র', 'S')], // «
  [0x00ac, g('্ল', 'S')], // ¬
  [0x00ad, g('্ল', 'S')], // soft hyphen
  [0x00ae, g('ষ্', 'H')], // ®
  [0x00af, g('স্', 'H')], // ¯
  [0x00b0, g('ক্ক', 'C')],
  [0x00b1, g('ক্ট', 'C')],
  [0x00b2, g('ক্ষ্ণ', 'C')],
  [0x00b3, g('ক্ত', 'C')],
  [0x00b4, g('ক্ম', 'C')],
  [0x00b5, g('ক্র', 'C')],
  [0x00b6, g('ক্ষ', 'C')], // ¶ older SutonnyMJ; ÿ in current versions
  [0x00b7, g('ক্স', 'C')],
  [0x00b8, g('গু', 'C')],
  [0x00b9, g('গ্ম', 'C')], // ¹ as in hy¹ = যুগ্ম; both reference tables say জ্ঞ, which is Á
  [0x00ba, g('গ্দ', 'C')],
  [0x00bb, g('গ্ধ', 'C')],
  [0x00bc, g('ঙ্ক', 'C')],
  [0x00bd, g('ঙ্গ', 'C')],
  [0x00be, g('জ্জ', 'C')],
  [0x00bf, g('্ত্র', 'S')], // ¿ (¯¿ = স্ত্র, š¿ = ন্ত্র)
  [0x00c0, g('জ্ঝ', 'C')],
  [0x00c1, g('জ্ঞ', 'C')],
  [0x00c2, g('ঞ্চ', 'C')],
  [0x00c3, g('ঞ্ছ', 'C')],
  [0x00c4, g('ঞ্জ', 'C')],
  [0x00c5, g('ঞ্ঝ', 'C')],
  [0x00c6, g('ট্ট', 'C')],
  [0x00c7, g('ড্ড', 'C')],
  [0x00c8, g('ণ্ট', 'C')],
  [0x00c9, g('ণ্ঠ', 'C')],
  [0x00ca, g('ণ্ড', 'C')],
  [0x00cb, g('ত্ত', 'C')],
  [0x00cc, g('ত্থ', 'C')],
  // 0x00cd Í: contextual, see CONTEXTUAL
  [0x00ce, g('ত্র', 'C')],
  [0x00cf, g('দ্দ', 'C')],
  [0x00d0, g('ণ্ড', 'C')], // Ð as in Kg©Kv‡Ð = কর্মকাণ্ডে (real gazettes); both reference tables say "-"
  [0x00d1, g('-', 'X')],
  [0x00d2, g('"', 'X')],
  [0x00d3, g('"', 'X')],
  [0x00d4, g("'", 'X')],
  [0x00d5, g("'", 'X')],
  [0x00d6, g('্র', 'S')], // Ö r-phala (cÖ = প্র)
  [0x00d7, g('দ্ধ', 'C')],
  [0x00d8, g('দ্ব', 'C')],
  [0x00d9, g('দ্ম', 'C')],
  [0x00da, g('ন্ঠ', 'C')],
  [0x00db, g('ন্ড', 'C')],
  [0x00dc, g('ন্ধ', 'C')],
  [0x00dd, g('ন্স', 'C')],
  [0x00de, g('প্ট', 'C')],
  [0x00df, g('প্ত', 'C')],
  [0x00e0, g('প্প', 'C')],
  [0x00e1, g('প্স', 'C')],
  [0x00e2, g('ব্জ', 'C')],
  [0x00e3, g('ব্দ', 'C')],
  [0x00e4, g('ব্ধ', 'C')],
  [0x00e5, g('ভ্র', 'C')],
  [0x00e6, g('ু', 'POST')], // æ u-kar after র (iæ = রু); the older table's ম্ন is written gœ
  [0x00e7, g('ম্ফ', 'C')],
  [0x00e8, g('্ণ', 'S')], // è (nè = হ্ণ); the reference tables repeat œ's ্ন here
  [0x00e9, g('ল্ক', 'C')],
  [0x00ea, g('ল্গ', 'C')],
  [0x00eb, g('ল্ট', 'C')],
  [0x00ec, g('ল্ড', 'C')],
  [0x00ed, g('ল্প', 'C')],
  [0x00ee, g('ল্ফ', 'C')],
  [0x00ef, g('শু', 'C')],
  [0x00f0, g('শ্চ', 'C')],
  [0x00f1, g('শ্ছ', 'C')],
  [0x00f2, g('ষ্ণ', 'C')],
  [0x00f3, g('ষ্ট', 'C')],
  [0x00f4, g('ষ্ঠ', 'C')],
  [0x00f5, g('ষ্ফ', 'C')],
  [0x00f6, g('স্খ', 'C')],
  [0x00f7, g('স্ট', 'C')],
  // 0x00f8 ø: contextual, see CONTEXTUAL
  [0x00f9, g('স্ফ', 'C')],
  [0x00fa, g('্প', 'S')], // ú (¤ú = ম্প)
  [0x00fb, g('হু', 'C')],
  [0x00fc, g('হৃ', 'C')],
  [0x00fd, g('হ্ন', 'C')],
  [0x00fe, g('হ্ম', 'C')],
  [0x00ff, g('ক্ষ', 'C')], // ÿ (wkÿv = শিক্ষা)
  [0xf8e7, g('—', 'X')], // Symbol-font dash extender in gazettes: "msÁv|(1)" = "সংজ্ঞা।—(১)"
];

/**
 * Glyphs whose reading depends on what precedes them. Several are also ordinary punctuation that
 * Bijoy documents set in an English font (“quotes”, – and — dashes), so they only count as Bangla
 * when they follow what they attach to.
 */
const AFTER_CONSONANT: Kind[] = ['C', 'H', 'S'];
const AFTER_HALF: Kind[] = ['H'];
const CONTEXTUAL: [number, attachesAfter: Kind[], attached: Glyph, alone: Glyph][] = [
  [0x00f8, AFTER_CONSONANT, g('্ল', 'S'), g('স্ন', 'C')], // ø: Mø = গ্ল, DwjøwLZ = উল্লিখিত; †øn = স্নেহ
  [0x00cd, AFTER_CONSONANT, g('্ত', 'S'), g('ত্ম', 'C')], // Í: šÍ = ন্ত, ¯Í = স্ত
  [0x0027, AFTER_HALF, g('্থ', 'S'), g("'", 'X')], // ': ¯' = স্থ (e¨e¯'v = ব্যবস্থা)
  [0x2019, AFTER_HALF, g('্থ', 'S'), g(String.fromCodePoint(0x2019), 'X')], // ’: ¯’vcb = স্থাপন, cwicš’x = পরিপন্থী
  [0x2018, AFTER_HALF, g('্তু', 'S'), g(String.fromCodePoint(0x2018), 'X')], // ‘: cÖ¯‘Z = প্রস্তুত
  [0x2014, AFTER_HALF, g('্ত', 'S'), g(String.fromCodePoint(0x2014), 'X')], // —: š— = ন্ত; "|—(1)" is a dash
  [0x201c, AFTER_CONSONANT, g('ু', 'POST'), g(String.fromCodePoint(0x201c), 'X')], // “: i“ = রু
  [0x2013, AFTER_CONSONANT, g('ু', 'POST'), g(String.fromCodePoint(0x2013), 'X')], // –
  [0x0192, AFTER_CONSONANT, g('ূ', 'POST'), g(String.fromCodePoint(0x0192), 'X')], // ƒ: iƒc = রূপ
  [0x201a, AFTER_CONSONANT, g('ূ', 'POST'), g(String.fromCodePoint(0x201a), 'X')], // ‚
];

const TABLE = new Map<string, Glyph>(Object.entries(ASCII));
for (const [cp, glyph] of EXTENDED) TABLE.set(String.fromCodePoint(cp), glyph);
const CONTEXT = new Map(CONTEXTUAL.map(([cp, after, attached, alone]) => [String.fromCodePoint(cp), { after, attached, alone }]));
const AA = g('আ', 'X'); // "Av": অ + া-kar glyph

/** PDF text sometimes carries Windows-1252 bytes 0x80–0x9F as C1 controls instead of ‡ † ˆ …. */
const C1_TO_CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const E_KAR = 'ে';
const HASANTA = '্';
const CHANDRABINDU = 'ঁ';
// A vowel sign followed by chandrabindu is the Unicode order (চাঁদ), so ঁ moves after the sign.
const VOWEL_SIGN = `[${String.fromCodePoint(0x09be)}-${String.fromCodePoint(0x09cc)}${String.fromCodePoint(0x09d7)}]`;
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const CHANDRABINDU_BEFORE_SIGN = new RegExp(`${CHANDRABINDU}(${VOWEL_SIGN})`, 'gu');
const CONSONANT = `[${String.fromCodePoint(0x0995)}-${String.fromCodePoint(0x09b9)}${String.fromCodePoint(0x09dc)}-${String.fromCodePoint(0x09df)}]`;
/**
 * Bijoy draws some subscripts after the vowel sign (Ab~¨b, GZÏv¦iv); Unicode puts the subscript
 * first: অন্যূন, এতদ্দ্বারা. A vowel sign is never followed by a hasanta in valid Unicode.
 */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants
const SIGN_BEFORE_SUBSCRIPT = new RegExp(`((?:${VOWEL_SIGN}|${CHANDRABINDU}){1,2})((?:${HASANTA}${CONSONANT}){1,2})`, 'gu');
const ZWNJ = String.fromCodePoint(0x200c);
/** URLs and e-mail addresses are set in an English font even in Bijoy documents: left as they are. */
// The lookbehind makes an address start only at the beginning of a run: Bijoy text is mostly
// ASCII letters, and without it every position of a long run would be retried (quadratic).
const KEEP_AS_IS = /((?:https?:\/\/|www\.)[^\s"'<>]+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/giu;

interface Token extends Glyph {
  src: string;
}

function tokenize(text: string): Token[] {
  const chars = Array.from(text, (ch) => {
    const cp = ch.codePointAt(0)!;
    return C1_TO_CP1252[cp] ? String.fromCodePoint(C1_TO_CP1252[cp]) : ch;
  });
  const out: Token[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const prev = out[out.length - 1];
    if (ch === 'A' && chars[i + 1] === 'v') {
      out.push({ ...AA, src: 'Av' });
      i++;
      continue;
    }
    const ctx = CONTEXT.get(ch);
    if (ctx) {
      const attached = prev !== undefined && ctx.after.includes(prev.kind);
      out.push({ ...(attached ? ctx.attached : ctx.alone), src: ch });
      continue;
    }
    const glyph = TABLE.get(ch);
    // Repeated kar typed twice by mistake (yy, vv, „„) shows once in the font: keep one.
    if (glyph && prev && prev.src === ch && (glyph.kind === 'POST' || glyph.kind === 'PRE')) continue;
    out.push(glyph ? { ...glyph, src: ch } : { u: ch, kind: 'X', src: ch });
  }
  return out;
}

/** Reads a consonant cluster starting at `i`; returns its text and the index after it. */
function readCluster(tokens: Token[], i: number): { text: string; next: number } {
  let text = tokens[i]!.u;
  let j = i + 1;
  for (;;) {
    const t = tokens[j];
    if (!t) break;
    const glued = text.endsWith(HASANTA) && (t.kind === 'C' || t.kind === 'H' || t.kind === 'S');
    if (!glued && t.kind !== 'S') break;
    text += t.u;
    j++;
  }
  return { text: text.replaceAll(HASANTA + HASANTA, HASANTA), next: j };
}

const BENGALI_SCRIPT = /\p{Script=Bengali}/u;

/**
 * Converts a whole extracted document that `looksLikeBijoy` flagged. Lines that already contain
 * Bengali script came from a Unicode font (a Nikosh heading in a SutonnyMJ gazette, say) and are
 * left alone, so their English words and ASCII digits are not turned into Bangla letters.
 */
export function convertBijoyDocument(text: string): string {
  return text
    .split('\n')
    .map((line) => (BENGALI_SCRIPT.test(line) ? line : convertBijoyToUnicode(line)))
    .join('\n');
}

export function convertBijoyToUnicode(input: string): string {
  // Odd indices of the split are the URL / e-mail matches.
  return input
    .split(KEEP_AS_IS)
    .map((part, i) => (i % 2 ? part : convertRun(part)))
    .join('');
}

function convertRun(input: string): string {
  if (!input) return input;
  const tokens = tokenize(input);
  const out: string[] = [];
  let clusterAt = -1; // index in `out` where the current syllable's cluster starts

  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i]!;
    if (t.kind === 'PRE') {
      // ‡ [u] cluster [v|Š] → cluster + vowel sign [+ ঁ]
      let j = i + 1;
      const mods: string[] = [];
      while (tokens[j]?.kind === 'MOD' && tokens[j]!.u === CHANDRABINDU) mods.push(tokens[j++]!.u);
      const head = tokens[j];
      if (head && (head.kind === 'C' || head.kind === 'H')) {
        const c = readCluster(tokens, j);
        clusterAt = out.length;
        out.push(c.text);
        let sign = t.u;
        let next = c.next;
        const after = tokens[next];
        if (t.u === E_KAR && after?.kind === 'POST' && (after.u === 'া' || after.u === 'ৗ')) {
          sign = after.u === 'া' ? 'ো' : 'ৌ';
          next++;
        }
        out.push(sign, ...mods);
        i = next;
        continue;
      }
      out.push(t.u, ...mods);
      clusterAt = -1;
      i = j;
      continue;
    }
    if (t.kind === 'C' || t.kind === 'H') {
      const c = readCluster(tokens, i);
      clusterAt = out.length;
      out.push(c.text);
      i = c.next;
      continue;
    }
    if (t.kind === 'REPH') {
      // Bijoy types the reph after its cluster (and vowel sign): K©v / Kv© = র্কা.
      if (clusterAt >= 0) out.splice(clusterAt, 0, t.u);
      else out.push(t.u);
      clusterAt = -1;
      i++;
      continue;
    }
    if (t.kind === 'X') clusterAt = -1;
    out.push(t.u);
    i++;
  }

  return tidy(out.join(''));
}

function tidy(s: string): string {
  let r = s.replaceAll(HASANTA + HASANTA, HASANTA).replaceAll('অা', 'আ');
  r = r.replaceAll(`${HASANTA}${ZWNJ}${HASANTA}${ZWNJ}`, `${HASANTA}${ZWNJ}`); // "&&" typed twice
  r = r.replace(SIGN_BEFORE_SUBSCRIPT, '$2$1');
  // Chandrabindu belongs after the vowel sign: চঁা → চাঁ.
  r = r.replace(CHANDRABINDU_BEFORE_SIGN, `$1${CHANDRABINDU}`);
  // Bijoy draws ':' after a number with the visarga glyph: "৪ঃ" is "৪:".
  r = r.replace(/([০-৯])ঃ/gu, '$1:');
  // A visarga standing alone is the colon: "মূল্য ঃ টাকা" = "মূল্য : টাকা" (মোঃ keeps its visarga).
  r = r.replace(/(^|\s)ঃ(?=\s|$)/gu, '$1:');
  return r.normalize('NFC');
}
