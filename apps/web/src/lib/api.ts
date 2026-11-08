import { createApiClient } from '@lawassist/contracts';
import { refreshSession } from './auth/session';
import { authStore } from './auth/store';
import { API_URL } from './env';

/**
 * fetch with one silent retry: a 401 on a request that carried an access token means it expired
 * or was revoked, so refresh once and resend. If the refresh fails the store is signed out and the
 * 401 is returned to the caller.
 */
export function createAuthFetch(base: typeof fetch = (...a) => fetch(...a), refresh: () => Promise<boolean> = () => refreshSession(base)): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const retryCopy = request.clone();
    const res = await base(request);
    if (res.status !== 401 || !request.headers.has('authorization') || request.url.includes('/api/v1/auth/')) return res;
    if (!(await refresh()) || !authStore.accessToken) return res;
    retryCopy.headers.set('authorization', `Bearer ${authStore.accessToken}`);
    return base(retryCopy);
  };
}

/** Typed client for the browser; the language follows the page's <html lang>. */
export const api = createApiClient({
  baseUrl: API_URL,
  getAccessToken: () => authStore.accessToken,
  getLanguage: () => (typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'bn'),
  fetch: createAuthFetch(),
});

/**
 * Returns the data of an API call or throws its problem body (or a TypeError when offline).
 * The OpenAPI document declares success responses only, so openapi-fetch types `error` as never.
 */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const { data, error } = await call;
  if (error !== undefined || data === undefined) throw error ?? new Error('Empty response');
  return data;
}
