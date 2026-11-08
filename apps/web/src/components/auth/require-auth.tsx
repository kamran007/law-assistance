'use client';

import { useTranslations } from 'next-intl';
import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import type { Me } from '@/lib/auth/store';
import { useAuth } from '@/lib/auth/use-auth';

/**
 * Client-side gate for pages that need a session: signed-out visitors go to the login screen and
 * come back afterwards. The API enforces access on every request; this only decides what to show.
 */
export function RequireAuth({ children, allowIncompleteProfile = false }: { children: (user: Me) => ReactNode; allowIncompleteProfile?: boolean }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('auth');

  useEffect(() => {
    if (auth.status === 'signedOut') router.replace({ pathname: '/login', query: { next: pathname } });
    else if (auth.status === 'signedIn' && !auth.user.profile_complete && !allowIncompleteProfile) {
      router.replace({ pathname: '/onboarding', query: { next: pathname } });
    }
  }, [auth, router, pathname, allowIncompleteProfile]);

  if (auth.status !== 'signedIn' || (!auth.user.profile_complete && !allowIncompleteProfile)) {
    return (
      <p role="status" className="py-16 text-center text-[var(--muted)]">
        {t('checkingSession')}
      </p>
    );
  }
  return children(auth.user);
}
