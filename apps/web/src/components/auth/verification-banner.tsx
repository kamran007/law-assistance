'use client';

import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/use-auth';

/**
 * App Flow §3: a Lawyer or Judge awaiting verification uses Citizen features with this banner.
 * The effective role comes from the server; this only explains it.
 */
export function VerificationBanner() {
  const auth = useAuth();
  const t = useTranslations('banner');
  if (auth.status !== 'signedIn') return null;
  const { requested_role: requested, verification_status: status } = auth.user;
  if (requested !== 'LAWYER' && requested !== 'JUDGE') return null;
  if (status !== 'PENDING' && status !== 'REJECTED') return null;
  const credential = t(requested === 'LAWYER' ? 'barCouncil' : 'judicialId');
  return (
    <div
      role="status"
      className={status === 'PENDING' ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100' : 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100'}
    >
      <p className="mx-auto max-w-6xl px-4 py-2 text-sm">{t(status === 'PENDING' ? 'pending' : 'rejected', { credential })}</p>
    </div>
  );
}
