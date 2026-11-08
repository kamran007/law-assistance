'use client';

import { useTranslations } from 'next-intl';
import type { AnalysedSection } from '@/lib/scan-result';

/**
 * Cited sections with their CrPC Schedule II status (App Flow §9.4). Status values come only from
 * the verified schedule table the worker joined; a section without a verified row says so and
 * shows no status at all (FR-B3: never an AI-guessed bail or cognizance status).
 */
export function SectionsTable({ sections, scheduleDate }: { sections: AnalysedSection[]; scheduleDate: string }) {
  const t = useTranslations('scan.sections');
  if (sections.length === 0) return <p className="text-sm text-[var(--muted)]">{t('none')}</p>;
  const yesNo = (v: boolean) => (v ? t('yes') : t('no'));
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">{t('caption')}</caption>
          <thead className="bg-[var(--background)] text-left text-xs text-[var(--muted)]">
            <tr>
              <th scope="col" className="px-3 py-2">{t('section')}</th>
              <th scope="col" className="px-3 py-2">{t('cognizable')}</th>
              <th scope="col" className="px-3 py-2">{t('bailable')}</th>
              <th scope="col" className="px-3 py-2">{t('compoundable')}</th>
              <th scope="col" className="px-3 py-2">{t('maxPunishment')}</th>
              <th scope="col" className="px-3 py-2">{t('court')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {sections.map((s) => {
              const label = t('ref', { act: s.act?.name ?? t('unknownAct'), section: `${s.section}${s.subsection ?? ''}` });
              return (
                <tr key={`${s.act?.key ?? '?'}:${s.key}:${s.subsection ?? ''}`}>
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {label}
                    {s.actInferred && <span className="block text-xs font-normal text-[var(--muted)]">{t('actInferred')}</span>}
                    {s.source === 'USER_CORRECTED' && <span className="block text-xs font-normal text-[var(--muted)]">{t('userCorrected')}</span>}
                  </th>
                  {s.scheduleStatus === 'VERIFIED' && s.schedule ? (
                    <>
                      <td className="px-3 py-2">{yesNo(s.schedule.isCognizable)}</td>
                      <td className="px-3 py-2">{yesNo(s.schedule.isBailable)}</td>
                      <td className="px-3 py-2">{yesNo(s.schedule.isCompoundable)}</td>
                      <td className="px-3 py-2">{s.schedule.maxPunishment}</td>
                      <td className="px-3 py-2">{s.schedule.triableByCourt}</td>
                    </>
                  ) : (
                    <td colSpan={5} className="px-3 py-2 text-amber-800 dark:text-amber-200">
                      {t('notVerified')}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--muted)]">{t('basis', { date: scheduleDate })}</p>
    </div>
  );
}
