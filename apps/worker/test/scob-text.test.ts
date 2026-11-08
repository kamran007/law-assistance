import { describe, expect, it } from 'vitest';
import { averageCharsPerPage, cleanPages, commonBanglaShare, detectLanguage, markParagraphs, MIN_COMMON_BANGLA_SHARE } from '../src/scob/text';

/** JUD-04 text steps: running head removal, paragraph markers, language, scanned check. */
describe('cleanPages', () => {
  it('drops the running head repeated on most pages and bare page numbers, keeps the text', () => {
    const head = '20 SCOB [2025] AD\nBegum Khaleda Zia & ors vs The State & anr\n(Syed Refaat Ahmed, CJ)';
    const pages = [`${head}\n1\nAPPELLATE DIVISION\n1. The facts are these.`, `${head}\n2\n2. The appellant argued.`, `${head}\n3\n3. We hold.\n  (i) first point`];
    expect(cleanPages(pages)).toBe('APPELLATE DIVISION\n1. The facts are these.\n2. The appellant argued.\n3. We hold.\n  (i) first point');
  });

  it('keeps everything for short documents (nothing can be called repeated)', () => {
    expect(cleanPages(['Head\nA', 'Head\nB'])).toBe('Head\nA\nHead\nB');
  });
});

describe('markParagraphs', () => {
  it('marks paragraphs in sequence and ignores numbered lists inside a paragraph', () => {
    const text = ['1. The case in short.', '2. The prosecution examined:', '    1. the informant', '    2. the doctor', '3. We have considered.', '5. After a lost page.'].join('\n');
    const r = markParagraphs(text);
    expect(r.text.split('\n')).toEqual(['[para 1] The case in short.', '[para 2] The prosecution examined:', '    1. the informant', '    2. the doctor', '[para 3] We have considered.', '[para 5] After a lost page.']);
    expect(r.paragraphs).toBe(5);
  });

  it('reads Bangla paragraph numbers and refuses big jumps', () => {
    const r = markParagraphs('১. প্রথম অনুচ্ছেদ।\n২. দ্বিতীয় অনুচ্ছেদ।\n40. not a paragraph number');
    expect(r.text).toBe('[para 1] প্রথম অনুচ্ছেদ।\n[para 2] দ্বিতীয় অনুচ্ছেদ।\n40. not a paragraph number');
  });
});

describe('detectLanguage / averageCharsPerPage', () => {
  it('classifies by the share of Bangla letters', () => {
    expect(detectLanguage('The appeal is allowed.')).toBe('EN');
    expect(detectLanguage('আপিল মঞ্জুর করা হইল।')).toBe('BN');
    expect(detectLanguage('দণ্ডবিধির ধারা মতে the Penal Code applies here')).toBe('MIXED');
  });

  it('counts non-space characters per page (scanned PDFs have almost none)', () => {
    expect(averageCharsPerPage(['ab cd', '  ', 'efgh'])).toBe(8 / 3);
    expect(averageCharsPerPage([])).toBe(0);
  });
});

describe('commonBanglaShare', () => {
  it('readable Bangla is full of common words; text from an unknown legacy font is not', () => {
    // From 18 SCOB [2023] HCD 3 and 15 SCOB [2021] HCD 4 after conversion (real SCOB text).
    const readable = 'তার মতে পুলিশের কাছে তিনি কোনো জবানবন্দি দেন নাই। রাষ্ট্রপক্ষের ৫নং সাক্ষী আঃ খালেক ও সুলতানপুর নিবাসী যাকে রাষ্ট্রপক্ষ টেন্ডার করে। আসামীপক্ষের জেরায় তিনি বলেন যে, পুলিশ যখন ভিকটিমের বাড়িতে যায় তখন তিনি ওই বাড়িতে গিয়েছিলেন এবং ঘটনার সময় ঘটনাস্থলে আসামী এবং ঐ ভিকটিম একত্রে ছিল। ';
    const garbled = 'র্য্ভলখ্বী ২০০৮ ঈি ঢ়্ব্লসষ ৪৩ বি ষ্পঔ্বঁব্ভ্র ষ্ল্বখ্বল্বষ ১ বি ্ভযয্বপ্ভ্র ঊন্ক্ষ্ণ ল্বলস্বঁ শম্ঘণ্ট ষ্ঝস্ব ';
    expect(commonBanglaShare(readable.repeat(3))).toBeGreaterThan(MIN_COMMON_BANGLA_SHARE);
    expect(commonBanglaShare(garbled.repeat(5))).toBeLessThan(MIN_COMMON_BANGLA_SHARE);
    expect(commonBanglaShare('দুই শব্দ')).toBe(1); // too short to judge
  });
});
