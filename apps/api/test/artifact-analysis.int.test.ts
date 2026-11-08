import { auditLog, newId, scoped } from '@lawassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFullApp, type FullApp } from './helpers/full-app';

/**
 * BE-26 against MySQL 8.4: artifact detail with analysis, field corrections (PATCH + If-Match +
 * audit log), /reanalyze, and the SSE status stream (events from an in-memory hub).
 */
let f: FullApp;
let user: { userId: string; token: string };
let caseId = '';

beforeAll(async () => {
  f = await startFullApp();
  user = await f.user('LAWYER');
  caseId = (await f.app.inject({ method: 'POST', url: '/api/v1/cases', payload: { title: 'FIR' }, headers: auth() })).json().case_id;
}, 180_000);
afterAll(() => f?.stop());

function auth(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${user.token}`, ...extra };
}
const url = (artifactId: string, suffix = '') => `/api/v1/cases/${caseId}/artifacts/${artifactId}${suffix}`;

const ANALYSIS = {
  version: 1,
  documentKind: 'FIR',
  fir: { police_station: 'মিরপুর', district: 'ঢাকা', fir_number: '১২', accused: [{ name: 'করিম', role_in_allegation: null }], occurrence_datetime_raw: '১২/০৩/২০২৪', reported_datetime_raw: null },
  sections: [{ key: '323' }],
};

/** A document as the worker leaves it. */
async function doc(status: 'READY' | 'ANALYZING' = 'READY', structuredAnalysis: unknown = ANALYSIS) {
  const artifactId = newId();
  const repo = scoped(f.db, user.userId);
  await repo.artifacts.createUpload({ artifactId, caseFileId: caseId, artifactType: 'FIR_SCAN', fileStorageKey: `tenants/${user.userId}/cases/${caseId}/${artifactId}/original.pdf`, mimeType: 'application/pdf' });
  await repo.artifacts.setProcessing(artifactId, { processingStatus: status, rawExtractedText: 'text', structuredAnalysis, roleAnalysis: status === 'READY' ? { status: 'READY', role: 'LAWYER' } : null });
  return artifactId;
}

describe('artifact detail', () => {
  it('returns the analyses and an ETag', async () => {
    const id = await doc();
    const res = await f.app.inject({ method: 'GET', url: url(id), headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.json()).toMatchObject({ processing_status: 'READY', structured_analysis: { documentKind: 'FIR', fir: { police_station: 'মিরপুর' } }, role_analysis: { role: 'LAWYER' } });
  });
});

describe('GET original', () => {
  it('returns a short-lived inline link for the uploaded PDF, not cached', async () => {
    const id = await doc();
    const res = await f.app.inject({ method: 'GET', url: url(id, '/original'), headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ expires_in: 300, mime_type: 'application/pdf' });
    expect(body.url).toBe(`memory://tenants/${user.userId}/cases/${caseId}/${id}/original.pdf?ttl=300&type=application%2Fpdf&disposition=inline`);
  });

  it("a document of the caller's other case is not found through this case", async () => {
    const id = await doc();
    const other = (await f.app.inject({ method: 'POST', url: '/api/v1/cases', payload: { title: 'Other' }, headers: auth() })).json().case_id;
    const res = await f.app.inject({ method: 'GET', url: `/api/v1/cases/${other}/artifacts/${id}/original`, headers: auth() });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH corrections', () => {
  const patch = (id: string, payload: object, headers: Record<string, string> = { 'if-match': '"1"' }) => f.app.inject({ method: 'PATCH', url: url(id), payload, headers: auth(headers) });

  it('corrects party fields in place, bumps the version and records who changed which fields', async () => {
    const id = await doc();
    const res = await patch(id, { police_station: 'পল্লবী', accused: [{ name: 'করিম মিয়া', role_in_allegation: 'মারপিট' }] });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.json().structured_analysis).toMatchObject({
      fir: { police_station: 'পল্লবী', district: 'ঢাকা', accused: [{ name: 'করিম মিয়া' }] },
      corrections: { fields: ['police_station', 'accused'], needsReanalysis: false },
    });
    const audit = await f.db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audit).toMatchObject([{ actorUserId: user.userId, action: 'ARTIFACT_FIELDS_CORRECTED', entity: 'case_artifact', details: { fields: ['police_station', 'accused'] } }]);
    // Field names only: no corrected values in the audit trail.
    expect(JSON.stringify(audit)).not.toContain('পল্লবী');
  });

  it('records corrected dates and sections and marks the analysis for reanalysis', async () => {
    const id = await doc();
    const res = await patch(id, { occurrence_datetime: '১২/০৩/২০২৪ রাত ৯টা', cited_sections: [{ act_hint: 'দণ্ডবিধি', section: '৩২৩' }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().structured_analysis.corrections).toMatchObject({
      occurrence_datetime: '১২/০৩/২০২৪ রাত ৯টা',
      cited_sections: [{ act_hint: 'দণ্ডবিধি', section: '৩২৩' }],
      needsReanalysis: true,
    });
  });

  it('needs If-Match, refuses a stale version, an empty or unknown body, and documents in processing', async () => {
    const id = await doc();
    expect((await patch(id, { police_station: 'x' }, {})).statusCode).toBe(428);
    expect((await patch(id, { police_station: 'x' }, { 'if-match': '"7"' })).statusCode).toBe(412);
    expect((await patch(id, {})).statusCode).toBe(422);
    expect((await patch(id, { structured_analysis: {} })).statusCode).toBe(422);
    const busyId = await doc('ANALYZING');
    expect((await patch(busyId, { police_station: 'x' })).json()).toMatchObject({ status: 409, code: 'ARTIFACT_BUSY' });
    const plain = await doc('READY', null);
    expect((await patch(plain, { police_station: 'x' })).json()).toMatchObject({ status: 409, code: 'NOT_CORRECTABLE' });
  });
});

