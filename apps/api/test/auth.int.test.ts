import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { loadConfig } from '@lawassist/config';
import { auditLog, createDb, refreshTokens, runMigrations, users, type Db } from '@lawassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app';
import { jwtAuthenticate } from '../src/modules/auth/authenticate';
import type { OtpMessage, OtpSender } from '../src/modules/auth/otp';
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from '../src/modules/auth/routes';
import { AuthService } from '../src/modules/auth/service';
import { TokenService } from '../src/modules/auth/tokens';
import { noCache } from '../src/modules/statutes/cache';
import { StatutesRepository } from '../src/modules/statutes/repository';

/**
 * BE-03/BE-04 end to end against MySQL 8.4 (Testcontainers, needs Docker): OTP request limits,
 * verification and attempt limits, first-login sign-up, refresh rotation with reuse detection,
 * the web cookie flow, logout, /me and credential submission. A movable clock drives expiry.
 */
let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;
let app: App;
let clock = new Date('2026-11-04T10:00:00Z');
const advance = (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000));
const sent: OtpMessage[] = [];
const sender: OtpSender = { send: async (m) => void sent.push(m) };
let ip = 0;

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci', '--log-bin-trust-function-creators=1'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));
  const now = () => clock;
  const tokens = await TokenService.ephemeral(now);
  const authenticate = jwtAuthenticate(tokens);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: url }), {
    auth: { service: new AuthService({ db, tokens, sender, otpKey: 'k'.repeat(32), now }), authenticate, secureCookies: true },
    statutes: { repo: new StatutesRepository(db), cache: noCache, authenticate, today: () => '2026-11-04' },
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await close?.();
  await container?.stop();
});

type Res = Awaited<ReturnType<App['inject']>>;
/** Each request gets its own client IP so the per-IP rate limits don't interfere across tests. */
const post = (url: string, payload?: object, headers: Record<string, string> = {}): Promise<Res> =>
  app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: `10.0.0.${++ip % 250}` });
