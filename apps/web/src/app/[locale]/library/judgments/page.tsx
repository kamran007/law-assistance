import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { LibraryTabs } from '@/components/library/library-tabs';
import { Link } from '@/i18n/navigation';
import { dataOrNull, judgmentLang, LIBRARY_REVALIDATE_S, serverApi, type JudgmentList } from '@/lib/server-api';

const PAGE_SIZE = 20;

type Search = { q?: string; division?: string; year?: string; judge?: string; act_id?: string; sec?: string; sort?: string; page?: string };

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'caseLaw' });
  return { title: t('title'), description: t('description'), alternates: { languages: { bn: '/bn/library/judgments', en: '/en/library/judgments' } } };
}

/** Case Law search (App Flow §7.3): Supreme Court Online Bulletin judgments. Public; a plain GET form. */
export default async function JudgmentsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('caseLaw');
  const format = await getFormatter();
  const sp = await searchParams;
  const q = sp.q?.trim().slice(0, 200) || undefined;
  const division = sp.division === 'AD' || sp.division === 'HCD' ? sp.division : undefined;
  const year = sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : undefined;
  const judge = sp.judge?.trim().slice(0, 100) || undefined;
  const actId = sp.act_id && /^\d{1,9}$/.test(sp.act_id) ? Number(sp.act_id) : undefined;
  const sec = actId && sp.sec ? sp.sec.slice(0, 32) : undefined;
  const sort = sp.sort === 'relevance' ? 'relevance' : undefined; // newest first by default
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  let list: JudgmentList | null | 'error';
  try {
    list = await dataOrNull(
      serverApi(LIBRARY_REVALIDATE_S).GET('/api/v1/judgments', {
        params: { query: { q: q && q.length >= 2 ? q : undefined, division, year, judge: judge && judge.length >= 2 ? judge : undefined, act_id: actId, sec, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE } },
      }),
    );
  } catch {
    list = 'error';
  }

  const query = (p: number) => ({
    ...(q ? { q } : {}),
    ...(division ? { division } : {}),
    ...(year ? { year: String(year) } : {}),
    ...(judge ? { judge } : {}),
    ...(actId ? { act_id: String(actId) } : {}),
    ...(sec ? { sec } : {}),
    ...(sort ? { sort } : {}),
    ...(p > 1 ? { page: String(p) } : {}),
  });
  const pages = list && list !== 'error' ? Math.ceil(list.total / PAGE_SIZE) : 0;
  const input = 'rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2';

  return (
    <div className="space-y-6">
      <LibraryTabs current="judgments" />
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-[var(--muted)]">{t('description')}</p>
      </div>

      <form role="search" method="get" className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm font-medium">{t('searchLabel')}</span>
          <input name="q" type="search" defaultValue={q ?? ''} placeholder={t('searchPlaceholder')} maxLength={200} className={`w-full ${input}`} />
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium">{t('divisionLabel')}</span>
          <select name="division" defaultValue={division ?? ''} className={input}>
            <option value="">{t('divisionAll')}</option>
            <option value="AD">{t('division.AD')}</option>
            <option value="HCD">{t('division.HCD')}</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium">{t('year')}</span>
          <input name="year" inputMode="numeric" pattern="[0-9]{4}" defaultValue={year ?? ''} className={`w-24 ${input}`} />
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium">{t('judge')}</span>
          <input name="judge" defaultValue={judge ?? ''} maxLength={100} className={`w-40 ${input}`} />
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium">{t('sort')}</span>
          <select name="sort" defaultValue={sort ?? ''} className={input}>
            <option value="">{t('sortNewest')}</option>
            <option value="relevance">{t('sortRelevance')}</option>
          </select>
        </label>
        {actId && <input type="hidden" name="act_id" value={actId} />}
        {sec && <input type="hidden" name="sec" value={sec} />}
        <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white">
          {t('search')}
        </button>
      </form>

      {actId && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded bg-brand-50 px-2 py-1 dark:bg-brand-900">{sec ? t('filterSection', { act: actId, sec }) : t('filterAct', { act: actId })}</span>
          <Link href={{ pathname: '/library/judgments', query: { ...(q ? { q } : {}) } }} className="text-brand-700 underline">
            {t('clearFilter')}
          </Link>
        </p>
      )}

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
            {list.items.map((j) => (
              <li key={j.judgment_id}>
                <Link href={`/library/judgments/${j.judgment_id}`} className="block space-y-1 px-4 py-3 hover:bg-brand-50 dark:hover:bg-brand-900">
                  <span className="block font-medium" lang={judgmentLang(j.language)}>
                    {j.parties}
                  </span>
                  <span className="block text-sm text-[var(--muted)]">
                    {[j.citation, t(`division.${j.division}`), j.decision_date ? format.dateTime(new Date(`${j.decision_date}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) : null, j.authoring_judge]
                      .filter(Boolean)
                      .join(' · ')}
                    {!j.text_available && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">{t('textPending')}</span>}
                  </span>
                  {j.key_words && (
                    <span className="line-clamp-2 block text-sm" lang={judgmentLang(j.language)}>
                      {j.key_words}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label={t('pagination')} className="flex items-center justify-between text-sm">
              {page > 1 ? (
                <Link href={{ pathname: '/library/judgments', query: query(page - 1) }} className="text-brand-700 underline">
                  {t('previous')}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-[var(--muted)]">{t('pageOf', { page, pages })}</span>
              {page < pages ? (
                <Link href={{ pathname: '/library/judgments', query: query(page + 1) }} className="text-brand-700 underline">
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
