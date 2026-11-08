import { FirCorrectionsSchema } from '@lawassist/providers';
import { describe, expect, it } from 'vitest';
import { applyCorrections, isCorrectable } from '../src/modules/documents/corrections';

/** Field corrections (BE-26, TRD §8.5). */
const stored = {
  documentKind: 'FIR' as const,
  fir: { police_station: 'মিরপুর', district: 'ঢাকা', informant: { name: 'রহিম', address: null } },
  sections: [{ key: '323' }],
};
const now = new Date('2026-11-08T10:00:00Z');

describe('applyCorrections', () => {
  it('replaces party fields in place and keeps the rest', () => {
    const r = applyCorrections(stored, { police_station: 'পল্লবী' }, now);
    expect(r.analysis.fir).toEqual({ police_station: 'পল্লবী', district: 'ঢাকা', informant: { name: 'রহিম', address: null } });
    expect(r).toMatchObject({ changed: ['police_station'], needsReanalysis: false });
    expect(r.analysis.sections).toEqual([{ key: '323' }]);
  });

  it('records date / section corrections, marks reanalysis, and accumulates over several edits', () => {
    const first = applyCorrections(stored, { cited_sections: [{ act_hint: null, section: '৩২৫' }] }, now);
    expect(first.analysis.corrections).toEqual({ cited_sections: [{ act_hint: null, section: '৩২৫' }], fields: ['cited_sections'], correctedAt: now.toISOString(), needsReanalysis: true });
    const second = applyCorrections(first.analysis, { district: 'গাজীপুর', reported_datetime: '১৩/০৩/২০২৪' }, now);
    expect(second.analysis.corrections).toMatchObject({
      cited_sections: [{ act_hint: null, section: '৩২৫' }],
      reported_datetime: '১৩/০৩/২০২৪',
      fields: ['cited_sections', 'district', 'reported_datetime'],
      needsReanalysis: true,
    });
  });

  it('a null clears a value', () => {
    expect(applyCorrections(stored, { police_station: null }, now).analysis.fir.police_station).toBeNull();
  });

  it('only FIR analyses are correctable', () => {
    expect(isCorrectable(stored)).toBe(true);
    expect(isCorrectable(null)).toBe(false);
    expect(isCorrectable({ documentKind: 'SEIZURE' })).toBe(false);
  });
});

describe('FirCorrectionsSchema', () => {
  it('rejects unknown fields, empty bodies, oversize values and empty accused names', () => {
    expect(FirCorrectionsSchema.safeParse({ structured_analysis: {} }).success).toBe(false);
    expect(FirCorrectionsSchema.safeParse({}).success).toBe(false);
    expect(FirCorrectionsSchema.safeParse({ police_station: 'x'.repeat(201) }).success).toBe(false);
    expect(FirCorrectionsSchema.safeParse({ accused: [{ name: ' ', role_in_allegation: null }] }).success).toBe(false);
    expect(FirCorrectionsSchema.safeParse({ cited_sections: [{ act_hint: null, section: '৩২৩' }] }).success).toBe(true);
  });
});
