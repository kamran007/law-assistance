import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../src/modules/documents/upload-policy';
import { startFullApp, type FullApp } from './helpers/full-app';
import { SAMPLES } from './helpers/samples';

/** BE-21 upload flow against MySQL 8.4 (S3 and the queue are in-memory stand-ins). */
let f: FullApp;
let user: { userId: string; token: string };
let caseId = '';

beforeAll(async () => {
  f = await startFullApp();
  user = await f.user('CITIZEN'); // citizens scan too (App Flow §8)
  caseId = (await post('/cases', { title: 'FIR' })).json().case_id;
}, 180_000);
afterAll(() => f?.stop());

function post(url: string, payload: object) {
  return f.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: { authorization: `Bearer ${user.token}` } });
}
const get = (url: string) => f.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${user.token}` } });

async function uploadUrl(content_type: string, size_bytes: number) {
  const res = await post(`/cases/${caseId}/documents/upload-url`, { content_type, size_bytes });
  expect(res.statusCode).toBe(200);
  return res.json() as { artifact_id: string; s3_key: string; headers: Record<string, string>; expires_in: number };
}

describe('upload → register → queue', () => {
  it('hands out a per-user, per-case key and the headers to sign', async () => {
    const u = await uploadUrl('application/pdf', SAMPLES.pdf.length);
    expect(u.s3_key).toBe(`tenants/${user.userId}/cases/${caseId}/${u.artifact_id}/original.pdf`);
    expect(u).toMatchObject({ expires_in: 600, headers: { 'content-type': 'application/pdf', 'content-length': String(SAMPLES.pdf.length) } });
  });

  it('rejects types and sizes that are not allowed before signing anything', async () => {
    expect((await post(`/cases/${caseId}/documents/upload-url`, { content_type: 'application/x-msdownload', size_bytes: 10 })).statusCode).toBe(422);
    expect((await post(`/cases/${caseId}/documents/upload-url`, { content_type: 'application/pdf', size_bytes: MAX_UPLOAD_BYTES + 1 })).statusCode).toBe(422);
  });

  it('registers each allowed format, enqueues exactly one job per document, and is safe to retry', async () => {
    const types = [
      ['application/pdf', SAMPLES.pdf],
      ['image/jpeg', SAMPLES.jpg],
      ['image/png', SAMPLES.png],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', SAMPLES.docx],
    ] as const;
    for (const [type, bytes] of types) {
      const u = await uploadUrl(type, bytes.length);
      f.storage.put(u.s3_key, bytes, type);
      const res = await post(`/cases/${caseId}/documents/scan`, { s3_key: u.s3_key, artifact_type: 'FIR_SCAN', page_count: 2 });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ artifact_id: u.artifact_id, case_id: caseId, artifact_type: 'FIR_SCAN', processing_status: 'UPLOADED', mime_type: type, page_count: 2 });
      const retry = await post(`/cases/${caseId}/documents/scan`, { s3_key: u.s3_key, artifact_type: 'FIR_SCAN' });
      expect(retry.statusCode).toBe(202);
      expect(f.scanJobs.filter((j) => j.artifactId === u.artifact_id)).toEqual([{ artifactId: u.artifact_id, ownerUserId: user.userId }]);
    }
    const list = (await get(`/cases/${caseId}/artifacts`)).json().items;
    expect(list).toHaveLength(4);
    expect(JSON.stringify(list)).not.toContain('tenants/'); // storage keys stay server-side
  });

  it('refuses to register a file that was never uploaded, or whose bytes are not the declared type', async () => {
    const missing = await uploadUrl('application/pdf', 100);
    expect((await post(`/cases/${caseId}/documents/scan`, { s3_key: missing.s3_key, artifact_type: 'FIR_SCAN' })).json().code).toBe('UPLOAD_NOT_FOUND');

    const fake = await uploadUrl('application/pdf', SAMPLES.exe.length);
    f.storage.put(fake.s3_key, SAMPLES.exe, 'application/pdf'); // an .exe renamed to .pdf
    expect((await post(`/cases/${caseId}/documents/scan`, { s3_key: fake.s3_key, artifact_type: 'FIR_SCAN' })).json().code).toBe('UPLOAD_CONTENT_INVALID');

    const wrongType = await uploadUrl('image/png', SAMPLES.png.length);
    f.storage.put(wrongType.s3_key, SAMPLES.png, 'image/jpeg'); // stored with another Content-Type
    expect((await post(`/cases/${caseId}/documents/scan`, { s3_key: wrongType.s3_key, artifact_type: 'FIR_SCAN' })).json().code).toBe('UPLOAD_TYPE_MISMATCH');

    expect(f.scanJobs.map((j) => j.artifactId)).not.toEqual(expect.arrayContaining([missing.artifact_id, fake.artifact_id, wrongType.artifact_id]));
  });

  it('rejects keys it did not hand out and non-scannable artifact types', async () => {
    expect((await post(`/cases/${caseId}/documents/scan`, { s3_key: 'raw/bdlaws/11/x.html.gz', artifact_type: 'FIR_SCAN' })).json().code).toBe('INVALID_UPLOAD_KEY');
    const u = await uploadUrl('application/pdf', SAMPLES.pdf.length);
    f.storage.put(u.s3_key, SAMPLES.pdf, 'application/pdf');
    expect((await post(`/cases/${caseId}/documents/scan`, { s3_key: u.s3_key, artifact_type: 'VOICE_DICTATION_DRAFT' })).json().code).toBe('VALIDATION_FAILED');
  });

  it('reads and deletes a document within its case', async () => {
    const u = await uploadUrl('image/png', SAMPLES.png.length);
    f.storage.put(u.s3_key, SAMPLES.png, 'image/png');
    await post(`/cases/${caseId}/documents/scan`, { s3_key: u.s3_key, artifact_type: 'SEIZURE_LIST' });
    expect((await get(`/cases/${caseId}/artifacts/${u.artifact_id}`)).json()).toMatchObject({ artifact_type: 'SEIZURE_LIST', processing_status: 'UPLOADED' });

    const otherCase = (await post('/cases', { title: 'Other' })).json().case_id;
    expect((await get(`/cases/${otherCase}/artifacts/${u.artifact_id}`)).statusCode).toBe(404); // wrong case

    const del = await f.app.inject({ method: 'DELETE', url: `/api/v1/cases/${caseId}/artifacts/${u.artifact_id}`, headers: { authorization: `Bearer ${user.token}` } });
    expect(del.statusCode).toBe(204);
    expect((await get(`/cases/${caseId}/artifacts/${u.artifact_id}`)).statusCode).toBe(404);
  });
});