describe('POST /reanalyze', () => {
  it('moves READY back to SCHEDULE_LOOKUP, queues one job, publishes the change; a second call is 409', async () => {
    const id = await doc();
    const before = f.analysisJobs.length;
    const res = await f.app.inject({ method: 'POST', url: url(id, '/reanalyze'), headers: auth() });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ processing_status: 'SCHEDULE_LOOKUP' });
    expect(f.analysisJobs.slice(before)).toEqual([{ artifactId: id, ownerUserId: user.userId }]);
    expect(f.events.published.at(-1)).toMatchObject({ artifact_id: id, status: 'SCHEDULE_LOOKUP', error: null });

    const again = await f.app.inject({ method: 'POST', url: url(id, '/reanalyze'), headers: auth() });
    expect(again.json()).toMatchObject({ status: 409, code: 'ARTIFACT_BUSY' });
    expect(f.analysisJobs.length).toBe(before + 1);
  });
});

describe('GET /events (SSE)', () => {
  const events = (body: string) =>
    body
      .split('\n\n')
      .filter((b) => b.includes('event: status'))
      .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { status: string; error: string | null });

  it('a finished document: one event, then the stream ends; a reconnect gets 204', async () => {
    const id = await doc();
    const res = await f.app.inject({ method: 'GET', url: url(id, '/events'), headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(events(res.body).map((e) => e.status)).toEqual(['READY']);
    expect(f.events.subscriberCount(id)).toBe(0);

    const reconnect = await f.app.inject({ method: 'GET', url: url(id, '/events'), headers: auth({ 'last-event-id': '1' }) });
    expect(reconnect.statusCode).toBe(204);
  });

  it('relays live changes in order, drops duplicates, and closes at READY', async () => {
    const id = await doc('ANALYZING');
    const pending = f.app.inject({ method: 'GET', url: url(id, '/events'), headers: auth() });
    // Wait until the stream has subscribed, then play the worker's part.
    for (let i = 0; i < 100 && f.events.subscriberCount(id) === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(f.events.subscriberCount(id)).toBe(1);
    const at = new Date().toISOString();
    await f.events.publish({ artifact_id: id, status: 'ANALYZING', error: null, at }); // same as the initial read
    await f.events.publish({ artifact_id: id, status: 'READY', error: null, at });
    const res = await pending;
    expect(events(res.body).map((e) => e.status)).toEqual(['ANALYZING', 'READY']);
    expect(res.body).not.toMatch(/করিম|মিরপুর/); // ids and status only
    expect(f.events.subscriberCount(id)).toBe(0);
  });

  it('reports a failure code and closes', async () => {
    const id = await doc('ANALYZING');
    const pending = f.app.inject({ method: 'GET', url: url(id, '/events'), headers: auth() });
    for (let i = 0; i < 100 && f.events.subscriberCount(id) === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await f.events.publish({ artifact_id: id, status: 'FAILED', error: 'LLM_REFUSED', at: new Date().toISOString() });
    expect(events((await pending).body).at(-1)).toMatchObject({ status: 'FAILED', error: 'LLM_REFUSED' });
  });

  it('ends a quiet stream after the maximum duration, with keep-alive comments meanwhile', async () => {
    const id = await doc('ANALYZING');
    const res = await f.app.inject({ method: 'GET', url: url(id, '/events'), headers: auth() });
    expect(events(res.body).map((e) => e.status)).toEqual(['ANALYZING']);
    expect(res.body).toContain(': keep-alive');
    expect(f.events.subscriberCount(id)).toBe(0);
  });
});

describe('GET /events over a real socket', () => {
  it('streams through the hijacked response with CORS headers and ends at READY', async () => {
    const id = await doc('ANALYZING');
    const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`${address}${url(id, '/events')}`, { headers: { ...auth(), origin: 'http://localhost:3001' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3001');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let body = '';
      // First chunk: the current state.
      while (!body.includes('ANALYZING')) body += decoder.decode((await reader.read()).value);
      await f.events.publish({ artifact_id: id, status: 'READY', error: null, at: new Date().toISOString() });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        body += decoder.decode(value);
      }
      expect(body.match(/"status":"(\w+)"/g)).toEqual(['"status":"ANALYZING"', '"status":"READY"']);
    } finally {
      await f.app.server.close();
    }
  });
});
