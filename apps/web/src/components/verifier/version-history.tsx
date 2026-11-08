'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { wordDiff } from '@/lib/diff';
import { useSectionVersions } from '@/lib/verifier';

/**
 * Version history (App Flow §7.1, FR-A4; Lawyers / Judges): every version with its validity, and
 * the chosen old version's text with a word diff against the current one.
 */
export function VersionHistory({ actId, sec, lang }: { actId: number; sec: string; lang: 'bn' | 'en' }) {
  const t = useTranslations('verifier');
  const format = useFormatter();
  const { data, isPending, isError } = useSectionVersions(actId, sec, true);
  const [chosen, setChosen] = useState<number | null>(null);

  if (isPending) return <p role="status" className="text-sm text-[var(--muted)]">{t('loadingVersions')}</p>;
  if (isError) return <p role="alert" className="text-sm text-red-700">{t('versionsFailed')}</p>;

  const versions = [...data.versions].sort((x, y) => y.version - x.version);
  const current = versions.find((v) => v.is_current) ?? versions[0]!;
  const old = versions.find((v) => v.version === chosen) ?? null;
  const date = (d: string | null) => (d ? format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) : t('open'));

  return (
    <div className="space-y-3">
      {versions.length === 1 ? (
        <p className="text-sm text-[var(--muted)]">{t('onlyVersion')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
          {versions.map((v) => (
            <li key={v.section_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-medium">{t('versionN', { version: v.version })}</span>
                {v.is_current && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{t('current')}</span>}
                <span className="block text-xs text-[var(--muted)]">{t('validity', { from: date(v.valid_from), to: date(v.valid_to) })}</span>
              </span>
              {!v.is_current && (
                <button type="button" aria-pressed={chosen === v.version} onClick={() => setChosen(chosen === v.version ? null : v.version)} className="text-brand-700 underline">
                  {chosen === v.version ? t('hideDiff') : t('compare')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {old && (
        <div className="space-y-2">
          <p className="text-xs text-[var(--muted)]">{t('diffLegend', { old: old.version, current: current.version })}</p>
          <div lang={lang} className="whitespace-pre-wrap rounded-lg border border-[var(--border)] p-3 text-sm leading-relaxed" aria-label={t('diffLabel')}>
            {wordDiff(old.text, current.text).map((p, i) =>
              p.kind === 'same' ? (
                <span key={i}>{p.text}</span>
              ) : p.kind === 'removed' ? (
                <del key={i} className="bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200">
                  {p.text}
                </del>
              ) : (
                <ins key={i} className="bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-950 dark:text-emerald-200">
                  {p.text}
                </ins>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
