import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { use } from 'react';
import { ApiStatus } from '@/components/api-status';

const SECTIONS = ['assistant', 'library', 'cases'] as const;

export default function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations('home');

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
        <p className="max-w-2xl text-lg text-[var(--muted)]">{t('subtitle')}</p>
        <ApiStatus />
      </section>
      <ul className="grid gap-4 sm:grid-cols-3">
        {SECTIONS.map((s) => (
          <li key={s} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
            <h2 className="font-semibold">{t(`sections.${s}.title`)}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{t(`sections.${s}.body`)}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[var(--muted)]">{t('disclaimer')}</p>
    </div>
  );
}
