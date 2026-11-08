import { describe, expect, it } from 'vitest';
import { mergeCitedSections, userCitedSections } from '../src/section-merge';

const FIR =
  'আসামীগণ পরস্পর যোগসাজশে বাদীকে মারপিট করিয়া গুরুতর জখম করে। দণ্ডবিধির ৩২৩/৩২৫/৩০৭/৩৪ ধারায় মামলা রুজু করা হইল। ' +
  'উল্লেখ্য, আসামীর নিকট হইতে একটি দেশীয় পিস্তল উদ্ধার করা হয় যাহা অস্ত্র আইনের ১৯এ ধারার অপরাধ।';

describe('mergeCitedSections', () => {
  it('keeps every detector citation and marks those the LLM also found', () => {
    const r = mergeCitedSections(FIR, [
      { act_hint: 'Penal Code', section: '302', raw: 'দণ্ডবিধির ৩০২ ধারা' }, // not in the text
      { act_hint: 'দণ্ডবিধি', section: '৩২৫', raw: '৩২৫' },
    ]);
    expect(r.sections.map((s) => [s.act?.key, s.key, s.source])).toEqual([
      ['PENAL_CODE', '323', 'DETECTOR'],
      ['PENAL_CODE', '325', 'DETECTOR_AND_LLM'],
      ['PENAL_CODE', '307', 'DETECTOR'],
      ['PENAL_CODE', '34', 'DETECTOR'],
      ['ARMS_ACT', '19A', 'DETECTOR'],
    ]);
    expect(r.rejected).toEqual([{ section: '302', actHint: 'Penal Code', reason: 'NOT_FOUND_IN_TEXT' }]);
    expect(r.sections[0]!.citedTogether).toEqual(['323', '325', '307', '34']);
  });

  it('rejects an LLM section whose Act disagrees with what the text says', () => {
    // 19A of the Penal Code does not exist; the text cites 19A of the Arms Act.
    const r = mergeCitedSections(FIR, [{ act_hint: 'Penal Code', section: '19A', raw: '১৯এ ধারা' }]);
    expect(r.rejected).toEqual([{ section: '19A', actHint: 'Penal Code', reason: 'ACT_MISMATCH' }]);
    expect(r.sections.filter((s) => s.key === '19A').map((s) => [s.act?.key, s.source])).toEqual([['ARMS_ACT', 'DETECTOR']]);
  });

  it('accepts an LLM-only section when its quote occurs in the text and contains the number', () => {
    const text = 'বাদীর অভিযোগ: আসামী প্রতারণার মাধ্যমে টাকা আত্মসাৎ করিয়াছে, যাহা Penal Code এর 420 ও 406 এর অপরাধ।';
    // The detector needs a keyword ("ধারা", "u/s" …) and finds nothing here.
    const r = mergeCitedSections(text, [
      { act_hint: 'Penal Code', section: '420', raw: 'Penal Code এর 420' },
      { act_hint: null, section: '406', raw: '406 এর অপরাধ' },
      { act_hint: null, section: '409', raw: '420 ও 406' }, // quote is real but has no 409
    ]);
    expect(r.sections.map((s) => [s.act?.key ?? null, s.key, s.source, s.actInferred])).toEqual([
      ['PENAL_CODE', '420', 'LLM_QUOTE_IN_TEXT', false],
      [null, '406', 'LLM_QUOTE_IN_TEXT', false],
    ]);
    expect(r.rejected.map((x) => x.section)).toEqual(['409']);
  });

  it('applies the FIR default Act to an LLM-only section without an Act, flagged as inferred', () => {
    const r = mergeCitedSections('অভিযোগ ৩৭৯ নম্বর অপরাধ', [{ act_hint: null, section: '379', raw: '৩৭৯ নম্বর অপরাধ' }], { defaultAct: 'PENAL_CODE' });
    expect(r.sections).toMatchObject([{ key: '379', act: { key: 'PENAL_CODE' }, actInferred: true, source: 'LLM_QUOTE_IN_TEXT' }]);
  });

  it('rejects unreadable sections and quotes too short to check', () => {
    const r = mergeCitedSections(FIR, [
      { act_hint: null, section: 'section', raw: 'ধারা' },
      { act_hint: null, section: '৩', raw: '৩' },
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['UNREADABLE_SECTION', 'NOT_FOUND_IN_TEXT']);
  });
});

describe('userCitedSections (BE-26 corrections)', () => {
  it('builds authoritative rows from what the user typed: Act from the hint, clause as sub-section', () => {
    const r = userCitedSections(
      [
        { act_hint: 'দণ্ডবিধি', section: '৩২৫' },
        { act_hint: 'নারী ও শিশু নির্যাতন দমন আইন', section: '১১(গ)' },
        { act_hint: null, section: '379' },
        { act_hint: 'Penal Code', section: '325' }, // duplicate of the first
        { act_hint: null, section: 'ধারা' }, // unreadable
      ],
      { defaultAct: 'PENAL_CODE' },
    );
    expect(r.sections.map((s) => [s.act?.key, s.key, s.subsection, s.actInferred, s.source])).toEqual([
      ['PENAL_CODE', '325', null, false, 'USER_CORRECTED'],
      ['NARI_SHISHU', '11', '(গ)', false, 'USER_CORRECTED'],
      ['PENAL_CODE', '379', null, true, 'USER_CORRECTED'],
    ]);
    expect(r.rejected).toEqual([{ section: 'ধারা', actHint: null, reason: 'UNREADABLE_SECTION' }]);
  });
});
