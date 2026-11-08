import { describe, expect, it } from 'vitest';
import type { StructuredAnalysisV1 } from '../src/analysis/post-process';
import { buildRoleMessage, ROLE_EFFORT, validateRoleAnalysis } from '../src/analysis/roles';
import type { PinnedSource } from '../src/analysis/sources';

/** Stage 6 server-side checks (BE-25, TRD §7.4, CLAUDE.md "no AI-generated bail status"). */
const PENAL = { key: 'PENAL_CODE', bdlawsActId: 11, name: 'The Penal Code, 1860' };
const base = { subsection: null, actInferred: false, citedTogether: ['323', '34'], source: 'DETECTOR' as const };

const analysis: StructuredAnalysisV1 = {
  version: 1,
  occurrence: { date: '2024-03-12', time: '21:30', instant: '2024-03-12T15:30:00.000Z', approximate: true, flags: [] },
  reported: { date: '2024-03-13', time: '10:00', instant: '2024-03-13T04:00:00.000Z', approximate: false, flags: [] },
  filingDelay: { minutes: 750, days: 1, basis: 'DATETIME', warning: null },
  scheduleDate: '2024-03-12',
  scheduleDateBasis: 'OCCURRENCE',
  sections: [
    {
      ...base,
      key: '323',
      section: '৩২৩',
      act: PENAL,
      scheduleStatus: 'VERIFIED',
      schedule: { isCognizable: false, isBailable: true, isCompoundable: true, maxPunishment: 'test', triableByCourt: 'test', offenseDescription: null, sourceReference: null, matchedSection: '323', effectiveFrom: '1898-07-01' },
    },
    { ...base, key: '34', section: '৩৪', act: PENAL, scheduleStatus: 'NOT_IN_VERIFIED_SCHEDULE', schedule: null },
  ],
  rejectedSections: [],
};

const source = (n: number, ref: string): PinnedSource => ({
  n,
  sectionRef: ref,
  sectionId: `00000000-0000-0000-0000-00000000000${n}`,
  actName: 'The Penal Code, 1860',
  sectionNumber: ref.split(':')[1]!,
  marginalHeading: null,
  contentBody: `text of ${ref}`,
  versionNumber: 1,
  validFrom: '1860-10-06',
  currentTextUsed: false,
});
const sources = [source(1, 'PENAL_CODE:323'), source(2, 'PENAL_CODE:34')];
const firText = 'বাদী রহিম, মোবাইল ০১৭১১-১২৩৪৫৬। আসামী করিম লাঠি দিয়া বাদীকে আঘাত করে। দণ্ডবিধির ৩২৩/৩৪ ধারা।';
const ctx = { firText, analysis, sources };

