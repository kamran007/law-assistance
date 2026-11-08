import { describe, expect, it } from 'vitest';
import { toBanglaDigits } from '../src/digits';
import { detectSections, uniqueCitations, type DetectOptions } from '../src/section-detector';

/**
 * DATA-12 corpus (TRD §8.4, done when ≥ 300 test strings). Expected citations are written as
 * "ACT:key(sub)", with "*" when the Act was inferred (FIR default) and "-" for no Act.
 */
const fmt = (text: string, opts?: DetectOptions) =>
  detectSections(text, opts).map((c) => `${c.act?.key ?? '-'}:${c.key}${c.subsection ?? ''}${c.actInferred ? '*' : ''}`);

const FIR: DetectOptions = { defaultAct: 'PENAL_CODE' };
let counted = 0;

/** Realistic phrasing from FIRs, charge sheets and orders. [text, expected, FIR default?] */
const HAND: [string, string[], DetectOptions?][] = [
  // ── Penal Code, Bangla ──
  ['আসামীরা দণ্ডবিধির ৩০২/৩৪ ধারায় অপরাধ করিয়াছে', ['PENAL_CODE:302', 'PENAL_CODE:34']],
  ['দন্ডবিধি আইনের ৩৭৯ ধারা', ['PENAL_CODE:379']],
  ['দঃবিঃ ৩৮০/৪১১ ধারা', ['PENAL_CODE:380', 'PENAL_CODE:411']],
  ['দ:বি: ৪২০ ধারা', ['PENAL_CODE:420']],
  ['পেনাল কোডের ৩২৩ ধারায়', ['PENAL_CODE:323']],
  ['ধারা-৪২০/৪০৬ দণ্ডবিধি', ['PENAL_CODE:420', 'PENAL_CODE:406']],
  ['ধারা: ৩০২, ৩৪ দঃবিঃ', ['PENAL_CODE:302', 'PENAL_CODE:34']],
  ['ধারা ৩২৩ ও ৩২৪ দণ্ডবিধি', ['PENAL_CODE:323', 'PENAL_CODE:324']],
  ['ধারাসমূহ ১৪৩/৪৪৭/৩২৩ দণ্ডবিধি', ['PENAL_CODE:143', 'PENAL_CODE:447', 'PENAL_CODE:323']],
  ['ধারা ৩০২/১০৯ দণ্ডবিধি', ['PENAL_CODE:302', 'PENAL_CODE:109']],
  ['দণ্ডবিধির ৩৬৪ক ধারা', ['PENAL_CODE:364A']],
  ['দণ্ডবিধির 302/34 ধারা', ['PENAL_CODE:302', 'PENAL_CODE:34']],
  ['ধারা ৩২৫ পেনাল কোড', ['PENAL_CODE:325']],
  ['দণ্ডবিধির ১৪৩, ১৪৭, ১৪৮, ৩২৩ ও ৩০৭ ধারা', ['PENAL_CODE:143', 'PENAL_CODE:147', 'PENAL_CODE:148', 'PENAL_CODE:323', 'PENAL_CODE:307']],
  ['দণ্ডবিধির ৫০৬(২) ধারা', ['PENAL_CODE:506(2)']],
  ['দণ্ডবিধির ৩২৬এ ধারা', ['PENAL_CODE:326A']],
  ['দণ্ডবিধি ১৮৬০ এর ৩৯৫/৩৯৭ ধারা', ['PENAL_CODE:395', 'PENAL_CODE:397']],
  ['থানার মামলা নং-১২, তারিখ-০৫/০৩/২০২৪ খ্রিঃ, ধারা-৩০২/৩৪ দণ্ডবিধি', ['PENAL_CODE:302', 'PENAL_CODE:34']],
  ['জি.আর. মামলা নং ৪১২/২০২৬, ধারা ৩৭৯ দঃবিঃ', ['PENAL_CODE:379']],
  ['দণ্ডবিধির ৩০২ ধারা এবং ৩৪ ধারা', ['PENAL_CODE:302', 'PENAL_CODE:34']],
  ['১৪৩/৩২৩/৩২৪/৩০৭/৫০৬ ধারা সহ দণ্ডবিধির', ['PENAL_CODE:143', 'PENAL_CODE:323', 'PENAL_CODE:324', 'PENAL_CODE:307', 'PENAL_CODE:506']],
  // ── FIR default when no Act is named ──
  ['৩২৩ ও ৩৪ ধারায়', ['PENAL_CODE:323*', 'PENAL_CODE:34*'], FIR],
  ['৩২৩ এবং ৩৪ নং ধারা', ['PENAL_CODE:323*', 'PENAL_CODE:34*'], FIR],
  ['৩৪ধারা', ['PENAL_CODE:34*'], FIR],
  ['৩২৩/৩২৪/৩২৫/৩০৭/৫০৬(২)/৩৪ ধারা', ['PENAL_CODE:323*', 'PENAL_CODE:324*', 'PENAL_CODE:325*', 'PENAL_CODE:307*', 'PENAL_CODE:506(2)*', 'PENAL_CODE:34*'], FIR],
  ['ধারা ৩৭৯', ['PENAL_CODE:379*'], FIR],
  ['ধারা ৩৭৯', ['-:379']],
  ['u/s 302/34', ['PENAL_CODE:302*', 'PENAL_CODE:34*'], FIR],
  // ── Nari-o-Shishu ──
  ['নারী ও শিশু নির্যাতন দমন আইনের ৯(১) ধারা', ['NARI_SHISHU:9(1)']],
  ['নারী ও শিশু নির্যাতন দমন আইন, ২০০০ এর ১১(গ) ধারা', ['NARI_SHISHU:11(গ)']],
  ['নারী ও শিশু নির্যাতন দমন আইন ২০০০ (সংশোধিত ২০০৩) এর ৭/৩০ ধারা', ['NARI_SHISHU:7', 'NARI_SHISHU:30']],
  ['নারী ও শিশু নির্যাতন দমন আইন, ২০০০ (সংশোধিত ২০০৩) এর ১১(গ)/৩০ ধারা', ['NARI_SHISHU:11(গ)', 'NARI_SHISHU:30']],
  ['নাঃ ও শিঃ ১১(ক) ধারা', ['NARI_SHISHU:11(ক)']],
  ['নারী ও শিশু নির্যাতন দমন আইনের ৯(৪)(খ) ধারা', ['NARI_SHISHU:9(4)(খ)']],
  ['section 9(1) of the Nari-O-Shishu Nirjatan Daman Ain', ['NARI_SHISHU:9(1)']],
  ['section 11(ga) of the Women and Children Repression Prevention Act', ['NARI_SHISHU:11(ga)']],
  // ── Two Acts in one sentence ──
  ['দণ্ডবিধির ৩০২/৩৪ ধারা এবং নারী ও শিশু নির্যাতন দমন আইনের ৯(২) ধারা', ['PENAL_CODE:302', 'PENAL_CODE:34', 'NARI_SHISHU:9(2)']],
  ['u/s 302/34 of the Penal Code and u/s 19A of the Arms Act', ['PENAL_CODE:302', 'PENAL_CODE:34', 'ARMS_ACT:19A']],
  ['section 164 of the CrPC and section 32 of the Evidence Act', ['CRPC:164', 'EVIDENCE:32']],
  ['Section 561A Cr.P.C. read with section 4(1)(b) of the NI Act', ['CRPC:561A', 'NI_ACT:4(1)(b)']],
  // ── Narcotics: section + table serial ──
  ['মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮ এর ৩৬(১) সারণির ১০(ক) ধারা', ['NARCOTICS_2018:36(1) table 10(ক)']],
  ['মাদকদ্রব্য নিয়ন্ত্রণ আইন ২০১৮ এর ৩৬(১) সারণি ক্রমিক নং ৩(খ)', ['NARCOTICS_2018:36(1) table 3(খ)']],
  ['মাদকদ্রব্য নিয়ন্ত্রণ আইনের ৩৬(১) সারণির ১৯ নং ধারা', ['NARCOTICS_2018:36(1) table 19']],
  ['section 36(1) of the Narcotics Control Act, 2018', ['NARCOTICS_2018:36(1)']],
  ['section 4(1)(b) of the Narcotics Control Act', ['NARCOTICS_2018:4(1)(b)']],
  // ── CrPC ──
  ['ফৌজদারি কার্যবিধির ১৬৪ ধারায় জবানবন্দি', ['CRPC:164']],
  ['ফৌজদারী কার্যবিধির ৪৯৭ ধারা মোতাবেক জামিন', ['CRPC:497']],
  ['ফৌঃকাঃবিঃ ৫৬১ক ধারা', ['CRPC:561A']],
  ['Section 561A of the Code of Criminal Procedure', ['CRPC:561A']],
  ['u/s 561A Cr.P.C.', ['CRPC:561A']],
  ['section 497 CrPC', ['CRPC:497']],
  ['section 265K CrPC', ['CRPC:265K']],
  ['section 265-I of the CrPC', ['CRPC:265I']],
  ['ss. 154 and 156(3) Cr.P.C.', ['CRPC:154', 'CRPC:156(3)']],
  // ── Other Acts ──
  ['অস্ত্র আইনের ১৯(ক) ধারা', ['ARMS_ACT:19(ক)']],
  ['বিশেষ ক্ষমতা আইন ১৯৭৪ এর ২৫বি ধারা', ['SPECIAL_POWERS:25B']],
  ['u/s 25B of the Special Powers Act, 1974', ['SPECIAL_POWERS:25B']],
  ['বিস্ফোরক দ্রব্য আইনের ৩/৪ ধারা', ['EXPLOSIVES:3', 'EXPLOSIVES:4']],
  ['sections 3/4 of the Explosive Substances Act', ['EXPLOSIVES:3', 'EXPLOSIVES:4']],
  ['ডিজিটাল নিরাপত্তা আইন, ২০১৮ এর ২৫(১)(খ)/২৯/৩১ ধারা', ['DIGITAL_SECURITY_2018:25(1)(খ)', 'DIGITAL_SECURITY_2018:29', 'DIGITAL_SECURITY_2018:31']],
  ['section 25 of the Digital Security Act', ['DIGITAL_SECURITY_2018:25']],
  ['সাইবার নিরাপত্তা আইন ২০২৩ এর ২৯ ধারা', ['CYBER_SECURITY_2023:29']],
  ['সাইবার সুরক্ষা অধ্যাদেশ, ২০২৫ এর ২৫ ধারা', ['CYBER_SUROKSHA_2025:25']],
  ['যৌতুক নিরোধ আইন ২০১৮ এর ৩ ধারা', ['DOWRY_2018:3']],
  ['section 4 of the Dowry Prohibition Act 2018', ['DOWRY_2018:4']],
  ['মানব পাচার প্রতিরোধ ও দমন আইন ২০১২ এর ৬/৭ ধারা', ['HUMAN_TRAFFICKING_2012:6', 'HUMAN_TRAFFICKING_2012:7']],
  ['u/s 6 of the Human Trafficking Act', ['HUMAN_TRAFFICKING_2012:6']],
  ['মানিলন্ডারিং প্রতিরোধ আইন ২০১২ এর ৪(২) ধারা', ['MONEY_LAUNDERING_2012:4(2)']],
  ['হস্তান্তরযোগ্য দলিল আইনের ১৩৮ ধারা', ['NI_ACT:138']],
  ['এন আই এ্যাক্ট এর ১৩৮ ধারা', ['NI_ACT:138']],
  ['Section 138 of the Negotiable Instruments Act, 1881', ['NI_ACT:138']],
  ['s. 138 N.I. Act', ['NI_ACT:138']],
  ['সাক্ষ্য আইনের ৩২ ধারা', ['EVIDENCE:32']],
  ['section 151 CPC', ['CPC:151']],
  ['section 9 of the C.P.C.', ['CPC:9']],
  ['দেওয়ানি কার্যবিধির ৯ ধারা', ['CPC:9']],
  // ── English Penal Code ──
  ['u/s 302/34 PC', ['PENAL_CODE:302', 'PENAL_CODE:34']],
  ['U/S 420/406 of the Penal Code', ['PENAL_CODE:420', 'PENAL_CODE:406']],
  ['under section 379 of the Penal Code, 1860', ['PENAL_CODE:379']],
  ['Sec. 323/324/307 PC', ['PENAL_CODE:323', 'PENAL_CODE:324', 'PENAL_CODE:307']],
  ['ss. 302 and 34 of the Penal Code', ['PENAL_CODE:302', 'PENAL_CODE:34']],
  ['section 302, 201 and 34 PC', ['PENAL_CODE:302', 'PENAL_CODE:201', 'PENAL_CODE:34']],
  ['Sections 147/148/149/326 of the Penal Code', ['PENAL_CODE:147', 'PENAL_CODE:148', 'PENAL_CODE:149', 'PENAL_CODE:326']],
  ['section 171-I PC', ['PENAL_CODE:171I']],
  ['U/S-379 PC', ['PENAL_CODE:379']],
  ['Sec.302/34 P.C.', ['PENAL_CODE:302', 'PENAL_CODE:34']],
  ['Section 302 of the Bangladesh Penal Code', ['PENAL_CODE:302']],
  ['section 302 And then he fled', ['-:302']],
  ['section 57 of the ICT Act', ['-:57']],
  // ── Not citations ──
  ['on 12/03/2024 at 10 am', []],
  ['Phone 01712-345678', []],
  ['Tk. 50,000 (fifty thousand)', []],
  ['G.R. Case No. 412/2026', []],
  ['মামলা নং ১২/২০২৪, তারিখ ০৫/০৩/২০২৪', []],
  ['Police Station Kotwali, Dhaka-1205', []],
  ['He is 34 years old', []],
  ['ধারণা করা হয় যে ৩ জন ছিল', []],
  ['অধিকারী ৩০২ জন', []],
  ['chapter 302', []],
  ['Sections of the Act', []],
  ['সুধারা ৩০২', []],
  ['room 302, block 34', []],
  ['ধারা', []],
  ['u/s', []],
  ['Order XXXIX rule 1 CPC', []],
  ['১৯৭৪ সালের ঘটনা', []],
  ['FIR No. 34 dated 05.03.2024', []],
  ['মোবাইল নং ০১৭১২৩৪৫৬৭৮', []],
  ['জেলা: ঢাকা, থানা: কোতোয়ালী', []],
];

