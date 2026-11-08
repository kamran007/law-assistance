'use client';

import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { signOut } from '@/lib/auth/session';
import { useAuth } from '@/lib/auth/use-auth';

export function AccountMenu() {
  const auth = useAuth();
  const t = useTranslations('nav');
  const router = useRouter();
  if (auth.status === 'loading') return <span className="w-16" aria-hidden />;
  if (auth.status === 'signedOut') {
    return (
      <Link href="/login" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white">
        {t('signIn')}
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-3 text-sm">
      <Link href="/cases" className="font-medium text-brand-700 hover:underline">
        {t('cases')}
      </Link>
      <span className="hidden max-w-40 truncate sm:inline" title={auth.user.full_name}>
        {auth.user.full_name || auth.user.contact}
      </span>
      <button
        type="button"
        onClick={async () => {
          await signOut();
          router.replace('/');
        }}
        className="rounded-lg border border-[var(--border)] px-3 py-1.5"
      >
        {t('signOut')}
      </button>
    </div>
  );
}
