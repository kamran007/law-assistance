import { newId, scoped } from '@lawassist/db';
import { uploadKey } from '../src/modules/documents/upload-policy';
import { SAMPLES } from './helpers/samples';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX } from '../src/app';
import { startFullApp, type FullApp } from './helpers/full-app';

/**
 * QA-01 tenant-isolation suite (TRD §4.3 point 4). User A calls every tenant route with user B's
 * ids and must get 404, never B's data, and B's data must be unchanged afterwards. The coverage
 * check fails when a route has no access class or a tenant route has no entry below, so new routes
 * can't skip this suite.
 */
let f: FullApp;
let a: { userId: string; token: string };
let b: { userId: string; token: string };
const ids = { bCase: '', bCaseConv: '', bGeneralConv: '', bArtifact: '', bKey: '', aCase: '' };

beforeAll(async () => {
  f = await startFullApp();
  a = await f.user('LAWYER');
  b = await f.user('LAWYER');
  const repoB = scoped(f.db, b.userId);
  const bCase = await repoB.caseFiles.create({ title: 'B private case', caseNumber: 'B-1' }, { withConversation: true });
  ids.bCase = bCase.caseFileId;
  ids.bCaseConv = (await repoB.conversations.findForCase(bCase.caseFileId))!.conversationId;
  ids.bGeneralConv = (await repoB.conversations.createGeneral({ title: 'B private chat' })).conversationId;
  await repoB.messages.append(ids.bGeneralConv, { role: 'USER', content: 'B secret question' });
  ids.bArtifact = newId();
  ids.bKey = uploadKey(b.userId, ids.bCase, ids.bArtifact, 'application/pdf');
  f.storage.put(ids.bKey, SAMPLES.pdf, 'application/pdf');
  await repoB.artifacts.createUpload({ artifactId: ids.bArtifact, caseFileId: ids.bCase, artifactType: 'FIR_SCAN', fileStorageKey: ids.bKey, mimeType: 'application/pdf' });
  ids.aCase = (await scoped(f.db, a.userId).caseFiles.create({ title: 'A own case' }, { withConversation: false })).caseFileId;
}, 180_000);
afterAll(() => f?.stop());

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
interface Attack {
  url: () => string;
  payload?: object;
  headers?: Record<string, string>;
}

/** Every tenant route addressed by id, aimed at user B's resources. Key = "METHOD /route/:pattern". */
const attacks: Record<string, Attack> = {
  'GET /api/v1/cases/:id': { url: () => `/cases/${ids.bCase}` },
  'PATCH /api/v1/cases/:id': { url: () => `/cases/${ids.bCase}`, payload: { title: 'pwned' }, headers: { 'if-match': '"1"' } },
  'DELETE /api/v1/cases/:id': { url: () => `/cases/${ids.bCase}` },
  'GET /api/v1/cases/:id/conversation': { url: () => `/cases/${ids.bCase}/conversation` },
  'GET /api/v1/conversations/:id': { url: () => `/conversations/${ids.bGeneralConv}` },
  'PATCH /api/v1/conversations/:id': { url: () => `/conversations/${ids.bGeneralConv}`, payload: { title: 'pwned' } },
  'DELETE /api/v1/conversations/:id': { url: () => `/conversations/${ids.bGeneralConv}` },
  'POST /api/v1/cases/:id/documents/upload-url': { url: () => `/cases/${ids.bCase}/documents/upload-url`, payload: { content_type: 'application/pdf', size_bytes: 100 } },
  'POST /api/v1/cases/:id/documents/scan': { url: () => `/cases/${ids.bCase}/documents/scan`, payload: { s3_key: ids.bKey, artifact_type: 'FIR_SCAN' } },
  'GET /api/v1/cases/:id/artifacts': { url: () => `/cases/${ids.bCase}/artifacts` },
  'GET /api/v1/cases/:id/artifacts/:art_id': { url: () => `/cases/${ids.bCase}/artifacts/${ids.bArtifact}` },
  'DELETE /api/v1/cases/:id/artifacts/:art_id': { url: () => `/cases/${ids.bCase}/artifacts/${ids.bArtifact}` },
  'PATCH /api/v1/cases/:id/artifacts/:art_id': { url: () => `/cases/${ids.bCase}/artifacts/${ids.bArtifact}`, payload: { police_station: 'pwned' }, headers: { 'if-match': '"1"' } },
  'POST /api/v1/cases/:id/artifacts/:art_id/reanalyze': { url: () => `/cases/${ids.bCase}/artifacts/${ids.bArtifact}/reanalyze` },
  'GET /api/v1/cases/:id/artifacts/:art_id/events': { url: () => `/cases/${ids.bCase}/artifacts/${ids.bArtifact}/events` },
  'GET /api/v1/cases/:id/artifacts/:art_id/original': { url: () => `/cases/${ids.bCase}/artifacts/${ids.bArtifact}/original` },
};

/** Tenant routes without an id: they act on the caller's own data; checked for leaks below. */
const collectionRoutes = ['GET /api/v1/cases', 'POST /api/v1/cases', 'GET /api/v1/conversations', 'POST /api/v1/conversations'];

