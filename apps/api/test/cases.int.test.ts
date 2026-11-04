import { scoped, users } from '@lawassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFullApp, type FullApp } from './helpers/full-app';

/** BE-15 cases and BE-12 conversations against MySQL 8.4 (Testcontainers, needs Docker). */
let f: FullApp;
beforeAll(async () => {
  f = await startFullApp();
}, 180_000);
afterAll(() => f?.stop());

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: object, headers: Record<string, string> = {}) =>
  f.app.inject({ method, url: `/api/v1${url}`, payload, headers: { authorization: `Bearer ${token}`, ...headers } });

describe('cases', () => {
  it('a lawyer’s new case comes with its one conversation; a citizen’s never does', async () => {
    const lawyer = await f.user('LAWYER');
    const res = await call('POST', '/cases', lawyer.token, { title: 'State vs. Karim', case_number: 'G.R. 412/2026', alleged_offense_date: '2024-03-14' });
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    const body = res.json();
    expect(body).toMatchObject({ title: 'State vs. Karim', case_number: 'G.R. 412/2026', alleged_offense_date: '2024-03-14', version: 1, deleted_at: null });
    expect(body.conversation).toMatchObject({ case_id: body.case_id, title: 'State vs. Karim' });
    expect((await call('GET', `/cases/${body.case_id}/conversation`, lawyer.token)).json().conversation_id).toBe(body.conversation.conversation_id);

    const citizen = await f.user('CITIZEN');
    const scan = (await call('POST', '/cases', citizen.token, { title: 'My FIR' })).json();
    expect(scan.conversation).toBeNull();
    expect((await call('GET', `/cases/${scan.case_id}/conversation`, citizen.token)).json()).toMatchObject({ status: 403, code: 'ROLE_FORBIDDEN' });
  });

  it('creates the case conversation on demand once a pending applicant is approved', async () => {
    const u = await f.user('CITIZEN', 'PENDING');
    const c = (await call('POST', '/cases', u.token, { case_number: 'C.R. 9/2026' })).json();
    expect(c.conversation).toBeNull(); // still a citizen while pending

    // Admin approval, then the next refresh issues a token with the new role (BE-03).
    await f.db.update(users).set({ role: 'LAWYER', verificationStatus: 'VERIFIED' }).where(eq(users.userId, u.userId));
    const lawyerToken = await f.tokens.signAccess({ sub: u.userId, role: 'LAWYER', vs: 'VERIFIED', sid: 's' });
    const conv = await call('GET', `/cases/${c.case_id}/conversation`, lawyerToken);
    expect(conv.statusCode).toBe(200);
    expect(conv.json()).toMatchObject({ case_id: c.case_id, title: 'C.R. 9/2026' });
    const again = await call('GET', `/cases/${c.case_id}/conversation`, lawyerToken);
    expect(again.json().conversation_id).toBe(conv.json().conversation_id);
  });

  it('PATCH needs If-Match; a stale version gets 409 with the current copy', async () => {
    const u = await f.user('JUDGE');
    const c = (await call('POST', '/cases', u.token, { title: 'Bench notes' })).json();
    expect((await call('PATCH', `/cases/${c.case_id}`, u.token, { title: 'x' })).json()).toMatchObject({ status: 428, code: 'PRECONDITION_REQUIRED' });

    const ok = await call('PATCH', `/cases/${c.case_id}`, u.token, { court_or_thana: 'Dhaka Metropolitan Sessions Court' }, { 'if-match': '"1"' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({ version: 2, title: 'Bench notes', court_or_thana: 'Dhaka Metropolitan Sessions Court' });

    const stale = await call('PATCH', `/cases/${c.case_id}`, u.token, { title: 'Other device' }, { 'if-match': 'W/"1"' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT', current: { version: 2, title: 'Bench notes' } });
    expect(stale.headers.etag).toBe('"2"');
  });

  it('validates fields: no future offense dates, no unknown fields', async () => {
    const u = await f.user('LAWYER');
    expect((await call('POST', '/cases', u.token, { alleged_offense_date: '2026-11-05' })).json().code).toBe('OFFENSE_DATE_IN_FUTURE');
    expect((await call('POST', '/cases', u.token, { owner_user_id: 'x' })).json().code).toBe('VALIDATION_FAILED');
  });

  it('syncs incrementally: updated_since returns changes and deletions as tombstones', async () => {
    const u = await f.user('LAWYER');
    const a = (await call('POST', '/cases', u.token, { title: 'A' })).json();
    const b = (await call('POST', '/cases', u.token, { title: 'B' })).json();
    const first = (await call('GET', '/cases', u.token)).json();
    expect(first.items.map((c: { case_id: string }) => c.case_id).sort()).toEqual([a.case_id, b.case_id].sort());

    await new Promise((r) => setTimeout(r, 20));
    const cursor = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    expect((await call('DELETE', `/cases/${a.case_id}`, u.token)).statusCode).toBe(204);
    const changes = (await call('GET', `/cases?updated_since=${encodeURIComponent(cursor)}`, u.token)).json();
    expect(changes.items).toEqual([expect.objectContaining({ case_id: a.case_id, deleted_at: expect.any(String) })]);
    expect((await call('GET', '/cases', u.token)).json().items.map((c: { case_id: string }) => c.case_id)).toEqual([b.case_id]);
    expect((await call('GET', `/cases/${a.case_id}`, u.token)).statusCode).toBe(404);
  });
});

describe('conversations', () => {
  it('general conversations: create, list, rename, delete; case conversations are not listed', async () => {
    const u = await f.user('LAWYER');
    await call('POST', '/cases', u.token, { title: 'Case chat' });
    const g = await call('POST', '/conversations', u.token, { title: 'Cheque dishonour', language: 'EN' });
    expect(g.statusCode).toBe(201);
    const id = g.json().conversation_id;
    expect(g.json()).toMatchObject({ case_id: null, language: 'EN' });
    expect((await call('GET', '/conversations', u.token)).json().items.map((c: { conversation_id: string }) => c.conversation_id)).toEqual([id]);
    expect((await call('PATCH', `/conversations/${id}`, u.token, { title: 'NI Act s.138' })).json().title).toBe('NI Act s.138');
    expect((await call('DELETE', `/conversations/${id}`, u.token)).statusCode).toBe(204);
    expect((await call('GET', `/conversations/${id}`, u.token)).statusCode).toBe(404);
  });

  it('a case conversation is deleted only with its case', async () => {
    const u = await f.user('LAWYER');
    const c = (await call('POST', '/cases', u.token, { title: 'Keep chat' })).json();
    const convId = c.conversation.conversation_id;
    expect((await call('DELETE', `/conversations/${convId}`, u.token)).json()).toMatchObject({ status: 409, code: 'CASE_CONVERSATION' });
    await call('DELETE', `/cases/${c.case_id}`, u.token);
    expect((await call('GET', `/conversations/${convId}`, u.token)).statusCode).toBe(404);
  });

  it('pages messages oldest-first and never exposes server-only fields', async () => {
    const u = await f.user('CITIZEN');
    const id = (await call('POST', '/conversations', u.token, {})).json().conversation_id;
    const repo = scoped(f.db, u.userId);
    for (let i = 1; i <= 5; i++) {
      await repo.messages.append(id, { role: i % 2 ? 'USER' : 'ASSISTANT', content: `m${i}`, retrievalTrace: { secret: true }, inputTokens: 10 });
      await new Promise((r) => setTimeout(r, 5));
    }
    const page = (await call('GET', `/conversations/${id}?limit=2`, u.token)).json();
    expect(page.messages.map((m: { content: string }) => m.content)).toEqual(['m4', 'm5']);
    expect(page.has_more).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/retrieval|secret|input_tokens/);
    const older = (await call('GET', `/conversations/${id}?limit=10&before=${encodeURIComponent(page.messages[0].created_at)}`, u.token)).json();
    expect(older.messages.map((m: { content: string }) => m.content)).toEqual(['m1', 'm2', 'm3']);
    expect(older.has_more).toBe(false);
  });
});
