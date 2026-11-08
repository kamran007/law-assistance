'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useArtifactStatus, type StatusStreamDeps } from '@/lib/artifact-status';
import { Link } from '@/i18n/navigation';
import type { Artifact } from '@/lib/cases';

/** Processing steps shown on the card (App Flow §9.3). */
export const STEPS = ['UPLOADED', 'OCR', 'EXTRACTING', 'SCHEDULE_LOOKUP', 'ANALYZING'] as const;

/** A document in the Documents tab, with a live progress stepper until it is READY or FAILED. */
export function DocumentCard({ caseId, artifact, onUploadAgain, streamDeps, linkToResult = false }: { caseId: string; artifact: Artifact; onUploadAgain?: () => void; streamDeps?: StatusStreamDeps; linkToResult?: boolean }) {
  const t = useTranslations('cases.documents');
  const format = useFormatter();
  useArtifactStatus(caseId, artifact, streamDeps);
  const status = artifact.processing_status ?? 'UPLOADED';
  const current = STEPS.indexOf(status as (typeof STEPS)[number]);
  const typeLabel = t.has(`types.${artifact.artifact_type}`) ? t(`types.${artifact.artifact_type}`) : artifact.artifact_type;

  return (
    <li className="space-y-3 px-4 py-3" aria-busy={status !== 'READY' && status !== 'FAILED'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {linkToResult ? (
            <Link href={`/cases/${caseId}/documents/${artifact.artifact_id}`} className="font-medium text-brand-700 hover:underline">
              {typeLabel}
            </Link>
          ) : (
            <p className="font-medium">{typeLabel}</p>
          )}
          <p className="text-xs text-[var(--muted)]">{format.dateTime(new Date(artifact.created_at), { dateStyle: 'medium', timeStyle: 'short' })}</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            status === 'READY'
              ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
              : status === 'FAILED'
                ? 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200'
                : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
          }`}
        >
          {t(`status.${status}`)}
        </span>
      </div>
      {current >= 0 && (
        <ol aria-label={t('progressLabel')} className="grid grid-cols-5 gap-1">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === current ? 'step' : undefined} className="space-y-1">
              <div className={`h-1.5 rounded-full ${i < current ? 'bg-brand-600' : i === current ? 'animate-pulse bg-brand-600/60' : 'bg-[var(--border)]'}`} />
              <p className={`hidden text-[11px] sm:block ${i === current ? 'font-medium' : 'text-[var(--muted)]'}`}>{t(`steps.${s}`)}</p>
            </li>
          ))}
        </ol>
      )}
      {status === 'FAILED' && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p role="alert" className="text-red-800 dark:text-red-200">
            {t('failed')}
          </p>
          {onUploadAgain && (
            <button type="button" onClick={onUploadAgain} className="text-brand-700 underline">
              {t('uploadAgain')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
