'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useCases } from '@/lib/cases';

/** Case File List (App Flow §8.1): the caller's own cases, newest change first. */
export function CaseList() {
  const t = useTranslations('cases');
  const format = useFormatter();
  const { data, isPending, isError, refetch } = useCases();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Link href="/cases/new" className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white">
          {t('new')}
        </Link>
      </div>
      {isPending ? (
        <p role="status" className="text-[var(--muted)]">
          {t('loading')}
        </p>
      ) : isError ? (
        <p role="alert" className="text-red-700">
          {t('loadFailed')}{' '}
          <button type="button" onClick={() => void refetch()} className="underline">
            {t('retry')}
          </button>
        </p>
      ) : data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center">
          <p className="font-medium">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--card)]">
          {[...data]
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
            .map((c) => (
              <li key={c.case_id}>
                <Link href={`/cases/${c.case_id}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-brand-50 dark:hover:bg-brand-900">
                  <span className="font-medium">{c.title ?? c.case_number ?? t('untitled')}</span>
                  <span className="text-sm text-[var(--muted)]">
                    {[c.case_number && c.title ? c.case_number : null, c.court_or_thana].filter(Boolean).join(' · ')}
                  </span>
                  <span className="w-full text-xs text-[var(--muted)]">{t('updated', { date: format.dateTime(new Date(c.updated_at), { dateStyle: 'medium' }) })}</span>
                </Link>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
