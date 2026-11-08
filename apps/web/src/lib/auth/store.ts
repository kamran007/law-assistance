import type { paths } from '@lawassist/contracts';

/** The signed-in user, as `GET /api/v1/me` returns it (generated contract). */
export type Me = paths['/api/v1/me']['get']['responses'][200]['content']['application/json'];

export type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: Me };

/**
 * Session state for the browser (TRD §12.1). The access token lives in memory only, never in
 * localStorage, where an injected script could read it; the refresh token is an HttpOnly cookie
 * scoped to /api/v1/auth/refresh that only the browser can send.
 */
class AuthStore {
  private state: AuthState = { status: 'loading' };
  private token: { value: string; expiresAt: number } | null = null;
  private readonly listeners = new Set<() => void>();

  getState = (): AuthState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  get accessToken(): string | null {
    return this.token?.value ?? null;
  }
  get expiresAt(): number | null {
    return this.token?.expiresAt ?? null;
  }

  setSession(accessToken: string, expiresInS: number, user: Me, now = Date.now()) {
    this.token = { value: accessToken, expiresAt: now + expiresInS * 1000 };
    this.emit({ status: 'signedIn', user });
  }

  setUser(user: Me) {
    if (this.state.status === 'signedIn') this.emit({ status: 'signedIn', user });
  }

  clear() {
    this.token = null;
    this.emit({ status: 'signedOut' });
  }

  private emit(next: AuthState) {
    this.state = next;
    for (const l of this.listeners) l();
  }
}

export const authStore = new AuthStore();
