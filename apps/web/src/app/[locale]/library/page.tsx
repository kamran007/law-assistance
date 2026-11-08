import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { LibraryTabs } from '@/components/library/library-tabs';
import { Link } from '@/i18n/navigation';
import { actTitle, dataOrNull, LIBRARY_REVALIDATE_S, serverApi } from '@/lib/server-api';

const PAGE_SIZE = 20;

type Search = { q?: string; status?: string; year?: string; page?: string };

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'library' });
  return { title: t('title'), description: t('description'), alternates: { languages: { bn: '/bn/library', en: '/en/library' } } };
}

/** Statute Browser (App Flow §7.2): search by title, act number or year; filter Active / Repealed. Public. */
export default async function LibraryPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('library');
  const format = await getFormatter();
  const sp = await searchParams;
  const q = sp.q?.trim().slice(0, 200) || undefined;
  const status = sp.status === 'ACTIVE' || sp.status === 'REPEALED' ? sp.status : undefined;
  const year = sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  let list: Awaited<ReturnType<typeof load>> | 'error';
  async function load() {
    return dataOrNull(serverApi(LIBRARY_REVALIDATE_S).GET('/api/v1/statutes', { params: { query: { q, status, year, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE } } }));
  }
  try {
    list = await load();
  } catch {
    list = 'error';
  }

  const query = (p: number) => ({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(year ? { year: String(year) } : {}), ...(p > 1 ? { page: String(p) } : {}) });
  const pages = list && list !== 'error' ? Math.ceil(list.total / PAGE_SIZE) : 0;

  return (
    <div className="space-y-6">
      <LibraryTabs current="acts" />
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-[var(--muted)]">{t('description')}</p>
      </div>

      {/* A plain GET form: works without JavaScript and gives shareable result URLs. */}
      <form role="search" method="get" className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm font-medium">{t('searchLabel')}</span>
          <input name="q" type="search" defaultValue={q ?? ''} placeholder={t('searchPlaceholder')} maxLength={200} className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2" />
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium">{t('status')}</span>
          <select name="status" defaultValue={status ?? ''} className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2">
            <option value="">{t('statusAll')}</option>
            <option value="ACTIVE">{t('statusActive')}</option>
            <option value="REPEALED">{t('statusRepealed')}</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium">{t('year')}</span>
          <input name="year" inputMode="numeric" pattern="[0-9]{4}" defaultValue={year ?? ''} className="w-24 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2" />
        </label>
        <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white">
          {t('search')}
        </button>
      </form>

      {list === 'error' ? (
        <p role="alert" className="text-red-700">
          {t('loadFailed')}
        </p>
      ) : !list || list.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-[var(--muted)]">{t('noResults')}</p>
      ) : (
        <>
          <p className="text-sm text-[var(--muted)]" aria-live="polite">
            {t('count', { count: list.total })}
          </p>
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--card)]">
            {list.items.map((a) => (
              <li key={a.act_id}>
                <Link href={`/library/${a.act_id}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-brand-50 dark:hover:bg-brand-900">
                  <span className="font-medium" lang={a.language === 'BN' ? 'bn' : 'en'}>
                    {actTitle(a, locale)}
                  </span>
                  <span className="text-sm text-[var(--muted)]">
                    {[a.act_number, a.enacted_date ? format.dateTime(new Date(`${a.enacted_date}T00:00:00Z`), { year: 'numeric', timeZone: 'UTC' }) : null].filter(Boolean).join(' · ')}
                    {a.status === 'REPEALED' && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-900 dark:bg-red-950 dark:text-red-200">{t('statusRepealed')}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label={t('pagination')} className="flex items-center justify-between text-sm">
              {page > 1 ? (
                <Link href={{ pathname: '/library', query: query(page - 1) }} className="text-brand-700 underline">
                  {t('previous')}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-[var(--muted)]">{t('pageOf', { page, pages })}</span>
              {page < pages ? (
                <Link href={{ pathname: '/library', query: query(page + 1) }} className="text-brand-700 underline">
                  {t('next')}
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
