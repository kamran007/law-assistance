import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { loadConfig } from '@lawassist/config';
import { createDb, crpcScheduleMetadata, newId, runMigrations, statutes, statuteSections, type Db, type UserRole } from '@lawassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Authenticate } from '../src/auth';
import type { SectionCache } from '../src/modules/statutes/cache';
import { StatutesRepository } from '../src/modules/statutes/repository';

/**
 * BE-06 statute read API against MySQL 8.4 (Testcontainers, needs Docker). Seeds a small corpus
 * directly: an amended section with two versions, an inserted section, lettered sections out of
 * order, a Bangla Act, a repealed Act, and verified + unverified Schedule II rows.
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;
let app: App;
const cacheStore = new Map<string, string>();

/** Test auth: the caller's role comes from a header (BE-03/04 replace this with JWTs). */
const authenticate: Authenticate = async (req) => {
  const role = req.headers['x-test-role'];
  if (typeof role !== 'string') return null;
  return { userId: 'test-user', role: role as UserRole, verificationStatus: req.headers['x-test-verified'] === 'no' ? 'PENDING' : 'VERIFIED' };
};

const memoryCache: SectionCache = {
  get: async (a, k, d) => cacheStore.get(`${a}:${k}:${d}`) ?? null,
  set: async (a, k, d, v) => void cacheStore.set(`${a}:${k}:${d}`, v),
};

const ids = { penal: newId(), nari: newId(), gambling: newId(), s420v1: newId(), s420v2: newId() };