describe('detectSections: hand-written corpus', () => {
  it.each(HAND)('%s', (text, expected, opts) => {
    counted++;
    expect(fmt(text, opts)).toEqual(expected);
  });
});

/** Generated: each Act × each phrasing template × section list × separator × digit script. */
const ACTS = [
  { key: 'PENAL_CODE', poss: 'দণ্ডবিধির', bn: 'দণ্ডবিধি', abbrBn: 'দঃবিঃ', en: 'the Penal Code', abbr: 'PC', lists: [['302', '34'], ['420', '406'], ['379'], ['323', '324', '307'], ['364A']] },
  { key: 'CRPC', poss: 'ফৌজদারি কার্যবিধির', bn: 'ফৌজদারি কার্যবিধি', abbrBn: 'ফৌঃকাঃবিঃ', en: 'the Code of Criminal Procedure', abbr: 'Cr.P.C.', lists: [['164'], ['497'], ['561A'], ['154', '156']] },
  { key: 'NARI_SHISHU', poss: 'নারী ও শিশু নির্যাতন দমন আইনের', bn: 'নারী ও শিশু নির্যাতন দমন আইন', abbrBn: 'নাঃ ও শিঃ', en: 'the Nari-O-Shishu Nirjatan Daman Ain', abbr: 'Nari-O-Shishu Act', lists: [['9'], ['11', '30'], ['7']] },
];
const SEPS = ['/', ' ও ', ', '] as const;
const EN_SEPS = ['/', ' and ', ', '] as const;
const toKey = (s: string) => s.toUpperCase();

