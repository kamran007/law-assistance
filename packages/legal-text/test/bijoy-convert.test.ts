import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { looksLikeBijoy } from '../src/bijoy';
import { convertBijoyDocument, convertBijoyToUnicode as convert } from '../src/bijoy-convert';
import { detectSections } from '../src/section-detector';

interface Corpus {
  words: [bijoy: string, unicode: string, gazette: string][];
  lines: [bijoy: string, unicode: string][];
}
const corpus = JSON.parse(readFileSync(new URL('./fixtures/bijoy-gazette-corpus.json', import.meta.url), 'utf8')) as Corpus;

/** Hand-written Bijoy (as SutonnyMJ users type it) → Unicode, one rule or glyph per line. */
const RULES: [string, string, string][] = [
  // reordering
  ['pre-base e-kar', '†M‡RU', 'গেজেট'],
  ['o-kar from e-kar + aa-kar', '†mvbvi', 'সোনার'],
  ['ou-kar from e-kar + length mark', '†KŠkj', 'কৌশল'],
  ['ai-kar', 'ˆekvL', 'বৈশাখ'],
  ['i-kar before a conjunct', 'wkÿv', 'শিক্ষা'],
  ['e-kar before a cluster with r-phala', '†MÖdZvi', 'গ্রেফতার'],
  ['reph after the cluster', 'Kg©', 'কর্ম'],
  ['reph after cluster + vowel sign', 'Kvh©', 'কার্য'],
  ['reph after e-kar + cluster', 'Kv‡h©i', 'কার্যের'],
  ['reph inside a word', 'AšÍf©y³', 'অন্তর্ভুক্ত'],
  ['reph after ri-kar', 'KZ…©cÿ', 'কর্তৃপক্ষ'],
  ['chandrabindu after the vowel sign', 'Pvu`', 'চাঁদ'],
  ['chandrabindu with ou-kar', '†cuŠQvB‡j', 'পৌঁছাইলে'],
  ['subscript drawn after u-kar', 'Ab~¨b', 'অন্যূন'],
  ['subscript drawn after aa-kar', 'GZÏv¦iv', 'এতদ্দ্বারা'],
  // glyphs
  ['ya-phala', 'msL¨v', 'সংখ্যা'],
  ['ব-phala ¦', 'Avwk¦b', 'আশ্বিন'],
  ['half ন + ¿', 'gš¿Yvjq', 'মন্ত্রণালয়'],
  ['Ð = ণ্ড', 'Kg©Kv‡Ð', 'কর্মকাণ্ডে'],
  ['Û = ন্ড', '`Ûwewa', 'দন্ডবিধি'],
  ['Á = জ্ঞ', 'weÁwß', 'বিজ্ঞপ্তি'],
  ['¹ = গ্ম', 'hy¹-mwPe', 'যুগ্ম-সচিব'],
  ['¥ = ্ম', 'AvZ¥‡Mvcb', 'আত্মগোপন'],
  ['æ = u-kar after র', 'weiæ‡×', 'বিরুদ্ধে'],
  ['ƒ = uu-kar after র', 'wb¤œiƒc', 'নিম্নরূপ'],
  ['¤^ = ম্ব', '†m‡Þ¤^i', 'সেপ্টেম্বর'],
  ['• = ঙ্', 'j•Nb', 'লঙ্ঘন'],
  ['” = চ্', 'Aby‡”Q`', 'অনুচ্ছেদ'],
  ['™ = দ্', 'D™¢veb', 'উদ্ভাবন'],
  ['ü = হৃ', 'Ae¨eüZ', 'অব্যবহৃত'],
  ['þ = হ্ম', 'eªvþY', 'ব্রাহ্মণ'],
  ['¶ = ক্ষ (older SutonnyMJ)', '¶gZv', 'ক্ষমতা'],
  ['ৎ, ং, ঃ', 'Zrmn gvgjv t', 'তৎসহ মামলা :'],
  ['visarga inside an abbreviation stays', '†gvt', 'মোঃ'],
  ['digits and colon after a number', '4t00', '৪:০০'],
  ['danda', 'nB‡e|', 'হইবে।'],
  ['visible hasanta', 'Av`&', `আদ্${String.fromCodePoint(0x200c)}`],
  ['typed-twice hasanta collapses', 'Av`&&', `আদ্${String.fromCodePoint(0x200c)}`],
  // context-dependent glyphs
  ['ø after a consonant = ্ল', 'DwjøwLZ', 'উল্লিখিত'],
  ['ø alone = স্ন', '†øn', 'স্নেহ'],
  ['Í after a half form = ্ত', 'n¯ÍvšÍi', 'হস্তান্তর'],
  ["' after a half form = ্থ", "e¨e¯'v", 'ব্যবস্থা'],
  ['’ after a half form = ্থ', 'cwicš’x', 'পরিপন্থী'],
  ['‘ after a half form = ্তু', 'cÖ¯‘Z', 'প্রস্তুত'],
  ['— after a half form = ্ত', 'š—', 'ন্ত'],
  ['— elsewhere is a dash', 'cÖeZ©b|—(1)', 'প্রবর্তন।—(১)'],
  ['“ after a consonant = u-kar', 'i“c', 'রুপ'],
  ['“ before a word is a quote', '“Scheduled', `${String.fromCodePoint(0x201c)}ঝপযবফঁষবফ`],
  ["' alone is an apostrophe", "ÔjÕ", "'ল'"],
];