async function seed() {
  await db.insert(statutes).values([
    { statuteId: ids.penal, bdlawsActId: 11, titleEn: 'The Penal Code, 1860', actNumber: 'ACT NO. XLV OF 1860', language: 'EN', enactedDate: '1860-10-06', sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-11.html' },
    { statuteId: ids.nari, bdlawsActId: 835, titleBn: 'নারী ও শিশু নির্যাতন দমন আইন, ২০০০', actNumber: '2000 সনের 8 নং আইন', language: 'BN', enactedDate: '2000-02-14', sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-835.html' },
    { statuteId: ids.gambling, bdlawsActId: 16, titleEn: 'The Public Gambling Act, 1867', actNumber: 'ACT NO. II OF 1867', language: 'EN', enactedDate: '1867-04-10', status: 'REPEALED', sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-16.html' },
  ]);
  const base = { contentHash: 'h'.repeat(64), footnotesHash: 'f'.repeat(64), amendmentFootnotes: [], validFromSource: 'ENACTMENT_DATE' as const, versionNumber: 1, isCurrent: true, validFrom: '1860-10-06', validTo: null };
  const ch17 = 'Chapter XVII OF OFFENCES AGAINST PROPERTY';
  await db.insert(statuteSections).values([
    { ...base, sectionId: newId(), statuteId: ids.penal, sectionNumber: '2', normalizedSectionKey: '2', chapterReference: 'Chapter I INTRODUCTION', marginalHeading: 'Punishment of offences committed within Bangladesh', contentBody: '2. Every person shall be liable to punishment under this Code.' },
    { ...base, sectionId: ids.s420v1, statuteId: ids.penal, sectionNumber: '420', normalizedSectionKey: '420', chapterReference: ch17, marginalHeading: 'Cheating', contentBody: '420. … may extend to seven years …', isCurrent: false, validTo: '2025-03-01' },
    {
      ...base,
      sectionId: ids.s420v2,
      statuteId: ids.penal,
      sectionNumber: '420',
      normalizedSectionKey: '420',
      chapterReference: ch17,
      marginalHeading: 'Cheating',
      contentBody: '420. … may extend to 3[ten years] …',
      versionNumber: 2,
      validFrom: '2025-03-01',
      validFromSource: 'AMENDMENT_FOOTNOTE',
      amendmentFootnotes: [{ action: 'SUBSTITUTED', byAct: 'Act No. 3 of 2025', date: '2025-03-01', text: 'Substituted by Act No. 3 of 2025' }],
    },
    { ...base, sectionId: newId(), statuteId: ids.penal, sectionNumber: '415', normalizedSectionKey: '415', chapterReference: ch17, marginalHeading: 'Cheating', contentBody: '415. Whoever, by deceiving any person …' },
    { ...base, sectionId: newId(), statuteId: ids.penal, sectionNumber: '326A', normalizedSectionKey: '326A', chapterReference: 'Chapter XVI OF OFFENCES AFFECTING THE HUMAN BODY', marginalHeading: 'Hurt by dangerous substance', contentBody: '1[326A. Whoever …]', validFrom: '1984-07-01', validFromSource: 'AMENDMENT_FOOTNOTE' },
    { ...base, sectionId: newId(), statuteId: ids.penal, sectionNumber: '171-I', normalizedSectionKey: '171I', chapterReference: 'Chapter IXA OF OFFENCES RELATING TO ELECTIONS', marginalHeading: 'Failure to keep election accounts', contentBody: '171-I. Whoever …' },
    { ...base, sectionId: newId(), statuteId: ids.penal, sectionNumber: '171', normalizedSectionKey: '171', chapterReference: 'Chapter IX OF OFFENCES BY OR RELATING TO PUBLIC SERVANTS', marginalHeading: 'Wearing garb', contentBody: '171. Whoever …' },
    { ...base, sectionId: newId(), statuteId: ids.nari, sectionNumber: '১১ক', normalizedSectionKey: '11A', chapterReference: null, marginalHeading: 'যৌতুকের জন্য নির্যাতন', contentBody: '১১ক। যদি কোন নারীর স্বামী …', validFrom: '2003-07-01' },
    { ...base, sectionId: newId(), statuteId: ids.gambling, sectionNumber: '1', normalizedSectionKey: '1', chapterReference: null, marginalHeading: 'Short title', contentBody: '1. This Act may be called …', validFrom: '1867-04-10' },
  ]);
  const sched = { scheduleId: newId(), statuteId: ids.penal, isCognizable: false, isBailable: false, isCompoundable: true, triableByCourt: 'Magistrate of the first class' };
  await db.insert(crpcScheduleMetadata).values([
    { ...sched, scheduleId: newId(), sectionNumber: '420', maxPunishment: 'Imprisonment for 7 years, and fine', effectiveFrom: '1898-07-01', effectiveTo: '2025-03-01', verifiedBy: 'LEGAL-SME', verifiedAt: new Date() },
    { ...sched, scheduleId: newId(), sectionNumber: '420', maxPunishment: 'Imprisonment for 10 years, and fine', effectiveFrom: '2025-03-01', verifiedBy: 'LEGAL-SME', verifiedAt: new Date() },
    // Not verified by a lawyer yet: must never be served (TRD §6.5).
    { ...sched, scheduleId: newId(), sectionNumber: '415', maxPunishment: 'draft', effectiveFrom: '1898-07-01' },
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
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url });
  app = await buildApp(config, { statutes: { repo: new StatutesRepository(db), cache: memoryCache, authenticate, today: () => '2026-11-04' } });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await close?.();
  await container?.stop();
});

const get = (url: string, role?: UserRole, verified = true) =>
  app.inject({ method: 'GET', url: `/api/v1${url}`, headers: role ? { 'x-test-role': role, 'x-test-verified': verified ? 'yes' : 'no' } : {} });

describe('GET /statutes', () => {
  it('searches English and Bangla titles with the ngram FULLTEXT index', async () => {
    const en = (await get('/statutes?q=penal code')).json();
    expect(en.items[0]).toMatchObject({ act_id: 11, title: 'The Penal Code, 1860', act_number: 'ACT NO. XLV OF 1860', status: 'ACTIVE' });
    const bn = (await get(`/statutes?q=${encodeURIComponent('নারী ও শিশু')}`)).json();
    expect(bn.items.map((s: { act_id: number }) => s.act_id)).toEqual([835]);
    expect(bn.items[0]).toMatchObject({ title: 'নারী ও শিশু নির্যাতন দমন আইন, ২০০০', language: 'BN', title_en: null });
  });

  it('a search requires every word and lists the matches newest first, or best match first on request', async () => {
    const ids = async (q: string) => (await get(`/statutes?${q}`)).json().items.map((s: { act_id: number }) => s.act_id);
    expect(await ids('q=penal code')).toEqual([11]); // both words required: no loose ngram matches
    expect(await ids('q=the')).toEqual([16, 11]); // Gambling Act 1867 before Penal Code 1860
    expect(await ids('q=the&sort=relevance')).toHaveLength(2);
    expect((await get('/statutes?sort=oldest')).statusCode).toBe(422);
  });

  it('filters by status and year, and pages through the list', async () => {
    expect((await get('/statutes?status=REPEALED')).json().items.map((s: { act_id: number }) => s.act_id)).toEqual([16]);
    expect((await get('/statutes?year=1860')).json().items.map((s: { act_id: number }) => s.act_id)).toEqual([11]);
    const page = (await get('/statutes?limit=2&offset=1')).json();
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(page.items.map((s: { act_id: number }) => s.act_id)).toEqual([16, 11]); // newest enactment first: 835 (2000), 16 (1867), 11 (1860)
  });

  it('rejects bad query parameters with a 422 problem', async () => {
    const res = await get('/statutes?limit=500');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /statutes/{act_id}', () => {
  it('returns the chapter tree with current sections in natural order', async () => {
    const res = await get('/statutes/11');
    expect(res.statusCode).toBe(200);
    const act = res.json();
    expect(act).toMatchObject({ act_id: 11, source_url: 'http://bdlaws.minlaw.gov.bd/act-print-11.html' });
    expect(act.chapters.map((c: { chapter: string; sections: { sec: string }[] }) => [c.chapter, c.sections.map((s) => s.sec)])).toEqual([
      ['Chapter I INTRODUCTION', ['2']],
      ['Chapter IX OF OFFENCES BY OR RELATING TO PUBLIC SERVANTS', ['171']],
      ['Chapter IXA OF OFFENCES RELATING TO ELECTIONS', ['171I']],
      ['Chapter XVI OF OFFENCES AFFECTING THE HUMAN BODY', ['326A']],
      ['Chapter XVII OF OFFENCES AGAINST PROPERTY', ['415', '420']],
    ]);
    expect(act.chapters[2].sections[0]).toEqual({ sec: '171I', section_number: '171-I', heading: 'Failure to keep election accounts' });
  });

  it('404s for an unknown Act', async () => {
    const res = await get('/statutes/999999');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('STATUTE_NOT_FOUND');
  });
});

describe('GET /statutes/{act_id}/sections/{sec}', () => {
  it('returns the current verbatim text, footnotes and the verified Schedule II strip', async () => {
    const res = await get('/statutes/11/sections/420');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.section).toMatchObject({
      section_id: ids.s420v2,
      sec: '420',
      text: '420. … may extend to 3[ten years] …',
      version: 2,
      is_current: true,
      valid_from: '2025-03-01',
      valid_to: null,
      valid_from_source: 'AMENDMENT_FOOTNOTE',
      footnotes: [{ action: 'SUBSTITUTED', by_act: 'Act No. 3 of 2025', date: '2025-03-01', text: 'Substituted by Act No. 3 of 2025' }],
    });
    expect(body).toMatchObject({ law_as_of: null, current_version: 2 });
    expect(body.schedule_ii).toMatchObject({ is_bailable: false, is_compoundable: true, max_punishment: 'Imprisonment for 10 years, and fine' });
  });

  it('accepts Bangla digits and letters in the section number', async () => {
    expect((await get(`/statutes/11/sections/${encodeURIComponent('৪২০')}`)).json().section.section_id).toBe(ids.s420v2);
    expect((await get(`/statutes/835/sections/${encodeURIComponent('১১ক')}`)).json().section).toMatchObject({ sec: '11A', section_number: '১১ক' });
  });

  it('never serves an unverified Schedule II row', async () => {
    expect((await get('/statutes/11/sections/415')).json().schedule_ii).toBeNull();
  });

  it('serves repealed Acts with their status', async () => {
    expect((await get('/statutes/16/sections/1')).json().act).toMatchObject({ status: 'REPEALED' });
  });

  it('gives point-in-time law to verified lawyers and judges only', async () => {
    expect((await get('/statutes/11/sections/420?as_of=2020-01-01')).statusCode).toBe(401);
    expect((await get('/statutes/11/sections/420?as_of=2020-01-01', 'CITIZEN')).json().code).toBe('ROLE_FORBIDDEN');
    expect((await get('/statutes/11/sections/420?as_of=2020-01-01', 'LAWYER', false)).json().code).toBe('VERIFICATION_REQUIRED');

    const old = (await get('/statutes/11/sections/420?as_of=2020-01-01', 'LAWYER')).json();
    expect(old.section).toMatchObject({ section_id: ids.s420v1, version: 1, is_current: false, valid_to: '2025-03-01' });
    expect(old).toMatchObject({ law_as_of: '2020-01-01', current_version: 2 });
    expect(old.schedule_ii.max_punishment).toBe('Imprisonment for 7 years, and fine'); // schedule as it stood then
  });

  it('treats valid_to as exclusive: on the amendment date the new text applies', async () => {
    expect((await get('/statutes/11/sections/420?as_of=2025-02-28', 'JUDGE')).json().section.version).toBe(1);
    expect((await get('/statutes/11/sections/420?as_of=2025-03-01', 'JUDGE')).json().section.version).toBe(2);
  });

  it('explains when a section was not yet in force on the date', async () => {
    const res = await get('/statutes/11/sections/326A?as_of=1900-01-01', 'LAWYER');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'SECTION_NOT_IN_FORCE', detail: 'Earliest version is in force from 1984-07-01' });
  });

  it('404s for unknown sections and 422s for invalid ones', async () => {
    expect((await get('/statutes/11/sections/9999')).json().code).toBe('SECTION_NOT_FOUND');
    expect((await get('/statutes/11/sections/abc')).json()).toMatchObject({ status: 422, code: 'INVALID_SECTION' });
    expect((await get('/statutes/11/sections/420?as_of=2020-13-40', 'LAWYER')).json().code).toBe('VALIDATION_FAILED');
  });

  it('serves repeat reads from the cache', async () => {
    cacheStore.clear();
    await get('/statutes/11/sections/2');
    expect([...cacheStore.keys()]).toEqual(['11:2:null']);
    // Change the row behind the cache: the cached copy is served until the generation changes.
    await db.update(statuteSections).set({ contentBody: 'changed' }).where(eq(statuteSections.normalizedSectionKey, '2'));
    expect((await get('/statutes/11/sections/2')).json().section.text).toBe('2. Every person shall be liable to punishment under this Code.');
    cacheStore.clear();
    expect((await get('/statutes/11/sections/2')).json().section.text).toBe('changed');
  });
});

describe('GET /statutes/{act_id}/sections/{sec}/versions', () => {
  it('lists every version for lawyers and judges', async () => {
    expect((await get('/statutes/11/sections/420/versions')).statusCode).toBe(401);
    const res = await get('/statutes/11/sections/420/versions', 'JUDGE');
    expect(res.statusCode).toBe(200);
    expect(res.json().versions.map((v: { version: number; valid_from: string; valid_to: string | null }) => [v.version, v.valid_from, v.valid_to])).toEqual([
      [1, '1860-10-06', '2025-03-01'],
      [2, '2025-03-01', null],
    ]);
  });
});

describe('OpenAPI', () => {
  it('documents the statute routes', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/docs/json' })).json();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/api/v1/statutes', '/api/v1/statutes/{act_id}', '/api/v1/statutes/{act_id}/sections/{sec}', '/api/v1/statutes/{act_id}/sections/{sec}/versions']),
    );
  });
});
