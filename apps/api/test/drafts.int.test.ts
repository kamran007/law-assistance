import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFullApp, type FullApp } from './helpers/full-app';

/** Drafts (BE-32 templates, BE-33 last-write-wins with preserved copy) against MySQL 8.4. */
let f: FullApp;
let lawyer: { userId: string; token: string };
let judge: { userId: string; token: string };
let citizen: { userId: string; token: string };
let caseId = '';

const h = (u: { token: string }, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${u.token}`, ...extra });

beforeAll(async () => {
  f = await startFullApp();
  lawyer = await f.user('LAWYER');
  judge = await f.user('JUDGE');
  citizen = await f.user('CITIZEN');
  const res = await f.app.inject({
    method: 'POST',
    url: '/api/v1/cases',
    payload: { title: 'Rahim <b>v.</b> State', case_number: 'G.R. 412/2026', court_or_thana: 'Mirpur' },
    headers: h(lawyer),
  });
  caseId = res.json().case_id;
}, 180_000);
afterAll(() => f?.stop());

const create = (template_key: string, language = 'EN') => f.app.inject({ method: 'POST', url: `/api/v1/cases/${caseId}/drafts`, payload: { template_key, language }, headers: h(lawyer) });
const save = (id: string, html: string, version: number) =>
  f.app.inject({ method: 'PATCH', url: `/api/v1/cases/${caseId}/drafts/${id}`, payload: { html }, headers: h(lawyer, { 'if-match': `"${version}"`, 'x-device-id': 'laptop' }) });
const keys = (items: { key: string }[]) => items.map((t) => t.key);

describe('templates', () => {
  it('lists templates by role; citizens and unverified professionals are refused', async () => {
    expect(keys((await f.app.inject({ method: 'GET', url: '/api/v1/draft-templates', headers: h(lawyer) })).json().items)).toEqual([
      'BAIL_PETITION',
      'LEGAL_NOTICE',
      'ARGUMENT_NOTES',
      'WITNESS_SUMMARY',
      'PLAINT',
      'BLANK',
    ]);
    expect(keys((await f.app.inject({ method: 'GET', url: '/api/v1/draft-templates', headers: h(judge) })).json().items)).toEqual([
      'BENCH_NOTES',
      'ORDER_SHEET',
      'ISSUE_FRAMING',
      'JUDGMENT_SUMMARY',
      'BLANK',
    ]);
    expect((await f.app.inject({ method: 'GET', url: '/api/v1/draft-templates', headers: h(citizen) })).json()).toMatchObject({ status: 403, code: 'ROLE_FORBIDDEN' });
    const pending = await f.user('CITIZEN', 'PENDING');
    expect((await f.app.inject({ method: 'GET', url: '/api/v1/draft-templates', headers: h(pending) })).json()).toMatchObject({ status: 403, code: 'VERIFICATION_REQUIRED' });
  });

  it('creates a draft with headings and the case details escaped; a template of the other role is refused', async () => {
    const res = await create('BAIL_PETITION');
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    const d = res.json();
    expect(d.html).toContain('<h1>Bail petition</h1>');
    expect(d.html).toContain('<strong>Case no.:</strong> G.R. 412/2026');
    expect(d.html).toContain('Rahim &lt;b&gt;v.&lt;/b&gt; State'); // the case title is text, never markup
    expect(d.html).toContain('<h2>Grounds for bail</h2>');
    expect((await create('BENCH_NOTES')).json()).toMatchObject({ status: 422, code: 'UNKNOWN_TEMPLATE' });
    expect((await create('BLANK', 'BN')).json().html).toContain('<h1>ফাঁকা খসড়া</h1>');
    // Drafts appear in the case's artifact list with their template.
    const list = (await f.app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}/artifacts`, headers: h(lawyer) })).json().items;
    expect(list.find((a: { artifact_id: string }) => a.artifact_id === d.artifact_id)).toMatchObject({ artifact_type: 'VOICE_DICTATION_DRAFT', template_key: 'BAIL_PETITION' });
  });
});

describe('saving', () => {
  it('saves with If-Match, removes unsafe markup, and needs If-Match', async () => {
    const d = (await create('BLANK')).json();
    const res = await save(d.artifact_id, '<h1>Notes</h1><p onclick="x()">Hi <script>alert(1)</script><a href="javascript:alert(1)">link</a><img src=x onerror=alert(1)></p>', 1);
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.headers['x-conflict-preserved']).toBeUndefined();
    expect(res.json().html).toBe('<h1>Notes</h1><p>Hi link</p>');
    const noIfMatch = await f.app.inject({ method: 'PATCH', url: `/api/v1/cases/${caseId}/drafts/${d.artifact_id}`, payload: { html: '<p>x</p>' }, headers: h(lawyer) });
    expect(noIfMatch.statusCode).toBe(428);
  });

  it('a stale save wins but preserves the newer server text (X-Conflict-Preserved)', async () => {
    const d = (await create('BLANK')).json();
    expect((await save(d.artifact_id, '<p>from the phone</p>', 1)).statusCode).toBe(200); // now version 2
    const stale = await save(d.artifact_id, '<p>from the laptop</p>', 1);
    expect(stale.statusCode).toBe(200);
    const preserved = stale.headers['x-conflict-preserved'] as string;
    expect(preserved).toMatch(/^[0-9a-f-]{36}$/);
    expect(stale.json()).toMatchObject({ html: '<p>from the laptop</p>', version: 3 });
    const revs = (await f.app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}/drafts/${d.artifact_id}/revisions`, headers: h(lawyer) })).json().items;
    expect(revs).toEqual([{ revision_id: preserved, version: 2, html: '<p>from the phone</p>', created_by_device: 'laptop', created_at: expect.any(String) }]);
  });

  it('a scanned document is not a draft', async () => {
    const up = await f.app.inject({ method: 'POST', url: `/api/v1/cases/${caseId}/documents/upload-url`, payload: { content_type: 'application/pdf', size_bytes: 100 }, headers: h(lawyer) });
    const key = up.json().s3_key as string;
    f.storage.put(key, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, ...new Array(92).fill(0x20)]), 'application/pdf');
    const reg = await f.app.inject({ method: 'POST', url: `/api/v1/cases/${caseId}/documents/scan`, payload: { s3_key: key, artifact_type: 'FIR_SCAN' }, headers: h(lawyer) });
    const artId = reg.json().artifact_id;
    expect((await save(artId, '<p>x</p>', 1)).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}/drafts/${artId}`, headers: h(lawyer) })).statusCode).toBe(404);
  });
});