const getAs = (url: string, token: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

async function requestCode(contact: string) {
  const res = await post('/auth/otp/request', { contact, language: 'EN' });
  expect(res.statusCode).toBe(202);
  return { challengeId: res.json().challenge_id as string, code: sent.at(-1)!.code };
}

async function signIn(contact: string, client: 'web' | 'mobile' = 'mobile') {
  advance(3600); // clear the per-contact resend window
  const { challengeId, code } = await requestCode(contact);
  const res = await post('/auth/otp/verify', { challenge_id: challengeId, code, client });
  expect(res.statusCode).toBe(200);
  return res;
}

describe('OTP request', () => {
  it('normalizes the contact, sends a code and returns the timings', async () => {
    const res = await post('/auth/otp/request', { contact: '01712-345678' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ channel: 'SMS', expires_in_s: 300, resend_after_s: 60 });
    expect(sent.at(-1)).toMatchObject({ channel: 'SMS', to: '+8801712345678', language: 'BN' });
    expect(res.body).not.toContain(sent.at(-1)!.code);
  });

  it('rejects contacts that are neither a BD mobile number nor an email', async () => {
    const res = await post('/auth/otp/request', { contact: '+447911123456' });
    expect(res.json()).toMatchObject({ status: 422, code: 'INVALID_CONTACT' });
  });

  it('allows a resend after 60 s and at most 3 codes per 10 minutes per contact', async () => {
    const contact = 'limits@example.com';
    await requestCode(contact);
    expect((await post('/auth/otp/request', { contact })).json()).toMatchObject({ status: 429, code: 'OTP_RESEND_TOO_SOON' });
    advance(61);
    await requestCode(contact);
    advance(61);
    await requestCode(contact);
    advance(61);
    expect((await post('/auth/otp/request', { contact })).json()).toMatchObject({ status: 429, code: 'OTP_RATE_LIMITED' });
    advance(10 * 60);
    await requestCode(contact);
  });
});

describe('OTP verify', () => {
  it('creates the account on first login as a CITIZEN with an incomplete profile', async () => {
    const res = await signIn('first@example.com');
    const body = res.json();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 900, is_new_user: true });
    expect(body.refresh_token).toEqual(expect.any(String));
    expect(body.user).toMatchObject({ contact: 'first@example.com', role: 'CITIZEN', verification_status: 'NOT_REQUIRED', profile_complete: false });
    const again = await signIn('first@example.com');
    expect(again.json()).toMatchObject({ is_new_user: false, user: { user_id: body.user.user_id } });
  });

  it('counts wrong codes, then locks the challenge even for the right code', async () => {
    advance(3600);
    const { challengeId, code } = await requestCode('wrong@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    const first = await post('/auth/otp/verify', { challenge_id: challengeId, code: wrong });
    expect(first.json()).toMatchObject({ status: 400, code: 'OTP_INVALID', detail: '4 attempts left' });
    for (let i = 0; i < 4; i++) await post('/auth/otp/verify', { challenge_id: challengeId, code: wrong });
    expect((await post('/auth/otp/verify', { challenge_id: challengeId, code })).json().code).toBe('OTP_TOO_MANY_ATTEMPTS');
  });

  it('rejects expired and already-used codes, and accepts Bangla digits', async () => {
    advance(3600);
    const a = await requestCode('expire@example.com');
    advance(301);
    expect((await post('/auth/otp/verify', { challenge_id: a.challengeId, code: a.code })).json().code).toBe('OTP_EXPIRED');

    advance(3600);
    const b = await requestCode('expire@example.com');
    const bangla = b.code.replace(/\d/g, (d) => String.fromCodePoint(0x09e6 + Number(d)));
    expect((await post('/auth/login', { challenge_id: b.challengeId, code: bangla })).statusCode).toBe(200); // SRS alias
    expect((await post('/auth/otp/verify', { challenge_id: b.challengeId, code: b.code })).json().code).toBe('OTP_INVALID');
  });

  it('lets exactly one of two concurrent verifications of the same code succeed', async () => {
    advance(3600);
    const { challengeId, code } = await requestCode('race@example.com');
    const results = await Promise.all([1, 2].map(() => post('/auth/otp/verify', { challenge_id: challengeId, code })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens; reusing an old one ends the whole session', async () => {
    const login = (await signIn('rotate@example.com')).json();
    const r1 = await post('/auth/refresh', { refresh_token: login.refresh_token });
    expect(r1.statusCode).toBe(200);
    const t2 = r1.json().refresh_token as string;
    expect(t2).not.toBe(login.refresh_token);

    expect((await post('/auth/refresh', { refresh_token: login.refresh_token })).json().code).toBe('REFRESH_REUSED');
    // The thief and the owner are both signed out: the newest token of the family is revoked too.
    expect((await post('/auth/refresh', { refresh_token: t2 })).json().code).toBe('REFRESH_INVALID');
    const family = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, login.user.user_id));
    expect(family.every((t) => t.revokedAt)).toBe(true);
  });

  it('expires refresh tokens after 30 days', async () => {
    const login = (await signIn('old@example.com')).json();
    advance(30 * 24 * 3600 + 1);
    expect((await post('/auth/refresh', { refresh_token: login.refresh_token })).json().code).toBe('REFRESH_EXPIRED');
  });

  it('web clients get the refresh token only as an HttpOnly, SameSite=Strict cookie on the refresh path', async () => {
    const res = await signIn('web@example.com', 'web');
    expect(res.json().refresh_token).toBeUndefined();
    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: REFRESH_COOKIE_PATH });

    const refreshed = await post('/auth/refresh', undefined, { cookie: `${REFRESH_COOKIE}=${cookie.value}` });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refresh_token).toBeUndefined();
    expect(refreshed.cookies.find((c) => c.name === REFRESH_COOKIE)!.value).not.toBe(cookie.value);
  });

  it('logout revokes the session; access tokens expire after 15 minutes', async () => {
    const login = (await signIn('logout@example.com')).json();
    expect((await getAs('/me', login.access_token)).statusCode).toBe(200);
    const out = await post('/auth/logout', undefined, { authorization: `Bearer ${login.access_token}` });
    expect(out.statusCode).toBe(204);
    expect((await post('/auth/refresh', { refresh_token: login.refresh_token })).json().code).toBe('REFRESH_INVALID');
    advance(15 * 60 + 1);
    expect((await getAs('/me', login.access_token)).json().code).toBe('TOKEN_EXPIRED');
  });
});

