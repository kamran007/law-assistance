import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { cache } from 'react';
import { Link } from '@/i18n/navigation';
import { actTitle, dataOrNull, LIBRARY_REVALIDATE_S, serverApi } from '@/lib/server-api';

export const revalidate = 3600;

const loadAct = cache(async (actId: number) => dataOrNull(serverApi(LIBRARY_REVALIDATE_S).GET('/api/v1/statutes/{act_id}', { params: { path: { act_id: actId } } })));
const parseId = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function generateMetadata({ params }: { params: Promise<{ locale: string; actId: string }> }): Promise<Metadata> {
  const { locale, actId } = await params;
  const id = parseId(actId);
  const act = id === null ? null : await loadAct(id).catch(() => null);
  if (!act) return {};
  return { title: actTitle(act, locale), alternates: { languages: { bn: `/bn/library/${id}`, en: `/en/library/${id}` } } };
}

/** Act Detail: chapters and their sections (App Flow §7.2). */
export default async function ActPage({ params }: { params: Promise<{ locale: string; actId: string }> }) {
  const { locale, actId } = await params;
  setRequestLocale(locale);
  const id = parseId(actId);
  if (id === null) notFound();
  const act = await loadAct(id);
  if (!act) notFound();
  const t = await getTranslations('library');
  const format = await getFormatter();
  const lang = act.language === 'BN' ? 'bn' : 'en';

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/library" className="text-sm text-brand-700 underline">
          {t('backToList')}
        </Link>
        <h1 className="text-2xl font-semibold" lang={lang}>
          {actTitle(act, locale)}
        </h1>
        <p className="text-sm text-[var(--muted)]">
          {[act.act_number, act.enacted_date ? t('enacted', { date: format.dateTime(new Date(`${act.enacted_date}T00:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' }) }) : null].filter(Boolean).join(' · ')}
        </p>
        {act.status === 'REPEALED' && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">{t('repealedNotice')}</p>}
      </div>

      {act.chapters.length === 0 ? (
        <p className="text-[var(--muted)]">{t('noSections')}</p>
      ) : (
        <div className="space-y-2">
          {act.chapters.map((c, i) => (
            <details key={i} open={act.chapters.length <= 3} className="rounded-xl border border-[var(--border)] bg-[var(--card)]">
              <summary className="cursor-pointer px-4 py-3 font-medium" lang={lang}>
                {c.chapter ?? t('noChapter')} <span className="text-sm font-normal text-[var(--muted)]">({t('sectionCount', { count: c.sections.length })})</span>
              </summary>
              <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                {c.sections.map((s) => (
                  <li key={s.sec}>
                    <Link href={`/library/${act.act_id}/${encodeURIComponent(s.sec)}`} className="flex gap-3 px-4 py-2 text-sm hover:bg-brand-50 dark:hover:bg-brand-900">
                      <span className="w-14 shrink-0 font-medium">{s.section_number}</span>
                      <span lang={lang}>{s.heading ?? ''}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
      <p className="text-xs text-[var(--muted)]">
        {t('source')}{' '}
        <a href={act.source_url} rel="noopener noreferrer" target="_blank" className="underline">
          bdlaws.minlaw.gov.bd
        </a>
        {act.last_synced_at && <> · {t('synced', { date: format.dateTime(new Date(act.last_synced_at), { dateStyle: 'medium' }) })}</>}
      </p>
    </div>
  );
}
