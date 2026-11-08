'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { useArtifacts } from '@/lib/cases';
import { DRAFT_TYPE, useCreateDraft, useDraftTemplates } from '@/lib/drafts';
import { errorKey } from '@/lib/problem';

/** Drafts tab (App Flow §8.2, §10): the case's drafts and "New draft" with a template picker. */
export function DraftsTab({ caseId }: { caseId: string }) {
  const t = useTranslations('drafts');
  const te = useTranslations('errors');
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const artifacts = useArtifacts(caseId);
  const templates = useDraftTemplates();
  const create = useCreateDraft(caseId);
  const titleOf = (key: string | null) => {
    const tpl = templates.data?.find((x) => x.key === key);
    return tpl ? (locale === 'bn' ? tpl.title_bn : tpl.title_en) : t('untitled');
  };
  const drafts = (artifacts.data ?? []).filter((a) => a.artifact_type === DRAFT_TYPE).sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" aria-expanded={picking} onClick={() => setPicking((p) => !p)} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white">
          {t('new')}
        </button>
      </div>
      {picking && (
        <section aria-labelledby="tpl-title" className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h2 id="tpl-title" className="font-medium">
            {t('chooseTemplate')}
          </h2>
          {templates.isPending ? (
            <p role="status" className="text-sm text-[var(--muted)]">{t('loading')}</p>
          ) : templates.isError ? (
            <p role="alert" className="text-sm text-red-700">{te(errorKey(templates.error))}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {templates.data.map((tpl) => (
                <li key={tpl.key}>
                  <button
                    type="button"
                    disabled={create.isPending}
                    onClick={() =>
                      create.mutate({ template_key: tpl.key, language: locale === 'en' ? 'EN' : 'BN' }, { onSuccess: (d) => router.push(`/cases/${caseId}/drafts/${d.artifact_id}`) })
                    }
                    className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-left hover:border-brand-600 disabled:opacity-50"
                  >
                    <span className="block font-medium">{locale === 'bn' ? tpl.title_bn : tpl.title_en}</span>
                    <span className="block text-xs text-[var(--muted)]">{(locale === 'bn' ? tpl.headings_bn : tpl.headings_en).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {create.isError && <p role="alert" className="text-sm text-red-700">{te(errorKey(create.error))}</p>}
        </section>
      )}
      {artifacts.isPending ? (
        <p role="status" className="text-[var(--muted)]">{t('loading')}</p>
      ) : drafts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted)]">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--card)]">
          {drafts.map((d) => (
            <li key={d.artifact_id}>
              <Link href={`/cases/${caseId}/drafts/${d.artifact_id}`} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 hover:bg-brand-50 dark:hover:bg-brand-900">
                <span className="font-medium">{titleOf(d.template_key)}</span>
                <span className="text-xs text-[var(--muted)]">{t('edited', { date: format.dateTime(new Date(d.updated_at), { dateStyle: 'medium', timeStyle: 'short' }) })}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