describe('/me and credentials', () => {
  it('completes the profile; the role can’t be set through PATCH /me', async () => {
    const { access_token } = (await signIn('profile@example.com')).json();
    const h = { authorization: `Bearer ${access_token}` };
    const patched = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: h, payload: { full_name: 'Rahima Akter', preferred_language: 'EN' } });
    expect(patched.json()).toMatchObject({ full_name: 'Rahima Akter', preferred_language: 'EN', profile_complete: true });
    const sneaky = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: h, payload: { role: 'JUDGE' } });
    expect(sneaky.json()).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/me' })).json().code).toBe('AUTH_REQUIRED');
  });

  it('a lawyer applicant is pending (Citizen features only) until approved; approval applies at the next refresh', async () => {
    const login = (await signIn('lawyer@example.com')).json();
    const h = { authorization: `Bearer ${login.access_token}` };
    const sub = await post('/me/credential', { requested_role: 'LAWYER', credential: 'BC-12345/2019' }, h);
    expect(sub.json()).toMatchObject({ role: 'CITIZEN', requested_role: 'LAWYER', verification_status: 'PENDING' });
    expect((await post('/me/credential', { requested_role: 'JUDGE', credential: 'J-1' }, h)).json().code).toBe('CREDENTIAL_PENDING');

    // The audit row records the event, never the credential number.
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, login.user.user_id));
    expect(audits.map((a) => a.action)).toEqual(['CREDENTIAL_SUBMITTED']);
    expect(JSON.stringify(audits[0]!.details)).not.toContain('12345');

    // Still pending: the access token says so, and professional tools are refused.
    const refreshed = (await post('/auth/refresh', { refresh_token: login.refresh_token })).json();
    const pending = await getAs('/statutes/11/sections/420?as_of=2020-01-01', refreshed.access_token);
    expect(pending.json()).toMatchObject({ status: 403, code: 'VERIFICATION_REQUIRED' });

    // Admin approval (BE-40 will do this through the console).
    await db.update(users).set({ role: 'LAWYER', verificationStatus: 'VERIFIED' }).where(eq(users.userId, login.user.user_id));
    const approved = (await post('/auth/refresh', { refresh_token: refreshed.refresh_token })).json();
    expect(approved.user).toMatchObject({ role: 'LAWYER', verification_status: 'VERIFIED' });
    // Auth passes now; the 404 is because this test database has no statutes.
    expect((await getAs('/statutes/11/sections/420?as_of=2020-01-01', approved.access_token)).json().code).toBe('STATUTE_NOT_FOUND');

    expect((await post('/me/credential', { requested_role: 'JUDGE', credential: 'J-1' }, { authorization: `Bearer ${approved.access_token}` })).json().code).toBe('ROLE_LOCKED');
  });

  it('rejects malformed tokens on protected routes instead of treating them as anonymous', async () => {
    expect((await getAs('/me', 'not.a.jwt')).json()).toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    expect((await getAs('/statutes/11/sections/420?as_of=2020-01-01', 'not.a.jwt')).json().code).toBe('TOKEN_INVALID');
    // Public current-law reads don't look at the token, so a stale one never blocks reading the law.
    expect((await getAs('/statutes/11/sections/420', 'not.a.jwt')).json().code).toBe('STATUTE_NOT_FOUND');
  });
});
