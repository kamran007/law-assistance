'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { DocumentCard } from '@/components/documents/document-card';
import { Link } from '@/i18n/navigation';
import { isStatus } from '@/lib/cases';
import { errorKey } from '@/lib/problem';
import { LOW_OCR_CONFIDENCE, useArtifactDetail, useCorrectArtifact, useReanalyze, type RoleAnalysis, type StoredAnalysis } from '@/lib/scan-result';
import { CorrectionsForm } from './corrections-form';
import { FirDetails } from './fir-details';
import { RoleAnalysisBlock } from './role-analysis';
import { SectionsTable } from './sections-table';

const PROCESSING = new Set(['UPLOADED', 'OCR', 'EXTRACTING', 'SCHEDULE_LOOKUP', 'ANALYZING']);

/** Scan Result screen (App Flow §9.4): FIR details, Schedule II table, role-specific analysis. */
export function ScanResult({ caseId, artId }: { caseId: string; artId: string }) {
  const t = useTranslations('scan');
  const te = useTranslations('errors');
  const td = useTranslations('cases.documents');
  const detail = useArtifactDetail(caseId, artId);
  const correct = useCorrectArtifact(caseId, artId);
  const reanalyze = useReanalyze(caseId, artId);
  const [editing, setEditing] = useState(false);

  if (detail.isPending) return <p role="status" className="text-[var(--muted)]">{t('loading')}</p>;
  if (detail.isError) {
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="font-medium">{isStatus(detail.error, 404) ? t('notFound') : t('loadFailed')}</p>
        <Link href={`/cases/${caseId}?tab=documents`} className="text-brand-700 underline">
          {t('back')}
        </Link>
      </div>
    );
  }

  const a = detail.data;
  const status = a.processing_status ?? 'UPLOADED';
  const processing = PROCESSING.has(status);
  const analysis = a.structured_analysis as StoredAnalysis | null;
  const role = a.role_analysis as RoleAnalysis | null;
  const typeLabel = td.has(`types.${a.artifact_type}`) ? td(`types.${a.artifact_type}`) : a.artifact_type;
  const needsReanalysis = analysis?.corrections?.needsReanalysis === true;
  const actionError = correct.error ?? reanalyze.error;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <Link href={`/cases/${caseId}?tab=documents`} className="text-sm text-brand-700 underline">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold">{typeLabel}</h1>
      </div>

      {(processing || status === 'FAILED') && (
        <ul className="rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <DocumentCard caseId={caseId} artifact={a} />
        </ul>
      )}
      {a.ocr_confidence !== null && a.ocr_confidence < LOW_OCR_CONFIDENCE && (
        <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {t('lowConfidence')}
        </p>
      )}

      {analysis?.documentKind === 'FIR' || analysis?.fir ? (
        <>
          <section aria-labelledby="fir-title" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="fir-title" className="text-lg font-semibold">
                {t('fir.title')}
              </h2>
              {status === 'READY' && !editing && (
                <button type="button" onClick={() => setEditing(true)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm">
                  {t('edit.open')}
                </button>
              )}
            </div>
            {actionError && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
                {isStatus(actionError, 412) ? te('VERSION_CONFLICT') : te(errorKey(actionError))}
              </p>
            )}
            {needsReanalysis && status === 'READY' && (
              <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-brand-50 px-3 py-2 text-sm dark:bg-brand-900">
                <span>{t('edit.needsReanalysis')}</span>
                <button type="button" disabled={reanalyze.isPending} onClick={() => reanalyze.mutate()} className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">
                  {t('edit.reanalyze')}
                </button>
              </div>
            )}
            {editing ? (
              <CorrectionsForm
                analysis={analysis}
                onCancel={() => setEditing(false)}
                onSubmit={async (body) => {
                  await correct.mutateAsync({ version: a.version, body });
                  setEditing(false);
                }}
              />
            ) : (
              <FirDetails analysis={analysis} />
            )}
          </section>

          <section aria-labelledby="sections-title" className="space-y-3">
            <h2 id="sections-title" className="text-lg font-semibold">
              {t('sections.title')}
            </h2>
            <SectionsTable sections={analysis.sections ?? []} scheduleDate={analysis.scheduleDate} />
          </section>

          <section aria-labelledby="analysis-title" className="space-y-3">
            <h2 id="analysis-title" className="text-lg font-semibold">
              {t('analysis.title')}
            </h2>
            <RoleAnalysisBlock analysis={role} sections={analysis.sections ?? []} processing={processing} />
          </section>

          <p className="rounded-lg border border-dashed border-[var(--border)] p-3 text-sm text-[var(--muted)]">{t('askSoon')}</p>
        </>
      ) : (
        !processing && status !== 'FAILED' && <p className="text-sm text-[var(--muted)]">{t('noAnalysis')}</p>
      )}
    </div>
  );
}