const apiRoutes = () => f.app.routeList.filter((r) => r.url.startsWith(API_PREFIX));
const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

describe('route coverage', () => {
  it('every API route declares an access class', () => {
    expect(apiRoutes().filter((r) => !r.access).map(key)).toEqual([]);
  });

  it('every tenant route is covered by this suite', () => {
    const tenant = apiRoutes().filter((r) => r.access === 'tenant').map(key);
    const covered = new Set([...Object.keys(attacks), ...collectionRoutes]);
    expect(tenant.filter((k) => !covered.has(k))).toEqual([]);
    // And the suite doesn't test routes that no longer exist.
    expect([...covered].filter((k) => !tenant.includes(k))).toEqual([]);
  });
});

describe('cross-tenant access', () => {
  it.each(Object.entries(attacks))('%s with another user’s id → 404 problem, nothing leaked', async (route, attack) => {
    const method = route.split(' ')[0] as Method;
    const res = await f.app.inject({
      method,
      url: `${API_PREFIX}${attack.url()}`,
      ...(attack.payload ? { payload: attack.payload } : {}),
      headers: { authorization: `Bearer ${a.token}`, ...attack.headers },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(res.body).not.toMatch(/B private|B secret|B-1/);
  });

  it.each(Object.entries(attacks))('%s without a token → 401', async (route, attack) => {
    const res = await f.app.inject({ method: route.split(' ')[0] as Method, url: `${API_PREFIX}${attack.url()}`, ...(attack.payload ? { payload: attack.payload } : {}), headers: attack.headers ?? {} });
    expect(res.statusCode).toBe(401);
  });

  it('collections only ever show the caller’s own data', async () => {
    const h = { authorization: `Bearer ${a.token}` };
    const cases = await f.app.inject({ method: 'GET', url: `${API_PREFIX}/cases`, headers: h });
    const convs = await f.app.inject({ method: 'GET', url: `${API_PREFIX}/conversations`, headers: h });
    const sync = await f.app.inject({ method: 'GET', url: `${API_PREFIX}/cases?updated_since=2000-01-01T00:00:00Z`, headers: h });
    for (const res of [cases, convs, sync]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(ids.bCase);
      expect(res.body).not.toContain(ids.bGeneralConv);
    }
    const created = (await f.app.inject({ method: 'POST', url: `${API_PREFIX}/cases`, headers: h, payload: { title: 'A case' } })).json();
    expect(await scoped(f.db, b.userId).caseFiles.findById(created.case_id)).toBeNull();
    const conv = (await f.app.inject({ method: 'POST', url: `${API_PREFIX}/conversations`, headers: h, payload: {} })).json();
    expect(await scoped(f.db, b.userId).conversations.findById(conv.conversation_id)).toBeNull();
  });

  it('can’t reach B’s document through A’s own case, or register B’s uploaded file as A’s', async () => {
    const h = { authorization: `Bearer ${a.token}` };
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await f.app.inject({ method, url: `${API_PREFIX}/cases/${ids.aCase}/artifacts/${ids.bArtifact}`, headers: h });
      expect(res.statusCode).toBe(404);
    }
    const steal = await f.app.inject({ method: 'POST', url: `${API_PREFIX}/cases/${ids.aCase}/documents/scan`, headers: h, payload: { s3_key: ids.bKey, artifact_type: 'FIR_SCAN' } });
    expect(steal.json()).toMatchObject({ status: 422, code: 'INVALID_UPLOAD_KEY' });
    // Even a key in A's own namespace that reuses B's artifact id can't take B's row.
    const reuse = uploadKey(a.userId, ids.aCase, ids.bArtifact, 'application/pdf');
    f.storage.put(reuse, SAMPLES.pdf, 'application/pdf');
    const clash = await f.app.inject({ method: 'POST', url: `${API_PREFIX}/cases/${ids.aCase}/documents/scan`, headers: h, payload: { s3_key: reuse, artifact_type: 'FIR_SCAN' } });
    expect(clash.statusCode).toBe(404);
    expect(f.scanJobs.filter((j) => j.ownerUserId === a.userId)).toEqual([]);
  });

  it('user B’s data is intact after all the attacks', async () => {
    const repoB = scoped(f.db, b.userId);
    expect(await repoB.caseFiles.findById(ids.bCase)).toMatchObject({ title: 'B private case', version: 1, deletedAt: null });
    expect(await repoB.conversations.findById(ids.bGeneralConv)).toMatchObject({ title: 'B private chat', deletedAt: null });
    expect(await repoB.conversations.findById(ids.bCaseConv)).not.toBeNull();
    expect((await repoB.messages.byConversation(ids.bGeneralConv))!.map((m) => m.content)).toEqual(['B secret question']);
    expect(await repoB.artifacts.findById(ids.bArtifact)).toMatchObject({ caseFileId: ids.bCase, ownerUserId: b.userId, deletedAt: null });
  });
});
