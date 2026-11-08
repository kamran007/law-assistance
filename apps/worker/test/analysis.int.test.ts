import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { createDb, crpcScheduleMetadata, newId, runMigrations, scoped, statutes, users, type CaseArtifact, type Db } from '@lawassist/db';
import { CircuitBreaker, LlmNotConfiguredError, LlmRefusalError, type LlmClient, type StructuredRequest } from '@lawassist/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FirExtraction } from '../src/analysis/extract';
import { processAnalysisJob, type StoredAnalysis } from '../src/analysis/job';

/**
 * Analysis queue consumer (BE-23 + BE-24) against MySQL 8.4 (Testcontainers, needs Docker) with a
 * fake LLM: status flow, stored structured_analysis, failure codes, tenant scoping, no text in logs.
 * The live model is exercised by extract.live.test.ts (opt-in).
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;
let owner = '';
let caseId = '';

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));
  owner = newId();
  await db.insert(users).values({ userId: owner, fullName: 'Owner', contactIdentifier: 'owner@example.com' });
  caseId = (await scoped(db, owner).caseFiles.create({ title: 'FIR' }, { withConversation: false })).caseFileId;
  const penal = newId();
  await db.insert(statutes).values({ statuteId: penal, bdlawsActId: 11, titleEn: 'The Penal Code, 1860', language: 'EN', sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-11.html' });
  await db.insert(crpcScheduleMetadata).values({
    scheduleId: newId(),
    statuteId: penal,
    sectionNumber: '323',
    isCognizable: false,
    isBailable: true,
    isCompoundable: true,
    maxPunishment: 'test data',
    triableByCourt: 'test court',
    effectiveFrom: '1898-07-01',
    verifiedBy: 'TEST',
    verifiedAt: new Date(),
  });
}, 180_000);

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const FIR_TEXT =
  'এজাহার। থানা: মিরপুর মডেল, ঢাকা। মামলা নং ১২। ঘটনার তারিখ ও সময়: ১২/০৩/২০২৪ খ্রিঃ রাত অনুমান ০৯.৩০ ঘটিকা। ' +
  'বাদী রহিম, মোবাইল ০১৭১১-১২৩৪৫৬, NID 4612345678। আসামী করিম বাদী রহিমকে মারপিট করে। দণ্ডবিধির ৩২৩/৩৪ ধারায় মামলা রুজু। এজাহার দায়েরের তারিখ: ১৩/০৩/২০২৪ সকাল ১০.০০ ঘটিকা।';

const EXTRACTION: FirExtraction = {
  police_station: 'মিরপুর মডেল',
  district: 'ঢাকা',
  fir_number: '১২',
  gr_number: null,
  occurrence_datetime: '১২/০৩/২০২৪ খ্রিঃ রাত অনুমান ০৯.৩০ ঘটিকা',
  reported_datetime: '১৩/০৩/২০২৪ সকাল ১০.০০ ঘটিকা',
  place_of_occurrence: null,
  informant: { name: 'রহিম', address: null },
  accused: [{ name: 'করিম', role_in_allegation: 'মারপিট' }],
  witnesses: [],
  cited_sections: [
    { act_hint: 'দণ্ডবিধি', section: '৩২৩', raw: '৩২৩/৩৪' },
    { act_hint: 'দণ্ডবিধি', section: '৩৭৯', raw: 'দণ্ডবিধির ৩৭৯ ধারা' }, // invented by the "LLM"
  ],
  narrative_summary: 'আসামী বাদীকে মারপিট করেছে বলে অভিযোগ।',
  field_confidence: { police_station: 'HIGH', fir_number: 'HIGH', occurrence_datetime: 'HIGH', reported_datetime: 'HIGH', informant: 'HIGH', accused: 'HIGH', cited_sections: 'HIGH' },
};

function fakeLlm(behaviour: 'ok' | 'refuse' | 'unconfigured' | 'outage'): LlmClient & { calls: StructuredRequest<unknown>[] } {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    configured: behaviour !== 'unconfigured',
    breaker: new CircuitBreaker(),
    calls,
    model: () => {
      throw new Error('not used');
    },
    async generateStructured<T>(req: StructuredRequest<T>) {
      calls.push(req as StructuredRequest<unknown>);
      if (behaviour === 'unconfigured') throw new LlmNotConfiguredError();
      if (behaviour === 'refuse') throw new LlmRefusalError();
      if (behaviour === 'outage') throw new Error('529 overloaded');
      return { object: EXTRACTION as T, usage: {}, model: 'claude-opus-5-5' };
    },
  };
}

async function extractedDoc(type: CaseArtifact['artifactType'] = 'FIR_SCAN', text = FIR_TEXT) {
  const artifactId = newId();
  const repo = scoped(db, owner);
  await repo.artifacts.createUpload({ artifactId, caseFileId: caseId, artifactType: type, fileStorageKey: `tenants/${owner}/cases/${caseId}/${artifactId}/original.pdf`, mimeType: 'application/pdf' });
  await repo.artifacts.setProcessing(artifactId, { processingStatus: 'EXTRACTING', rawExtractedText: text });
  return { artifactId, ownerUserId: owner };
}

const row = async (id: string) => (await scoped(db, owner).artifacts.findById(id))!;

describe('processAnalysisJob', () => {
  it('extracts, post-processes and stores structured_analysis, then READY', async () => {
    const llm = fakeLlm('ok');
    const logs: object[] = [];
    const job = await extractedDoc();
    expect(await processAnalysisJob({ db, llm, log: { info: (o) => void logs.push(o), warn: (o) => void logs.push(o) } }, job)).toEqual({ status: 'READY', analysed: true });

    // The document goes to the model wrapped as data, with the frozen system prompt.
    expect(llm.calls[0]).toMatchObject({ purpose: 'extraction', effort: 'medium', schemaName: 'fir_extraction' });
    const sent = String(llm.calls[0]!.messages[0]!.content);
    expect(sent.startsWith('<document>\n') && sent.endsWith('\n</document>')).toBe(true);
    // Phone and NID numbers are replaced before the call (TRD §7.6).
    expect(sent).toContain('মোবাইল [ফোন নম্বর], NID [NID]');
    expect(sent).not.toMatch(/০১৭১১|4612345678/);

    const a = await row(job.artifactId);
    expect(a).toMatchObject({ processingStatus: 'READY', processingError: null });
    const s = a.structuredAnalysis as StoredAnalysis;
    expect(s).toMatchObject({
      version: 1,
      documentKind: 'FIR',
      extractionModel: 'claude-opus-5-5',
      filingDelay: { minutes: 750, basis: 'DATETIME' },
      fir: { police_station: 'মিরপুর মডেল', occurrence_datetime_raw: '১২/০৩/২০২৪ খ্রিঃ রাত অনুমান ০৯.৩০ ঘটিকা', accused: [{ name: 'করিম' }] },
    });
    expect(s.sections.map((x) => [x.key, x.source, x.scheduleStatus])).toEqual([
      ['323', 'DETECTOR_AND_LLM', 'VERIFIED'],
      ['34', 'DETECTOR', 'NOT_IN_VERIFIED_SCHEDULE'],
    ]);
    expect(s.rejectedSections).toEqual([{ section: '৩৭৯', actHint: 'দণ্ডবিধি', reason: 'NOT_FOUND_IN_TEXT' }]);
    // No document text or names in the logs (TRD §12.3).
    const logged = JSON.stringify(logs);
    for (const s of ['করিম', 'রহিম', 'মারপিট', 'মিরপুর']) expect(logged).not.toContain(s);
  });

  it('fails with LLM_REFUSED / LLM_NOT_CONFIGURED without retries', async () => {
    const a = await extractedDoc();
    expect(await processAnalysisJob({ db, llm: fakeLlm('refuse'), log: console }, a)).toEqual({ status: 'FAILED', code: 'LLM_REFUSED' });
    expect(await row(a.artifactId)).toMatchObject({ processingStatus: 'FAILED', processingError: 'LLM_REFUSED', structuredAnalysis: null });
    const b = await extractedDoc();
    expect(await processAnalysisJob({ db, llm: fakeLlm('unconfigured'), log: console }, b)).toEqual({ status: 'FAILED', code: 'LLM_NOT_CONFIGURED' });
  });

  it('rethrows provider outages so BullMQ retries; the document stays retryable', async () => {
    const a = await extractedDoc();
    await expect(processAnalysisJob({ db, llm: fakeLlm('outage'), log: console }, a)).rejects.toThrow('529');
    expect((await row(a.artifactId)).processingStatus).toBe('EXTRACTING');
    // The retry then succeeds.
    expect(await processAnalysisJob({ db, llm: fakeLlm('ok'), log: console }, a)).toEqual({ status: 'READY', analysed: true });
  });

  it('marks other document types READY without calling the LLM', async () => {
    const llm = fakeLlm('ok');
    const a = await extractedDoc('SEIZURE_LIST', 'জব্দ তালিকা');
    expect(await processAnalysisJob({ db, llm, log: console }, a)).toEqual({ status: 'READY', analysed: false });
    expect(llm.calls).toHaveLength(0);
  });

  it('skips jobs for finished, deleted or foreign documents', async () => {
    const done = await extractedDoc();
    await processAnalysisJob({ db, llm: fakeLlm('ok'), log: console }, done);
    expect(await processAnalysisJob({ db, llm: fakeLlm('ok'), log: console }, done)).toEqual({ status: 'SKIPPED', reason: 'status READY' });

    const gone = await extractedDoc();
    await scoped(db, owner).artifacts.softDelete(gone.artifactId);
    expect(await processAnalysisJob({ db, llm: fakeLlm('ok'), log: console }, gone)).toMatchObject({ status: 'SKIPPED' });

    // Another user's id for this artifact: scoped() hides it.
    const mine = await extractedDoc();
    expect(await processAnalysisJob({ db, llm: fakeLlm('ok'), log: console }, { artifactId: mine.artifactId, ownerUserId: newId() })).toMatchObject({ status: 'SKIPPED' });
    expect((await row(mine.artifactId)).processingStatus).toBe('EXTRACTING');
  });
});