interface Gen {
  text: string;
  expected: string[];
}
const GENERATED: Gen[] = [];
for (const act of ACTS) {
  for (const list of act.lists) {
    const exp = list.map((s) => `${act.key}:${toKey(s)}`);
    for (const bangla of [false, true]) {
      const nums = list.map((s) => (bangla ? toBanglaDigits(s).replace('A', 'ক') : s));
      for (const sep of SEPS) {
        const l = nums.join(sep);
        GENERATED.push({ text: `${act.poss} ${l} ধারা`, expected: exp });
        GENERATED.push({ text: `ধারা-${l} ${act.bn}`, expected: exp });
      }
      GENERATED.push({ text: `${act.abbrBn} ${nums.join('/')} ধারায়`, expected: exp });
    }
    for (const sep of EN_SEPS) {
      const l = list.join(sep);
      GENERATED.push({ text: `u/s ${l} ${act.abbr}`, expected: exp });
      GENERATED.push({ text: `section ${l} of ${act.en}`, expected: exp });
    }
    GENERATED.push({ text: `Sec. ${list.join('/')} of ${act.en}`, expected: exp });
  }
}

describe('detectSections: generated matrix', () => {
  it.each(GENERATED.map((g) => [g.text, g.expected] as const))('%s', (text, expected) => {
    counted++;
    expect(fmt(text)).toEqual(expected);
  });
});

