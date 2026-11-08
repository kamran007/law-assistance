import { describe, expect, it } from 'vitest';
import { averageCharsPerPage, cleanPages, detectLanguage, markParagraphs } from '../src/scob/text';

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
