import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { cache } from 'react';
import { SectionJudgments } from '@/components/case-law/section-judgments';
import { LibraryProTools } from '@/components/verifier/library-pro-tools';
import { Link } from '@/i18n/navigation';
import { actTitle, dataOrNull, LIBRARY_REVALIDATE_S, serverApi } from '@/lib/server-api';

export const revalidate = 3600;

const parseId = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);
const loadSection = cache(async (actId: number, sec: string) =>
  dataOrNull(serverApi(LIBRARY_REVALIDATE_S).GET('/api/v1/statutes/{act_id}/sections/{sec}', { params: { path: { act_id: actId, sec } } })),
);

export async function generateMetadata({ params }: { params: Promise<{ locale: string; actId: string; sec: string }> }): Promise<Metadata> {
  const { locale, actId, sec } = await params;
  const id = parseId(actId);
  const data = id === null ? null : await loadSection(id, decodeURIComponent(sec)).catch(() => null);
  if (!data) return {};
  const t = await getTranslations({ locale, namespace: 'library' });
  const title = `${t('sectionTitle', { section: data.section.section_number })} · ${actTitle(data.act, locale)}`;
  return {
    title,
    description: data.section.heading ?? undefined,
    alternates: { languages: { bn: `/bn/library/${id}/${sec}`, en: `/en/library/${id}/${sec}` } },
  };
}

/** A section's current verbatim text, footnotes and verified Schedule II strip (public view of §7.1). */
export default async function SectionPage({ params }: { params: Promise<{ locale: string; actId: string; sec: string }> }) {
  const { locale, actId, sec } = await params;
  setRequestLocale(locale);
  const id = parseId(actId);
  if (id === null) notFound();
  const data = await loadSection(id, decodeURIComponent(sec));
  if (!data) notFound();
  const t = await getTranslations('library');
  const ts = await getTranslations('scan.sections');
  const format = await getFormatter();
  const { act, section: s, schedule_ii: sched } = data;
  const lang = act.language === 'BN' ? 'bn' : 'en';
  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' });

  return (
    <article className="space-y-6">
      <div className="space-y-2">
        <Link href={`/library/${act.act_id}`} className="text-sm text-brand-700 underline" lang={lang}>
          ← {actTitle(act, locale)}
        </Link>
        <h1 className="text-2xl font-semibold" lang={lang}>
          {t('sectionTitle', { section: s.section_number })}
          {s.heading && <span className="block text-lg font-normal">{s.heading}</span>}
        </h1>
        <p className="text-sm text-[var(--muted)]">
          {t('version', { version: s.version })}
          {s.valid_from && <> · {t('inForceFrom', { date: date(s.valid_from) })}</>}
          {act.status === 'REPEALED' && <> · {t('statusRepealed')}</>}
        </p>
      </div>

      {sched && (
        <section aria-labelledby="sched" className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h2 id="sched" className="text-sm font-semibold">
            {t('scheduleTitle')}
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
            {(
              [
                [ts('cognizable'), sched.is_cognizable ? ts('yes') : ts('no')],
                [ts('bailable'), sched.is_bailable ? ts('yes') : ts('no')],
                [ts('compoundable'), sched.is_compoundable ? ts('yes') : ts('no')],
                [ts('maxPunishment'), sched.max_punishment],
                [ts('court'), sched.triable_by_court],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-[var(--muted)]">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-[var(--muted)]">{t('scheduleNote')}</p>
        </section>
      )}

      {/* Verbatim text: whitespace preserved exactly as published. */}
      <div lang={lang} className="whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 leading-relaxed">
        {s.text}
      </div>

      {s.footnotes.length > 0 && (
        <section aria-labelledby="fn" className="space-y-2">
          <h2 id="fn" className="text-sm font-semibold">
            {t('footnotes')}
          </h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--muted)]" lang={lang}>
            {s.footnotes.map((f, i) => (
              <li key={i}>
                {f.text ? (
                  f.text
                ) : (
                  <>
                    {t(`footnoteAction.${f.action}`)}
                    {f.by_act && <> — {f.by_act}</>}
                    {f.date && <> ({date(f.date)})</>}
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <LibraryProTools actId={act.act_id} sec={s.sec} lang={lang} />
      <SectionJudgments actId={act.act_id} sec={s.sec} />
      <p className="text-xs text-[var(--muted)]">{t('verbatimNote')}</p>
    </article>
  );
}
