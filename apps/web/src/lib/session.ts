/**
 * Access token in memory only (TRD §12.1): never in localStorage, where any injected script could
 * read it. The refresh token is an HttpOnly cookie the browser sends to /api/v1/auth/refresh.
 * Sign-in and silent refresh arrive with WEB-02.
 */
let accessToken: string | null = null;
const listeners = new Set<() => void>();

export const session = {
  get token() {
    return accessToken;
  },
  set(token: string | null) {
    accessToken = token;
    for (const l of listeners) l();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};
