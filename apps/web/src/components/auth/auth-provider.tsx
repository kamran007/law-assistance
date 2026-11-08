'use client';

import { useEffect, type ReactNode } from 'react';
import { REFRESH_LEAD_MS, refreshSession } from '@/lib/auth/session';
import { authStore } from '@/lib/auth/store';

/**
 * Restores the session from the refresh cookie on load and refreshes the access token shortly
 * before it expires (App Flow §3: silent refresh). Failing to refresh signs the user out; pages
 * that need a session then send them to the login screen.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (authStore.getState().status === 'loading') void refreshSession();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      const expiresAt = authStore.expiresAt;
      if (authStore.getState().status !== 'signedIn' || expiresAt === null) return;
      timer = setTimeout(() => void refreshSession(), Math.max(0, expiresAt - REFRESH_LEAD_MS - Date.now()));
    };
    schedule();
    const unsubscribe = authStore.subscribe(schedule);
    // A laptop waking from sleep may have missed the timer.
    const onVisible = () => {
      const expiresAt = authStore.expiresAt;
      if (document.visibilityState === 'visible' && expiresAt !== null && expiresAt - REFRESH_LEAD_MS <= Date.now()) void refreshSession();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return children;
}
