import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { createDb, crpcScheduleMetadata, newId, runMigrations, statutes, type Db } from '@lawassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postProcessFir } from '../src/analysis/post-process';

/**
 * Scan pipeline stages 4–5 (BE-24) against MySQL 8.4 (Testcontainers, needs Docker): date parsing,
 * delay, detector merge and the Schedule II join with its verified-only and effective-date rules.
 * The schedule rows below are TEST DATA, not legal facts.
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;

const penal = newId();
const nari = newId();

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));

  await db.insert(statutes).values([
    { statuteId: penal, bdlawsActId: 11, titleEn: 'The Penal Code, 1860', language: 'EN', sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-11.html' },
    { statuteId: nari, bdlawsActId: 835, titleBn: 'নারী ও শিশু নির্যাতন দমন আইন, ২০০০', language: 'BN', sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-835.html' },
  ]);
  const base = { triableByCourt: 'test court', verifiedBy: 'TEST', verifiedAt: new Date() };
  await db.insert(crpcScheduleMetadata).values([
    { ...base, scheduleId: newId(), statuteId: penal, sectionNumber: '323', isCognizable: false, isBailable: true, isCompoundable: true, maxPunishment: 'test: 1 year', effectiveFrom: '1898-07-01' },
    // 307 changed on 2020-01-01 (test data): which row applies depends on the occurrence date.
    { ...base, scheduleId: newId(), statuteId: penal, sectionNumber: '307', isCognizable: true, isBailable: true, isCompoundable: false, maxPunishment: 'test: old', effectiveFrom: '1898-07-01', effectiveTo: '2020-01-01' },
    { ...base, scheduleId: newId(), statuteId: penal, sectionNumber: '307', isCognizable: true, isBailable: false, isCompoundable: false, maxPunishment: 'test: new', effectiveFrom: '2020-01-01' },
    // Not verified by a lawyer: must never be used (TRD §6.5).
    { ...base, verifiedBy: null, verifiedAt: null, scheduleId: newId(), statuteId: penal, sectionNumber: '325', isCognizable: true, isBailable: true, isCompoundable: false, maxPunishment: 'draft', effectiveFrom: '1898-07-01' },
    // Clause-specific row beats the section row.
    { ...base, scheduleId: newId(), statuteId: nari, sectionNumber: '11(গ)', isCognizable: true, isBailable: false, isCompoundable: true, maxPunishment: 'test: clause', effectiveFrom: '2000-02-14' },
    { ...base, scheduleId: newId(), statuteId: nari, sectionNumber: '11', isCognizable: true, isBailable: false, isCompoundable: false, maxPunishment: 'test: section', effectiveFrom: '2000-02-14' },
  ]);
}, 180_000);

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const FIR =
  'ঘটনার তারিখ ও সময়: ১২/০৩/২০২৪ খ্রিঃ রাত অনুমান ০৯.৩০ ঘটিকা। আসামীগণ বাদীকে মারপিট করিয়া জখম করে। ' +
  'দণ্ডবিধির ৩২৩/৩২৫/৩০৭/৩৪ ধারায় এবং নারী ও শিশু নির্যাতন দমন আইন, ২০০০ এর ১১(গ) ধারায় মামলা রুজু করা হইল।';

describe('postProcessFir (stages 4–5)', () => {
  it('parses dates, computes the delay, merges sections and joins verified Schedule II rows', async () => {
    const r = await postProcessFir(db, {
      text: FIR,
      extraction: {
        occurrence_datetime: '১২/০৩/২০২৪ খ্রিঃ রাত অনুমান ০৯.৩০ ঘটিকা',
        reported_datetime: '১৪/০৩/২০২৪ সকাল ১০.০০ ঘটিকা',
        cited_sections: [
          { act_hint: 'দণ্ডবিধি', section: '৩০৭', raw: '৩০৭' },
          { act_hint: 'দণ্ডবিধি', section: '৩০২', raw: 'দণ্ডবিধির ৩০২ ধারা' }, // invented: not in the text
        ],
      },
    });

    expect(r.occurrence).toMatchObject({ date: '2024-03-12', time: '21:30', approximate: true });
    expect(r.filingDelay).toEqual({ minutes: 2190, days: 2, basis: 'DATETIME', warning: null });
    expect(r).toMatchObject({ scheduleDate: '2024-03-12', scheduleDateBasis: 'OCCURRENCE' });
    expect(r.rejectedSections).toEqual([{ section: '৩০২', actHint: 'দণ্ডবিধি', reason: 'NOT_FOUND_IN_TEXT' }]);

    const tags = Object.fromEntries(r.sections.map((s) => [`${s.act?.key}:${s.key}${s.subsection ?? ''}`, s]));
    expect(Object.keys(tags)).toEqual(['PENAL_CODE:323', 'PENAL_CODE:325', 'PENAL_CODE:307', 'PENAL_CODE:34', 'NARI_SHISHU:11(গ)']);
    expect(tags['PENAL_CODE:323']).toMatchObject({ scheduleStatus: 'VERIFIED', schedule: { isBailable: true, isCompoundable: true } });
    // The unverified 325 row is ignored.
    expect(tags['PENAL_CODE:325']).toMatchObject({ scheduleStatus: 'NOT_IN_VERIFIED_SCHEDULE', schedule: null });
    // 2024 occurrence → the row in force since 2020.
    expect(tags['PENAL_CODE:307']).toMatchObject({ source: 'DETECTOR_AND_LLM', scheduleStatus: 'VERIFIED', schedule: { maxPunishment: 'test: new', isBailable: false } });
    expect(tags['PENAL_CODE:34']!.scheduleStatus).toBe('NOT_IN_VERIFIED_SCHEDULE');
    expect(tags['NARI_SHISHU:11(গ)']).toMatchObject({ scheduleStatus: 'VERIFIED', schedule: { matchedSection: '11(গ)', maxPunishment: 'test: clause' } });
  });

  it('uses the schedule row in force on the occurrence date, not today', async () => {
    const r = await postProcessFir(db, {
      text: 'দণ্ডবিধির ৩০৭ ধারা',
      extraction: { occurrence_datetime: '১০/০৫/২০১৮ সকাল ১০টা', reported_datetime: null, cited_sections: [] },
    });
    expect(r.sections[0]).toMatchObject({ key: '307', schedule: { maxPunishment: 'test: old', isBailable: true } });
    expect(r.filingDelay.basis).toBe('UNKNOWN');
  });

  it('falls back to the report date, then today, and says which it used', async () => {
    const byReport = await postProcessFir(db, {
      text: 'u/s 307 of the Penal Code',
      extraction: { occurrence_datetime: 'অজ্ঞাত', reported_datetime: '05/06/2019', cited_sections: [] },
    });
    expect(byReport).toMatchObject({ scheduleDate: '2019-06-05', scheduleDateBasis: 'REPORTED', sections: [{ schedule: { maxPunishment: 'test: old' } }] });

    const byToday = await postProcessFir(db, {
      text: 'u/s 307 of the Penal Code',
      extraction: { occurrence_datetime: null, reported_datetime: null, cited_sections: [] },
      today: '2026-11-05',
    });
    expect(byToday).toMatchObject({ scheduleDate: '2026-11-05', scheduleDateBasis: 'TODAY', sections: [{ schedule: { maxPunishment: 'test: new' } }] });
  });

  it('tags sections of Acts that are not in the statutes table as not in the verified schedule', async () => {
    const r = await postProcessFir(db, {
      text: 'অস্ত্র আইনের ১৯এ ধারা',
      extraction: { occurrence_datetime: null, reported_datetime: null, cited_sections: [] },
      today: '2026-11-05',
    });
    expect(r.sections).toMatchObject([{ key: '19A', act: { key: 'ARMS_ACT' }, scheduleStatus: 'NOT_IN_VERIFIED_SCHEDULE', schedule: null }]);
  });
});
