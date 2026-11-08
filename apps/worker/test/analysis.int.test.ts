import { generateKeyPairSync } from 'node:crypto';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { createDb, crpcScheduleMetadata, newId, runMigrations, scoped, statutes, statuteSections, users, type CaseArtifact, type Db } from '@lawassist/db';
import { CircuitBreaker, FcmPushNotifier, LlmNotConfiguredError, LlmRefusalError, MemoryArtifactEvents, PUSH_TEXT, parseServiceAccount, type LlmClient, type StructuredRequest } from '@lawassist/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FirExtraction } from '../src/analysis/extract';
import { processAnalysisJob, type RoleAnalysisRecord, type StoredAnalysis } from '../src/analysis/job';
import { dbPushTokenStore } from '../src/push';

/**
 * Analysis queue consumer (BE-23, BE-24, BE-25) against MySQL 8.4 (Testcontainers, needs Docker)
 * with a fake LLM: status flow EXTRACTING → SCHEDULE_LOOKUP → ANALYZING → READY, stored
 * structured_analysis and role_analysis, failure codes, resume after outage, tenant scoping, no text
 * in logs. The live model is exercised by extract.live.test.ts (opt-in).
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;
let citizen = '';
let lawyer = '';
const cases: Record<string, string> = {};
const penal = newId();
const s323 = newId();

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));
  citizen = newId();
  lawyer = newId();
  await db.insert(users).values([
    { userId: citizen, fullName: 'Citizen', contactIdentifier: 'citizen@example.com' },
    { userId: lawyer, fullName: 'Lawyer', contactIdentifier: 'lawyer@example.com', role: 'LAWYER', requestedRole: 'LAWYER', verificationStatus: 'VERIFIED', preferredLanguage: 'EN' },
  ]);
  cases[citizen] = (await scoped(db, citizen).caseFiles.create({ title: 'FIR' }, { withConversation: false })).caseFileId;
  cases[lawyer] = (await scoped(db, lawyer).caseFiles.create({ title: 'FIR' }, { withConversation: false })).caseFileId;

  await db.insert(statutes).values({ statuteId: penal, bdlawsActId: 11, titleEn: 'The Penal Code, 1860', language: 'EN', sourceUrl: 'http://bdlaws.minlaw.gov.bd/act-print-11.html' });
  await db.insert(statuteSections).values({
    sectionId: s323,
    statuteId: penal,
    sectionNumber: '323',
    normalizedSectionKey: '323',
    marginalHeading: 'Punishment for voluntarily causing hurt',
    contentBody: 'Whoever, except in the case provided for by section 334, voluntarily causes hurt, shall be punished … (test text)',
    amendmentFootnotes: [],
    contentHash: 'a'.repeat(64),
    footnotesHash: 'b'.repeat(64),
    versionNumber: 1,
    isCurrent: true,
    validFrom: '1860-10-06',
    validFromSource: 'ENACTMENT_DATE',
  });
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

const ROLE_OUTPUT: Record<string, unknown> = {
  citizen_analysis: {
    summary: 'বাদীকে মারপিটের অভিযোগে মামলা।',
    sections: [{ section_ref: 'PENAL_CODE:323', plain_explanation: 'ইচ্ছাকৃতভাবে আঘাত করা।', source_ids: [1] }],
    next_steps: [{ step: 'এজাহারের কপি সংগ্রহ করুন।', source_ids: [] }],
  },
  lawyer_analysis: {
    sections: [{ section_ref: 'PENAL_CODE:323', ingredients: [{ ingredient: 'voluntarily causes hurt', status: 'ALLEGED', evidence_in_fir: 'বাদী রহিমকে মারপিট করে', source_ids: [1, 5] }] }],
    delay: { assessment: 'UNEXPLAINED', note: 'No reason given for the 12.5 h delay.', evidence_in_fir: null },
    grounds: [{ kind: 'BAIL', ground: 'Simple hurt only; no weapon alleged.', source_ids: [1] }],
  },
};

type Behaviour = 'ok' | 'refuse' | 'unconfigured' | 'outage' | 'refuseRole' | 'outageRole';
function fakeLlm(behaviour: Behaviour): LlmClient & { calls: StructuredRequest<unknown>[] } {
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
      const isRole = req.schemaName !== 'fir_extraction';
      if (behaviour === 'unconfigured') throw new LlmNotConfiguredError();
      if (behaviour === 'refuse' || (behaviour === 'refuseRole' && isRole)) throw new LlmRefusalError();
      if (behaviour === 'outage' || (behaviour === 'outageRole' && isRole)) throw new Error('529 overloaded');
      return { object: (isRole ? ROLE_OUTPUT[req.schemaName] : EXTRACTION) as T, usage: {}, model: 'claude-opus-5-5' };
    },
  };
}

async function extractedDoc(owner = citizen, type: CaseArtifact['artifactType'] = 'FIR_SCAN', text = FIR_TEXT) {
  const artifactId = newId();
  const repo = scoped(db, owner);
  await repo.artifacts.createUpload({ artifactId, caseFileId: cases[owner]!, artifactType: type, fileStorageKey: `tenants/${owner}/cases/${cases[owner]}/${artifactId}/original.pdf`, mimeType: 'application/pdf' });
  await repo.artifacts.setProcessing(artifactId, { processingStatus: 'EXTRACTING', rawExtractedText: text });
  return { artifactId, ownerUserId: owner };
}

const row = async (id: string, owner = citizen) => (await scoped(db, owner).artifacts.findById(id))!;
const quiet = { info: () => undefined, warn: () => undefined };

describe('processAnalysisJob', () => {
  it('citizen: extracts, post-processes, saves structured_analysis, then a validated role_analysis, READY', async () => {
    const llm = fakeLlm('ok');
    const logs: object[] = [];
    const job = await extractedDoc();
    expect(await processAnalysisJob({ db, llm, log: { info: (o) => void logs.push(o), warn: (o) => void logs.push(o) } }, job)).toEqual({
      status: 'READY',
      analysed: true,
      roleAnalysis: 'READY',
    });

    // Stage 3: the document goes to the model wrapped as data, phone/NID replaced.
    expect(llm.calls[0]).toMatchObject({ purpose: 'extraction', effort: 'medium', schemaName: 'fir_extraction' });
    const sent = String(llm.calls[0]!.messages[0]!.content);
    expect(sent.startsWith('<document>\n') && sent.endsWith('\n</document>')).toBe(true);
    expect(sent).toContain('মোবাইল [ফোন নম্বর], NID [NID]');
    expect(sent).not.toMatch(/০১৭১১|4612345678/);
    // Stage 6: citizen schema at low effort, with s.323's text pinned as source 1.
    expect(llm.calls[1]).toMatchObject({ purpose: 'assistant', effort: 'low', schemaName: 'citizen_analysis' });
    expect(String(llm.calls[1]!.messages[0]!.content)).toContain('<source n="1" section_ref="PENAL_CODE:323">');

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

    const r = a.roleAnalysis as RoleAnalysisRecord;
    expect(r).toMatchObject({ status: 'READY', role: 'CITIZEN', language: 'BN', flags: [], sources: [{ n: 1, sectionId: s323, sectionRef: 'PENAL_CODE:323', currentTextUsed: false }] });

    // No document text or names in the logs (TRD §12.3).
    const logged = JSON.stringify(logs);
    for (const w of ['করিম', 'রহিম', 'মারপিট', 'মিরপুর', 'ইচ্ছাকৃতভাবে']) expect(logged).not.toContain(w);
  });

  it('lawyer: ingredient audit at high effort in English, invalid citation stripped', async () => {
    const llm = fakeLlm('ok');
    const job = await extractedDoc(lawyer);
    expect(await processAnalysisJob({ db, llm, log: quiet }, job)).toMatchObject({ status: 'READY', roleAnalysis: 'READY' });
    expect(llm.calls[1]).toMatchObject({ effort: 'high', schemaName: 'lawyer_analysis' });
    expect(String(llm.calls[1]!.messages[0]!.content)).toContain('Write all text fields in English.');
    const r = (await row(job.artifactId, lawyer)).roleAnalysis as RoleAnalysisRecord & { status: 'READY' };
    expect(r).toMatchObject({ role: 'LAWYER', language: 'EN', flags: ['INVALID_CITATION_STRIPPED'] });
    expect(r.content).toMatchObject({ sections: [{ ingredients: [{ source_ids: [1], evidence_in_fir: 'বাদী রহিমকে মারপিট করে' }] }] });
  });

  it('a stage-6 refusal keeps the deterministic analysis: READY with role_analysis FAILED', async () => {
    const job = await extractedDoc();
    expect(await processAnalysisJob({ db, llm: fakeLlm('refuseRole'), log: quiet }, job)).toMatchObject({ status: 'READY', roleAnalysis: 'FAILED' });
    const a = await row(job.artifactId);
    expect(a.structuredAnalysis).not.toBeNull();
    expect(a.roleAnalysis).toEqual({ status: 'FAILED', code: 'LLM_REFUSED', role: 'CITIZEN' });
  });

  it('a stage-6 outage is retried from ANALYZING without re-running extraction', async () => {
    const job = await extractedDoc();
    await expect(processAnalysisJob({ db, llm: fakeLlm('outageRole'), log: quiet }, job)).rejects.toThrow('529');
    const mid = await row(job.artifactId);
    expect(mid.processingStatus).toBe('ANALYZING');
    expect(mid.structuredAnalysis).not.toBeNull(); // visible while stage 6 is pending

    const retry = fakeLlm('ok');
    expect(await processAnalysisJob({ db, llm: retry, log: quiet }, job)).toMatchObject({ status: 'READY', roleAnalysis: 'READY' });
    expect(retry.calls.map((c) => c.schemaName)).toEqual(['citizen_analysis']);
  });

  it('lawyer without any section text available: role_analysis UNAVAILABLE, no model call', async () => {
    const llm = fakeLlm('ok');
    const job = await extractedDoc(lawyer, 'FIR_SCAN', 'এজাহার। ১২/০৩/২০২৪ তারিখ। অস্ত্র আইনের ১৯এ ধারা।');
    expect(await processAnalysisJob({ db, llm, log: quiet }, job)).toMatchObject({ status: 'READY', roleAnalysis: 'UNAVAILABLE' });
    expect(llm.calls.map((c) => c.schemaName)).toEqual(['fir_extraction']);
  });

  it('fails with LLM_REFUSED / LLM_NOT_CONFIGURED at extraction, without retries', async () => {
    const a = await extractedDoc();
    expect(await processAnalysisJob({ db, llm: fakeLlm('refuse'), log: quiet }, a)).toEqual({ status: 'FAILED', code: 'LLM_REFUSED' });
    expect(await row(a.artifactId)).toMatchObject({ processingStatus: 'FAILED', processingError: 'LLM_REFUSED', structuredAnalysis: null });
    const b = await extractedDoc();
    expect(await processAnalysisJob({ db, llm: fakeLlm('unconfigured'), log: quiet }, b)).toEqual({ status: 'FAILED', code: 'LLM_NOT_CONFIGURED' });
  });

  it('rethrows extraction outages so BullMQ retries; the document stays retryable', async () => {
    const a = await extractedDoc();
    await expect(processAnalysisJob({ db, llm: fakeLlm('outage'), log: quiet }, a)).rejects.toThrow('529');
    expect((await row(a.artifactId)).processingStatus).toBe('EXTRACTING');
    expect(await processAnalysisJob({ db, llm: fakeLlm('ok'), log: quiet }, a)).toMatchObject({ status: 'READY', analysed: true });
  });

  it('marks other document types READY without calling the LLM', async () => {
    const llm = fakeLlm('ok');
    const a = await extractedDoc(citizen, 'SEIZURE_LIST', 'জব্দ তালিকা');
    expect(await processAnalysisJob({ db, llm, log: quiet }, a)).toEqual({ status: 'READY', analysed: false });
    expect(llm.calls).toHaveLength(0);
  });

  it('skips jobs for finished, deleted or foreign documents', async () => {
    const done = await extractedDoc();
    await processAnalysisJob({ db, llm: fakeLlm('ok'), log: quiet }, done);
    expect(await processAnalysisJob({ db, llm: fakeLlm('ok'), log: quiet }, done)).toEqual({ status: 'SKIPPED', reason: 'status READY' });

    const gone = await extractedDoc();
    await scoped(db, citizen).artifacts.softDelete(gone.artifactId);
    expect(await processAnalysisJob({ db, llm: fakeLlm('ok'), log: quiet }, gone)).toMatchObject({ status: 'SKIPPED' });

    // Another user's id for this artifact: scoped() hides it.
    const mine = await extractedDoc();
    expect(await processAnalysisJob({ db, llm: fakeLlm('ok'), log: quiet }, { artifactId: mine.artifactId, ownerUserId: newId() })).toMatchObject({ status: 'SKIPPED' });
    expect((await row(mine.artifactId)).processingStatus).toBe('EXTRACTING');
  });
});

describe('status events and reanalysis (BE-26)', () => {
  it('publishes every status change (ids and status only) and calls the push hook once at READY', async () => {
    const events = new MemoryArtifactEvents();
    const pushed: { userId: string; artifactId: string; status: string }[] = [];
    const job = await extractedDoc();
    await processAnalysisJob({ db, llm: fakeLlm('ok'), log: quiet, events, push: { documentFinished: async (n) => void pushed.push(n) } }, job);
    expect(events.published.map((e) => e.status)).toEqual(['SCHEDULE_LOOKUP', 'ANALYZING', 'READY']);
    expect(events.published.every((e) => e.artifact_id === job.artifactId && e.error === null)).toBe(true);
    expect(JSON.stringify(events.published)).not.toMatch(/করিম|রহিম/);
    expect(pushed).toEqual([{ userId: citizen, artifactId: job.artifactId, status: 'READY' }]);
  });

  it('a failing publisher or push hook never fails the job', async () => {
    const job = await extractedDoc();
    const broken = { publish: async () => Promise.reject(new Error('redis down')) };
    const warnings: object[] = [];
    const out = await processAnalysisJob(
      { db, llm: fakeLlm('ok'), log: { info: () => undefined, warn: (o) => void warnings.push(o) }, events: broken, push: { documentFinished: async () => Promise.reject(new Error('fcm down')) } },
      job,
    );
    expect(out).toMatchObject({ status: 'READY' });
    expect((await row(job.artifactId)).processingStatus).toBe('READY');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('reanalyze: corrected date and sections replace the extracted ones, without a new extraction', async () => {
    const job = await extractedDoc();
    await processAnalysisJob({ db, llm: fakeLlm('ok'), log: quiet }, job);
    const repo = scoped(db, citizen);
    const first = (await row(job.artifactId)).structuredAnalysis as StoredAnalysis;
    expect(first.llmCitedSections).toHaveLength(2); // kept for later reanalysis

    // What the API's PATCH stores: the user says it was s.325 (not 323/34) and corrects the date.
    const corrected = {
      ...first,
      corrections: {
        occurrence_datetime: '১২/০৩/২০২৪ খ্রিঃ সন্ধ্যা ৭.০০ ঘটিকা',
        cited_sections: [{ act_hint: 'দণ্ডবিধি', section: '৩২৫' }],
        fields: ['occurrence_datetime', 'cited_sections'],
        correctedAt: new Date().toISOString(),
        needsReanalysis: true,
      },
    };
    const current = (await row(job.artifactId)).version;
    expect((await repo.artifacts.updateAnalysis(job.artifactId, current, corrected)).status).toBe('ok');
    expect(await repo.artifacts.startReanalysis(job.artifactId)).not.toBeNull();

    const llm = fakeLlm('ok');
    expect(await processAnalysisJob({ db, llm, log: quiet }, { ...job, mode: 'reanalyze' })).toMatchObject({ status: 'READY', roleAnalysis: 'READY' });
    expect(llm.calls.map((c) => c.schemaName)).toEqual(['citizen_analysis']); // no stage 3

    const s = (await row(job.artifactId)).structuredAnalysis as StoredAnalysis;
    expect(s.sections.map((x) => [x.act?.key, x.key, x.source])).toEqual([['PENAL_CODE', '325', 'USER_CORRECTED']]);
    expect(s.occurrence).toMatchObject({ date: '2024-03-12', time: '19:00' });
    expect(s.filingDelay.minutes).toBe(900); // 19:00 → next day 10:00
    expect(s.corrections).toMatchObject({ needsReanalysis: false, fields: ['occurrence_datetime', 'cited_sections'] });
    expect(s.fir.police_station).toBe('মিরপুর মডেল'); // untouched fields survive
  });
});

describe('FCM push through the device registry (BE-26 push)', () => {
  it('sends the owner a content-free push in their language and drops tokens FCM reports as unregistered', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccount = parseServiceAccount(
      JSON.stringify({ type: 'service_account', project_id: 'lawassist-test', client_email: 'push@lawassist-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
    );
    await scoped(db, lawyer).devices.register('live-token-0123456789', 'ANDROID');
    await scoped(db, lawyer).devices.register('dead-token-0123456789', 'IOS');
    await scoped(db, citizen).devices.register('citizen-token-0123456789', 'ANDROID');
    const sent: { token: string; notification: { title: string }; data: Record<string, string> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (url.includes('oauth2')) return Response.json({ access_token: 'at', expires_in: 3600 });
      const { message } = JSON.parse(String(init.body));
      sent.push(message);
      return message.token.startsWith('dead')
        ? Response.json({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 })
        : Response.json({ name: 'projects/lawassist-test/messages/1' });
    }) as unknown as typeof fetch;
    const push = new FcmPushNotifier({ serviceAccount, store: dbPushTokenStore(db), fetch: fakeFetch });

    const job = await extractedDoc(lawyer);
    await processAnalysisJob({ db, llm: fakeLlm('ok'), log: quiet, push }, job);

    expect(sent.map((m) => m.token).sort()).toEqual(['dead-token-0123456789', 'live-token-0123456789']); // the owner's devices only
    expect(sent[0]).toMatchObject({ notification: PUSH_TEXT.EN.READY, data: { type: 'DOCUMENT_FINISHED', artifact_id: job.artifactId, status: 'READY' } });
    expect(JSON.stringify(sent)).not.toMatch(/করিম|রহিম|৩২৩|323/);
    expect(await scoped(db, lawyer).devices.list()).toEqual([{ token: 'live-token-0123456789', platform: 'ANDROID' }]);
    expect(await scoped(db, citizen).devices.list()).toHaveLength(1);
  });
});
