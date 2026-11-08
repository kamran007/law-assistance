'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';

export function LanguageSwitcher() {
  const t = useTranslations('language');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  return (
    <div role="group" aria-label={t('label')} className="inline-flex rounded-lg border border-[var(--border)] p-0.5 text-sm">
      {routing.locales.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          disabled={pending}
          onClick={() => startTransition(() => router.replace(pathname, { locale: l }))}
          className={`rounded-md px-3 py-1 transition-colors ${l === locale ? 'bg-brand-600 text-white' : 'text-[var(--muted)] hover:text-[var(--foreground)]'}`}
        >
          {t(l)}
        </button>
      ))}
    </div>
  );
}
