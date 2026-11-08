'use client';

import { useSyncExternalStore } from 'react';
import { authStore, type AuthState } from './store';

const loading: AuthState = { status: 'loading' };

/** Current auth state; 'loading' on the server and until the first refresh attempt finishes. */
export function useAuth(): AuthState {
  return useSyncExternalStore(authStore.subscribe, authStore.getState, () => loading);
}