describe('detectSections: details', () => {
  it('records the group, its position and cited-together sections', () => {
    const text = 'অভিযোগ: দণ্ডবিধির ৩০২/৩৪ ধারা।';
    const [a, b] = detectSections(text);
    expect(a).toMatchObject({ section: '৩০২', key: '302', citedTogether: ['302', '34'], act: { bdlawsActId: 11, name: 'The Penal Code, 1860' } });
    expect(b!.key).toBe('34');
    expect(text.slice(a!.start, a!.end)).toBe(a!.raw);
    expect(a!.raw).toContain('৩০২/৩৪ ধারা');
  });

  it('dedupes repeated citations per Act, section and sub-section', () => {
    const all = detectSections('দণ্ডবিধির ৩০২ ধারা ... পুনরায় দণ্ডবিধির ৩০২ ধারা এবং ৫০৬(২) ধারা দণ্ডবিধি', FIR);
    expect(uniqueCitations(all).map((c) => `${c.key}${c.subsection ?? ''}`)).toEqual(['302', '506(2)']);
  });

  it('runs in linear time on hostile input', () => {
    const hostile = `ধারা ${'১/'.repeat(5000)}x ${'u/s '.repeat(2000)} ${'(১)'.repeat(3000)}`;
    const t0 = performance.now();
    detectSections(hostile);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('corpus size', () => {
  it('covers at least 300 test strings (DATA-12 done-when)', () => {
    expect(HAND.length + GENERATED.length).toBeGreaterThanOrEqual(300);
    expect(counted).toBe(HAND.length + GENERATED.length);
  });
});

describe('detectSections: Dhaka addresses that use "Section" (found by the live FIR test, BE-23)', () => {
  const keys = (t: string) => detectSections(t, { defaultAct: 'PENAL_CODE' }).map((c) => `${c.act?.key}:${c.key}`);

  it.each([
    'ঘটনাস্থল: সেকশন-১১, ব্লক-গ, রোড নং-৪, পল্লবীপুর',
    'সাং- বস্তি, সেকশন-১১, পল্লবীপুর।',
    'মিরপুর সেকশন ১০ এ',
    'House 5, Road 2, Section 6, Mirpur',
    'Mirpur Section-2',
  ])('is an address, not a citation: %s', (t) => {
    expect(keys(t)).toEqual([]);
  });

  it('keeps real citations next to addresses, and "section" when an Act is named', () => {
    expect(keys('Section 6 of the Penal Code at House 5')).toEqual(['PENAL_CODE:6']);
    expect(keys('u/s 323 PC, House 5 Road 2')).toEqual(['PENAL_CODE:323']);
    expect(keys('সেকশন ৪২০ দণ্ডবিধি, ঠিকানা মিরপুর')).toEqual(['PENAL_CODE:420']);
    expect(keys('সাং মিরপুর, আসামী ধারা ৩২৩ এর অপরাধ')).toEqual(['PENAL_CODE:323']);
  });
});
