import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthFetch, unwrap } from '@/lib/api';
import { refreshSession, signOut, type SessionResponse } from '@/lib/auth/session';
import { authStore, type Me } from '@/lib/auth/store';
import { errorKey, safeNext } from '@/lib/problem';

/** WEB-02: session restore, single-flight refresh, 401 retry, sign-out, redirect safety. */
const user: Me = {
  user_id: 'u1',
  full_name: 'Rahim',
  contact: '+8801711000000',
  role: 'CITIZEN',
  requested_role: 'CITIZEN',
  verification_status: 'NOT_REQUIRED',
  preferred_language: 'BN',
  profile_complete: true,
};
const session = (token: string): SessionResponse => ({ access_token: token, token_type: 'Bearer', expires_in: 900, refresh_expires_at: '2026-12-08T00:00:00Z', user });
const problem = (status: number, code: string) => Response.json({ type: 'x', title: code, status, code }, { status });

afterEach(() => {
  authStore.clear();
  vi.unstubAllGlobals();
});

describe('refreshSession', () => {
  it('restores a session from the refresh cookie (no body, cookies included)', async () => {
    const fetch = vi.fn(async () => Response.json(session('at-1')));
    expect(await refreshSession(fetch)).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://localhost:3000/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    expect(authStore.accessToken).toBe('at-1');
    expect(authStore.getState()).toEqual({ status: 'signedIn', user });
  });

  it('never runs two refreshes at once: concurrent callers share one request', async () => {
    let release!: () => void;
    const fetch = vi.fn(() => new Promise<Response>((r) => (release = () => r(Response.json(session('at-2'))))));
    const both = Promise.all([refreshSession(fetch), refreshSession(fetch), refreshSession(fetch)]);
    await Promise.resolve();
    release();
    expect(await both).toEqual([true, true, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serialises refreshes across tabs with a Web Lock', async () => {
    const request = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
    vi.stubGlobal('navigator', { locks: { request } });
    await refreshSession(vi.fn(async () => Response.json(session('at-3'))));
    expect(request).toHaveBeenCalledWith('lawassist-auth-refresh', expect.any(Function));
  });

  it('signs out on 401 (expired, revoked or reused refresh token)', async () => {
    authStore.setSession('old', 900, user);
    expect(await refreshSession(vi.fn(async () => problem(401, 'REFRESH_REUSED')))).toBe(false);
    expect(authStore.getState()).toEqual({ status: 'signedOut' });
    expect(authStore.accessToken).toBeNull();
  });

  it('keeps an existing session through a server error, but ends the loading state without one', async () => {
    authStore.setSession('still-valid', 900, user);
    expect(await refreshSession(vi.fn(async () => problem(503, 'UNAVAILABLE')))).toBe(false);
    expect(authStore.accessToken).toBe('still-valid');

    authStore.clear();
    expect(await refreshSession(vi.fn(async () => Promise.reject(new TypeError('offline'))))).toBe(false);
    expect(authStore.getState()).toEqual({ status: 'signedOut' });
  });
});

describe('createAuthFetch', () => {
  it('refreshes once on a 401 and resends the request (with its body) with the new token', async () => {
    authStore.setSession('expired', 900, user);
    const seen: { auth: string | null; body: string }[] = [];
    const base = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      seen.push({ auth: req.headers.get('authorization'), body: await req.text() });
      return seen.length === 1 ? problem(401, 'TOKEN_INVALID') : Response.json({ ok: true });
    });
    const refresh = vi.fn(async () => {
      authStore.setSession('fresh', 900, user);
      return true;
    });
    const res = await createAuthFetch(base, refresh)('http://api.test/api/v1/cases', { method: 'POST', body: '{"title":"x"}', headers: { authorization: 'Bearer expired' } });
    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { auth: 'Bearer expired', body: '{"title":"x"}' },
      { auth: 'Bearer fresh', body: '{"title":"x"}' },
    ]);
  });

  it('returns the 401 when the refresh fails, and never retries anonymous or auth requests', async () => {
    const base = vi.fn(async () => problem(401, 'TOKEN_INVALID'));
    const failing = vi.fn(async () => false);
    expect((await createAuthFetch(base, failing)('http://api.test/api/v1/me', { headers: { authorization: 'Bearer x' } })).status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);

    const refresh = vi.fn(async () => true);
    await createAuthFetch(base, refresh)('http://api.test/api/v1/me');
    await createAuthFetch(base, refresh)('http://api.test/api/v1/auth/logout', { method: 'POST', headers: { authorization: 'Bearer x' } });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('signOut', () => {
  it('clears the token locally first, then revokes the session on the server', async () => {
    authStore.setSession('at-9', 900, user);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    await signOut(fetch);
    expect(authStore.getState()).toEqual({ status: 'signedOut' });
    expect(fetch).toHaveBeenCalledWith('http://localhost:3000/api/v1/auth/logout', { method: 'POST', credentials: 'include', headers: { authorization: 'Bearer at-9' } });
  });
});

describe('helpers', () => {
  it('safeNext only allows same-site relative paths', () => {
    expect(safeNext('/cases/1')).toBe('/cases/1');
    for (const bad of [null, '', 'https://evil.test', '//evil.test', `/${String.fromCodePoint(0x5c)}evil.test`, 'cases']) expect(safeNext(bad)).toBe('/');
  });

  it('errorKey maps problems to message keys, offline to NETWORK, unknown codes to generic', () => {
    expect(errorKey({ type: 'x', title: 't', status: 400, code: 'OTP_INVALID' })).toBe('OTP_INVALID');
    expect(errorKey({ type: 'x', title: 't', status: 500, code: 'SOMETHING_ELSE' })).toBe('generic');
    expect(errorKey(new TypeError('Failed to fetch'))).toBe('NETWORK');
  });

  it('unwrap returns data or throws the problem', async () => {
    expect(await unwrap(Promise.resolve({ data: 1 }))).toBe(1);
    await expect(unwrap(Promise.resolve({ error: { code: 'X' } }))).rejects.toEqual({ code: 'X' });
  });
});
