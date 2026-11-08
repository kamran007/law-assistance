'use client';

import { useTranslations } from 'next-intl';

/** Shown when the API can't be reached while rendering a library page. */
export default function LibraryError({ reset }: { reset: () => void }) {
  const t = useTranslations('library');
  return (
    <div role="alert" className="space-y-3 py-16 text-center">
      <p className="font-medium">{t('loadFailed')}</p>
      <button type="button" onClick={reset} className="rounded-lg border border-[var(--border)] px-4 py-2">
        {t('retry')}
      </button>
    </div>
  );
}