describe('convertBijoyToUnicode: rules', () => {
  it.each(RULES)('%s: %s', (_rule, bijoy, unicode) => {
    expect(convert(bijoy)).toBe(unicode.normalize('NFC'));
  });

  it('reads Windows-1252 bytes that arrive as C1 controls (0x87 = ‡)', () => {
    const c1 = (cp: number) => String.fromCodePoint(cp);
    expect(convert(`${c1(0x86)}M${c1(0x87)}RU`)).toBe('গেজেট');
  });

  it('keeps URLs and e-mail addresses, which Bijoy documents set in an English font', () => {
    expect(convert('I‡qemvBU: www.bgpress.gov.bd')).toBe('ওয়েবসাইট: www.bgpress.gov.bd');
    expect(convert('B-‡gBj: info@dpp.gov.bd|')).toBe('ই-মেইল: info@dpp.gov.bd।');
  });

  it('passes Unicode Bangla through unchanged', () => {
    const unicode = 'দণ্ডবিধির ৩০২ ধারা';
    expect(convert(unicode)).toBe(unicode);
  });

  it('convertBijoyDocument leaves lines already in Unicode Bangla alone', () => {
    const doc = ['evsjv‡`k †M‡RU', 'বাংলাদেশ গেজেট, Section 4, 2016', '†mvgevi'].join('\n');
    expect(convertBijoyDocument(doc)).toBe(['বাংলাদেশ গেজেট', 'বাংলাদেশ গেজেট, Section 4, 2016', 'সোমবার'].join('\n'));
  });

  it('handles empty input and lone marks without throwing', () => {
    expect(convert('')).toBe('');
    expect(convert('‡')).toBe('ে');
    expect(convert('©')).toBe('র্');
  });

  it('runs in linear time on long hostile input', () => {
    const start = performance.now();
    convert('‡'.repeat(50_000) + '©'.repeat(50_000) + 'w'.repeat(50_000));
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe('convertBijoyToUnicode: real SutonnyMJ gazettes', () => {
  it('has a corpus of at least 200 strings (DATA-11)', () => {
    expect(corpus.words.length + corpus.lines.length + RULES.length).toBeGreaterThanOrEqual(200);
    expect(corpus.words.length).toBeGreaterThanOrEqual(200);
  });

  it.each(corpus.words)('word %s → %s (gazette %s)', (bijoy, unicode) => {
    expect(convert(bijoy)).toBe(unicode);
  });

  it.each(corpus.lines)('line %s', (bijoy, unicode) => {
    expect(convert(bijoy)).toBe(unicode);
  });

  it('the detector flags every gazette line set in Bijoy and none of the converted output', () => {
    const text = corpus.lines.map(([b]) => b).join('\n');
    expect(looksLikeBijoy({ text })).toBe(true);
    expect(looksLikeBijoy({ text: convert(text) })).toBe(false);
  });
});

describe('Bijoy FIR text → section detector (DATA-11 + DATA-12)', () => {
  it('finds the sections of a converted Bijoy FIR', () => {
    const fir = convert('Avmvgx‡`i weiæ‡× `Ûwewai 302/34 avivq gvgjv i“Ry Kiv nBj|');
    expect(fir).toBe('আসামীদের বিরুদ্ধে দন্ডবিধির ৩০২/৩৪ ধারায় মামলা রুজু করা হইল।');
    const found = detectSections(fir).map((c) => [c.act?.key, c.key]);
    expect(found).toEqual([
      ['PENAL_CODE', '302'],
      ['PENAL_CODE', '34'],
    ]);
  });

  it('reads the gazette schedule: ধারা-৪০৯/৪৬৭/৪৬৮/৪৭১/৪৭৭(ক)/১০৯ দঃবিঃ', () => {
    const line = convert('aviv-409/467/468/471/477(K)/109 `twet');
    const found = detectSections(line);
    expect(found.map((c) => c.key)).toEqual(['409', '467', '468', '471', '477', '109']);
    expect(found.every((c) => c.act?.key === 'PENAL_CODE')).toBe(true);
    expect(found.find((c) => c.key === '477')?.subsection).toBe('(ক)');
  });
});