describe('validateRoleAnalysis', () => {
  it('lawyer: strips unknown citations, drops uncited ingredients, checks quotes against the document', () => {
    const { content, flags } = validateRoleAnalysis(
      'LAWYER',
      {
        sections: [
          {
            section_ref: 'PENAL_CODE:323',
            ingredients: [
              { ingredient: 'voluntarily causing hurt', status: 'ALLEGED', evidence_in_fir: 'লাঠি দিয়া বাদীকে আঘাত করে', source_ids: [1, 9] },
              { ingredient: 'invented ingredient', status: 'UNCLEAR', evidence_in_fir: null, source_ids: [7] },
              { ingredient: 'with a quote not in the FIR', status: 'ALLEGED', evidence_in_fir: 'ছুরি দিয়া খুন করে', source_ids: [1] },
            ],
          },
          { section_ref: 'PENAL_CODE:302', ingredients: [{ ingredient: 'x', status: 'ALLEGED', evidence_in_fir: null, source_ids: [1] }] },
        ],
        delay: { assessment: 'UNEXPLAINED', note: 'the FIR gives no reason for the delay', evidence_in_fir: null },
        grounds: [
          { kind: 'BAIL', ground: 'No weapon was recovered, so bail may be considered.', source_ids: [2] },
          { kind: 'BAIL', ground: 'The offence under s.34 is bailable. The accused has a fixed address.', source_ids: [2] },
          { kind: 'OTHER', ground: 'An uncited legal claim.', source_ids: [] },
        ],
      },
      ctx,
    );
    const l = content as { sections: { section_ref: string; ingredients: { ingredient: string; source_ids: number[]; evidence_in_fir: string | null }[] }[]; grounds: { ground: string }[] };
    expect(l.sections.map((s) => s.section_ref)).toEqual(['PENAL_CODE:323']); // 302 was never analysed
    expect(l.sections[0]!.ingredients.map((i) => [i.ingredient, i.source_ids, i.evidence_in_fir])).toEqual([
      ['voluntarily causing hurt', [1], 'লাঠি দিয়া বাদীকে আঘাত করে'],
      ['with a quote not in the FIR', [1], null],
    ]);
    // A bail ground is fine; the status claim about unverified s.34 is removed, the rest kept.
    expect(l.grounds.map((g) => g.ground)).toEqual(['No weapon was recovered, so bail may be considered.', 'The accused has a fixed address.']);
    expect(flags.sort()).toEqual(['INVALID_CITATION_STRIPPED', 'QUOTE_NOT_IN_TEXT', 'UNCITED_CLAIM_DROPPED', 'UNKNOWN_SECTION_DROPPED', 'UNVERIFIED_STATUS_SENTENCE_REMOVED']);
  });

  it('citizen: status words stay for a verified section, go for an unverified one (Bangla too)', () => {
    const { content, flags } = validateRoleAnalysis(
      'CITIZEN',
      {
        summary: 'বাদীকে মারপিটের অভিযোগে মামলা।',
        sections: [
          { section_ref: 'PENAL_CODE:323', plain_explanation: 'ইচ্ছাকৃতভাবে আঘাত করা। এই অপরাধ জামিনযোগ্য, অর্থাৎ জামিন পাওয়ার অধিকার আছে।', source_ids: [1] },
          { section_ref: 'PENAL_CODE:34', plain_explanation: 'একাধিক ব্যক্তির সাধারণ অভিপ্রায়। এটি জামিন অযোগ্য। আইনজীবীর সাথে কথা বলুন।', source_ids: [2] },
        ],
        next_steps: [{ step: 'এজাহারের কপি সংগ্রহ করুন।', source_ids: [] }],
      },
      ctx,
    );
    const c = content as { sections: { plain_explanation: string }[]; next_steps: unknown[] };
    expect(c.sections[0]!.plain_explanation).toContain('জামিনযোগ্য');
    expect(c.sections[1]!.plain_explanation).toBe('একাধিক ব্যক্তির সাধারণ অভিপ্রায়। আইনজীবীর সাথে কথা বলুন।');
    expect(c.next_steps).toHaveLength(1); // practical steps need no citation
    expect(flags).toEqual(['UNVERIFIED_STATUS_SENTENCE_REMOVED']);
  });

  it('judge: allegation quotes must be in the document', () => {
    const { content, flags } = validateRoleAnalysis(
      'JUDGE',
      {
        sections: [{ section_ref: 'PENAL_CODE:323', ingredients: [{ ingredient: 'hurt', allegation: 'আসামী করিম লাঠি দিয়া বাদীকে আঘাত করে', status: 'ALLEGED', source_ids: [1] }] }],
        observations: [{ text: 'No injury certificate is mentioned.', source_ids: [] }],
      },
      ctx,
    );
    expect(content).toMatchObject({ sections: [{ ingredients: [{ allegation: 'আসামী করিম লাঠি দিয়া বাদীকে আঘাত করে' }] }], observations: [{ text: 'No injury certificate is mentioned.' }] });
    expect(flags).toEqual([]);
  });

  it('removes foreign-script glitches and steps that were only an unverified status claim (seen live)', () => {
    const { content, flags } = validateRoleAnalysis(
      'CITIZEN',
      {
        summary: 'মারপিটের অভিযোগ।',
        sections: [{ section_ref: 'PENAL_CODE:323', plain_explanation: 'আঘাত করা।', source_ids: [1] }],
        next_steps: [
          { step: 'সাক্ষীদের তথ্য রাখুন এবং পুলিশ当他们 যোগাযোগ করলে সহযোগিতা করুন।', source_ids: [] },
          { step: 'এই ধারাগুলো জামিন অযোগ্য।', source_ids: [1, 2] },
        ],
      },
      ctx,
    );
    expect((content as { next_steps: { step: string }[] }).next_steps.map((s) => s.step)).toEqual(['সাক্ষীদের তথ্য রাখুন এবং পুলিশ যোগাযোগ করলে সহযোগিতা করুন।']);
    expect(flags.sort()).toEqual(['UNEXPECTED_SCRIPT_REMOVED', 'UNVERIFIED_STATUS_SENTENCE_REMOVED']);
  });

  it('rejects output that does not match the role schema', () => {
    expect(() => validateRoleAnalysis('JUDGE', { summary: 'wrong shape' }, ctx)).toThrow();
  });
});

describe('buildRoleMessage', () => {
  it('gives numbered sources, verified tags vs NOT_IN_VERIFIED_SCHEDULE, and the redacted document', () => {
    const m = buildRoleMessage({ role: 'LAWYER', language: 'BN', ...ctx });
    expect(m).toContain('<source n="1" section_ref="PENAL_CODE:323">');
    expect(m).toContain('"bailable": true');
    expect(m).toContain('"schedule_ii": "NOT_IN_VERIFIED_SCHEDULE"');
    expect(m).toContain('মোবাইল [ফোন নম্বর]');
    expect(m).not.toContain('০১৭১১');
    expect(m).toContain('Write all text fields in Bangla.');
  });

  it('uses the per-route effort from TRD §7.6', () => {
    expect(ROLE_EFFORT).toEqual({ CITIZEN: 'low', LAWYER: 'high', JUDGE: 'high' });
  });
});
