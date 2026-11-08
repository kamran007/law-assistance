import { isProblem, type paths } from '@lawassist/contracts';
import { API_URL } from '../env';
import { authStore } from './store';

export type SessionResponse = paths['/api/v1/auth/refresh']['post']['responses'][200]['content']['application/json'];

/** Refresh this long before the access token expires. */
export const REFRESH_LEAD_MS = 60_000;

let inFlight: Promise<boolean> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Refresh tokens rotate and the API ends the
 * whole session when one is used twice (TRD §12.1), so refreshes never overlap: one at a time per
 * tab (shared promise) and across tabs (Web Locks). A tab that waited on the lock sends the cookie
 * the previous tab just received. Resolves false when there is no valid session.
 */
export function refreshSession(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  inFlight ??= withRefreshLock(() => doRefresh(fetchImpl)).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request('lawassist-auth-refresh', fn) : fn();
}

async function doRefresh(fetchImpl: typeof fetch): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchImpl(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' });
  } catch {
    // Offline or API down: keep a session we already have; without one the user is signed out.
    if (authStore.accessToken === null) authStore.clear();
    return false;
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    // 401 = no valid session (expired, revoked or reused). Anything else is a server problem.
    // A server error keeps an existing session (the token may still be valid for a while).
    if (res.status === 401 || (isProblem(body) && body.status === 401) || authStore.accessToken === null) authStore.clear();
    return false;
  }
  const s = (await res.json()) as SessionResponse;
  authStore.setSession(s.access_token, s.expires_in, s.user);
  return true;
}

/** Stores a session from sign-in. */
export function startSession(s: SessionResponse) {
  authStore.setSession(s.access_token, s.expires_in, s.user);
}

/** Ends the session on the server (revokes the refresh family) and locally. */
export async function signOut(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<void> {
  const token = authStore.accessToken;
  authStore.clear();
  if (!token) return;
  await fetchImpl(`${API_URL}/api/v1/auth/logout`, { method: 'POST', credentials: 'include', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
}
