'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useId } from 'react';
import { Link } from '@/i18n/navigation';
import { useSectionJudgments } from '@/lib/case-law';
import { isStatus } from '@/lib/cases';

/**
 * "Judgments on this section" (App Flow §7.1, §7.3; FR-D6): the Supreme Court judgments linked to a
 * section, each with the paragraphs that discuss it and a warning when the judgment was decided
 * before the section's current wording took effect.
 */
export function SectionJudgments({ actId, sec, limit = 5 }: { actId: number; sec: string; limit?: number }) {
  const t = useTranslations('caseLaw');
  const format = useFormatter();
  const headingId = useId();
  const { data, isPending, isError, error } = useSectionJudgments(actId, sec, limit);
  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });

  // An unknown section has no judgments block at all; the page shows its own not-found state.
  if (isError && isStatus(error, 404)) return null;

  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-lg border border-[var(--border)] p-3">
      <h3 id={headingId} className="text-sm font-semibold">
        {t('onSection')}
      </h3>
      {isPending ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          {t('loading')}
        </p>
      ) : isError ? (
        <p role="alert" className="text-sm text-red-800 dark:text-red-200">
          {t('loadFailed')}
        </p>
      ) : data.items.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">{t('noneOnSection')}</p>
      ) : (
        <>
          <ul className="space-y-2">
            {data.items.map((j) => (
              <li key={j.judgment_id} className="space-y-0.5 text-sm">
                <Link href={`/library/judgments/${j.judgment_id}${j.paragraphs[0] ? `#para-${j.paragraphs[0]}` : ''}`} className="font-medium text-brand-700 underline">
                  {j.parties}
                </Link>
                <p className="text-xs text-[var(--muted)]">
                  {[j.citation, t(`division.${j.division}`), j.decision_date ? date(j.decision_date) : null].filter(Boolean).join(' · ')}
                  {j.paragraphs.length > 0 && <> · {t('paras', { paras: j.paragraphs.join(', ') })}</>}
                </p>
                {j.older_than_current_version && (
                  <p className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">
                    {j.section_amended_on ? t('olderThanCurrent', { date: date(j.section_amended_on) }) : t('olderThanCurrentNoDate')}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {data.total > data.items.length && (
            <Link href={{ pathname: '/library/judgments', query: { act_id: String(actId), sec } }} className="text-sm text-brand-700 underline">
              {t('seeAll', { count: data.total })}
            </Link>
          )}
        </>
      )}
    </section>
  );
}
