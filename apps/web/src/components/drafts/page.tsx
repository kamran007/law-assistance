'use client';

import { useTranslations } from 'next-intl';
import { RequireAuth } from '@/components/auth/require-auth';
import { isProfessional } from '@/lib/cases';
import { DraftEditorPage } from './draft-editor';

/** Drafts are for verified Lawyers / Judges (the API refuses others too). */
export function DraftPage({ caseId, artId }: { caseId: string; artId: string }) {
  const t = useTranslations('drafts');
  return (
    <RequireAuth>
      {(user) => (isProfessional(user) ? <DraftEditorPage caseId={caseId} artId={artId} /> : <p className="py-10 text-center text-[var(--muted)]">{t('professionalsOnly')}</p>)}
    </RequireAuth>
  );
}
