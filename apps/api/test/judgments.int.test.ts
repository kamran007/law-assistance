import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { loadConfig } from '@lawassist/config';
import { createDb, judgments, judgmentStatuteRefs, newId, runMigrations, statutes, statuteSections, type Db } from '@lawassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app';
import { JudgmentsRepository } from '../src/modules/judgments/repository';

/**
 * JUD-07 case-law read API against MySQL 8.4 (Testcontainers). Seeds the Penal Code with section
 * 302 amended on 2025-03-01 and three judgments: an AD one decided before the amendment, an HCD
 * one after it, and a scanned AD one still in NEEDS_REVIEW (metadata only).
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;
let app: App;
const presigned: string[] = [];

const ids = { penal: newId(), ad: newId(), hcd: newId(), scanned: newId() };

async function seed() {
  await db.insert(statutes).values({ statuteId: ids.penal, bdlawsActId: 11, titleEn: 'The Penal Code, 1860', language: 'EN', enactedDate: '1860-10-06', sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-11.html' });
  const base = { statuteId: ids.penal, contentHash: 'h'.repeat(64), footnotesHash: 'f'.repeat(64), amendmentFootnotes: [], chapterReference: null, marginalHeading: 'Punishment for murder' };
  await db.insert(statuteSections).values([
    { ...base, sectionId: newId(), sectionNumber: '302', normalizedSectionKey: '302', contentBody: '302. old', versionNumber: 1, isCurrent: false, validFrom: '1860-10-06', validTo: '2025-03-01', validFromSource: 'ENACTMENT_DATE' },
    { ...base, sectionId: newId(), sectionNumber: '302', normalizedSectionKey: '302', contentBody: '302. new', versionNumber: 2, isCurrent: true, validFrom: '2025-03-01', validTo: null, validFromSource: 'AMENDMENT_FOOTNOTE' },
    { ...base, sectionId: newId(), sectionNumber: '34', normalizedSectionKey: '34', contentBody: '34. common intention', versionNumber: 1, isCurrent: true, validFrom: '1860-10-06', validTo: null, validFromSource: 'ENACTMENT_DATE' },
  ]);
  const j = (id: string, over: Partial<typeof judgments.$inferInsert>) => ({
    judgmentId: id,
    issueNumber: 20,
    issueYear: 2025,
    division: 'AD' as const,
    serialNumber: 1,
    citation: '20 SCOB [2025] AD',
    parties: 'The State Vs. Md. Rahim',
    keyWords: 'Section 302 of the Penal Code; Dying declaration',
    keyRatioParagraphs: ['2'],
    sourcePdfUrl: 'https://www.supremecourt.gov.bd/resources/bulletin/20/1.pdf',
    normalizedSectionKeys: [],
    extractionStatus: 'OK' as const,
    ...over,
  });
  await db.insert(judgments).values([
    j(ids.ad, {
      decisionDate: '2019-08-25',
      authoringJudge: 'Syed Refaat Ahmed, J',
      bench: ['Mr. Justice Syed Refaat Ahmed', 'Mr. Justice Md. Iqbal Kabir'],
      fullText: 'APPELLATE DIVISION\nCRIMINAL APPEAL NO. 64 OF 2018\n[para 1] The appellant was convicted under\nsection 302 of the Penal Code.\n[para 2] A dying declaration needs no corroboration.',
      storedPdfKey: 'raw/scob/20/AD/1/abc.pdf',
    }),
    j(ids.hcd, { division: 'HCD', serialNumber: 2, citation: '20 SCOB [2025] HCD', parties: 'Karim Vs. The State', decisionDate: '2025-06-10', authoringJudge: 'Zinat Ara, J', keyWords: 'Sections 302/34 of the Penal Code', fullText: '[para 1] Section 302 read with 34.' }),
    j(ids.scanned, { serialNumber: 3, parties: 'Scanned Vs. Judgment', decisionDate: null, keyWords: 'Section 302 of the Penal Code', fullText: 'x', extractionStatus: 'NEEDS_REVIEW' }),
  ]);
  const ref = (judgmentId: string, key: string, foundIn: 'KEY_WORDS' | 'BODY', paragraphs: string[], statuteId: string | null = ids.penal) => ({
    referenceId: newId(),
    judgmentId,
    statuteId,
    normalizedSectionKey: key,
    rawReferenceText: `Section ${key} of the Penal Code`,
    paragraphNumbers: paragraphs,
    foundIn,
  });
  await db.insert(judgmentStatuteRefs).values([
    ref(ids.ad, '302', 'KEY_WORDS', []),
    ref(ids.ad, '302', 'BODY', ['1']),
    ref(ids.ad, '63', 'BODY', ['2'], null), // an Act not in the corpus
    ref(ids.hcd, '302', 'BODY', ['1']),
    ref(ids.hcd, '34', 'BODY', ['1']),
    ref(ids.scanned, '302', 'KEY_WORDS', []),
  ]);
}

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));
  await seed();
  app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: url }), {
    judgments: {
      repo: new JudgmentsRepository(db),
      storage: { presignGet: async (key) => (presigned.push(key), `https://s3.test/${key}?sig=1`) },
    },
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await close?.();
  await container?.stop();
});

const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}` });

describe('GET /judgments', () => {
  it('lists newest first (no decision date: placed by bulletin year); no login needed', async () => {
    const res = await get('/judgments');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    // HCD 2025-06-10, then the undated one from the 2025 bulletin, then AD 2019-08-25.
    expect(body.items.map((i: { judgment_id: string }) => i.judgment_id)).toEqual([ids.hcd, ids.scanned, ids.ad]);
    expect(body.items[1]).toMatchObject({ text_available: false, decision_date: null });
  });

  it('filters by words, division, year, judge, Act and section', async () => {
    const pick = async (q: string) => (await get(`/judgments?${q}`)).json().items.map((i: { judgment_id: string }) => i.judgment_id);
    expect(await pick('q=dying declaration')).toContain(ids.ad);
    expect(await pick('q=Karim')).toEqual([ids.hcd]);
    expect(await pick('division=HCD')).toEqual([ids.hcd]);
    expect(await pick('year=2019')).toEqual([ids.ad]);
    expect(await pick('year=2025')).toEqual([ids.hcd, ids.scanned]); // no decision date → bulletin year
    expect(await pick('judge=Iqbal')).toEqual([ids.ad]); // bench member
    expect(await pick('judge=zinat')).toEqual([ids.hcd]);
    expect(await pick('judge=50%25')).toEqual([]); // LIKE wildcards are escaped
    expect(await pick('act_id=11&sec=34')).toEqual([ids.hcd]);
    expect(await pick('act_id=11&sec=৩০২')).toEqual([ids.hcd, ids.scanned, ids.ad]);
    expect(await pick('act_id=999')).toEqual([]);
  });

  it('rejects a section without an Act and bad section numbers', async () => {
    expect((await get('/judgments?sec=302')).json()).toMatchObject({ code: 'SECTION_NEEDS_ACT' });
    expect((await get('/judgments?act_id=11&sec=@@')).statusCode).toBe(422);
  });
});

describe('GET /judgments/{id}', () => {
  it('returns metadata, preamble, paragraphs, linked sections and a presigned PDF link', async () => {
    const res = await get(`/judgments/${ids.ad}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      citation: '20 SCOB [2025] AD',
      bench: ['Mr. Justice Syed Refaat Ahmed', 'Mr. Justice Md. Iqbal Kabir'],
      key_ratio_paragraphs: ['2'],
      preamble: 'APPELLATE DIVISION\nCRIMINAL APPEAL NO. 64 OF 2018',
      paragraphs: [
        { n: 1, text: 'The appellant was convicted under section 302 of the Penal Code.' },
        { n: 2, text: 'A dying declaration needs no corroboration.' },
      ],
      pdf_url: 'https://s3.test/raw/scob/20/AD/1/abc.pdf?sig=1',
      text_available: true,
    });
    expect(body.linked_sections).toEqual([
      { act_id: 11, act_title: 'The Penal Code, 1860', sec: '302', raw: 'Section 302 of the Penal Code', paragraphs: [], found_in: 'KEY_WORDS' },
      { act_id: 11, act_title: 'The Penal Code, 1860', sec: '302', raw: 'Section 302 of the Penal Code', paragraphs: ['1'], found_in: 'BODY' },
      { act_id: null, act_title: null, sec: '63', raw: 'Section 63 of the Penal Code', paragraphs: ['2'], found_in: 'BODY' },
    ]);
  });

  it('a judgment in review shows metadata only; unknown ids are 404, bad ids 422', async () => {
    expect((await get(`/judgments/${ids.scanned}`)).json()).toMatchObject({ paragraphs: [], preamble: null, pdf_url: null, extraction_status: 'NEEDS_REVIEW' });
    expect((await get(`/judgments/${newId()}`)).json()).toMatchObject({ code: 'JUDGMENT_NOT_FOUND' });
    expect((await get('/judgments/not-a-uuid')).statusCode).toBe(422);
  });
});

describe('GET /statutes/{act}/sections/{sec}/judgments', () => {
  it('flags judgments decided before the current wording (FR-D6), with the citing paragraphs', async () => {
    const res = await get('/statutes/11/sections/302/judgments');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ act_id: 11, sec: '302', total: 3 });
    expect(body.items.map((i: { judgment_id: string; older_than_current_version: boolean | null; paragraphs: string[] }) => [i.judgment_id, i.older_than_current_version, i.paragraphs])).toEqual([
      [ids.hcd, false, ['1']],
      [ids.scanned, null, []],
      [ids.ad, true, ['1']],
    ]);
    expect(body.items[2].section_amended_on).toBe('2025-03-01');
  });

  it('an unamended section has no amendment date; paging works; unknown Act / section are 404', async () => {
    const s34 = (await get('/statutes/11/sections/34/judgments')).json();
    expect(s34.items).toEqual([expect.objectContaining({ judgment_id: ids.hcd, older_than_current_version: false, section_amended_on: null })]);
    const page = (await get('/statutes/11/sections/302/judgments?limit=1&offset=1')).json();
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1, items: [expect.objectContaining({ judgment_id: ids.scanned })] });
    expect((await get('/statutes/999/sections/302/judgments')).json()).toMatchObject({ code: 'STATUTE_NOT_FOUND' });
    expect((await get('/statutes/11/sections/999/judgments')).json()).toMatchObject({ code: 'SECTION_NOT_FOUND' });
  });
});
