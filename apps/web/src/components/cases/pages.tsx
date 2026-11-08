'use client';

import { useTranslations } from 'next-intl';
import { RequireAuth } from '@/components/auth/require-auth';
import { useRouter } from '@/i18n/navigation';
import { useCreateCase } from '@/lib/cases';
import { CaseForm } from './case-form';
import { CaseList } from './case-list';
import { CaseWorkspace } from './case-workspace';

/** Signed-in pages for case files (App Flow §8). The API scopes every call to the caller. */
export function CasesPage() {
  return <RequireAuth>{() => <CaseList />}</RequireAuth>;
}

export function NewCasePage() {
  return <RequireAuth>{() => <NewCase />}</RequireAuth>;
}

export function CaseWorkspacePage({ id, tab }: { id: string; tab: string | null }) {
  return <RequireAuth>{(user) => <CaseWorkspace id={id} user={user} tab={tab} />}</RequireAuth>;
}

function NewCase() {
  const t = useTranslations('cases');
  const router = useRouter();
  const create = useCreateCase();
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('new')}</h1>
      <CaseForm
        submitLabel={t('form.create')}
        onCancel={() => router.replace('/cases')}
        onSubmit={async (body) => {
          const created = await create.mutateAsync(body);
          router.replace(`/cases/${created.case_id}`);
        }}
      />
    </div>
  );
}
