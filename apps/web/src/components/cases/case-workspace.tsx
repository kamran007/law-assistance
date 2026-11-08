'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, type KeyboardEvent } from 'react';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import type { Me } from '@/lib/auth/store';
import { isProfessional, isStatus, useArtifacts, useCase, useCaseConversation, useDeleteCase, useUpdateCase, type Artifact, type CaseFile } from '@/lib/cases';
import { errorKey } from '@/lib/problem';
import { CaseForm } from './case-form';

export const TABS = ['overview', 'documents', 'drafts', 'conversation'] as const;
export type Tab = (typeof TABS)[number];

/** Tabs a user sees (App Flow §8.2): Drafts and Conversation are for verified Lawyers / Judges. */
export const tabsFor = (user: Pick<Me, 'role'>): Tab[] => (isProfessional(user) ? [...TABS] : ['overview', 'documents']);

/** Case Workspace (App Flow §8.2). The tab is in the URL (`?tab=`), so it survives reloads and links. */
export function CaseWorkspace({ id, user, tab }: { id: string; user: Me; tab: string | null }) {
  const t = useTranslations('cases');
  const router = useRouter();
  const pathname = usePathname();
  const caseQuery = useCase(id);
  const tabs = tabsFor(user);
  const active: Tab = tabs.includes(tab as Tab) ? (tab as Tab) : 'overview';

  if (caseQuery.isPending) {
    return (
      <p role="status" className="text-[var(--muted)]">
        {t('loading')}
      </p>
    );
  }
  if (caseQuery.isError) {
    // Someone else's case and a missing one look the same (404): no hint that it exists.
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="font-medium">{isStatus(caseQuery.error, 404) ? t('notFound') : t('loadFailed')}</p>
        <Link href="/cases" className="text-brand-700 underline">
          {t('backToList')}
        </Link>
      </div>
    );
  }
  const c = caseQuery.data;
  const select = (next: Tab) => router.replace({ pathname, query: next === 'overview' ? {} : { tab: next } }, { scroll: false });
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.indexOf(active);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
      select(next);
      document.getElementById(`tab-${next}`)?.focus();
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/cases" className="text-sm text-brand-700 underline">
          {t('backToList')}
        </Link>
        <h1 className="text-2xl font-semibold">{c.title ?? c.case_number ?? t('untitled')}</h1>
      </div>
      <div role="tablist" aria-label={t('tabsLabel')} onKeyDown={onKey} className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {tabs.map((name) => (
          <button
            key={name}
            id={`tab-${name}`}
            role="tab"
            type="button"
            aria-selected={name === active}
            aria-controls={`panel-${name}`}
            tabIndex={name === active ? 0 : -1}
            onClick={() => select(name)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm ${name === active ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-[var(--muted)] hover:text-[var(--foreground)]'}`}
          >
            {t(`tabs.${name}`)}
          </button>
        ))}
      </div>
      <section role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === 'overview' && <Overview c={c} />}
        {active === 'documents' && <Documents id={id} />}
        {active === 'drafts' && <Placeholder text={t('drafts.empty')} />}
        {active === 'conversation' && <Conversation id={id} />}
      </section>
    </div>
  );
}

function Overview({ c }: { c: CaseFile }) {
  const t = useTranslations('cases');
  const te = useTranslations('errors');
  const format = useFormatter();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const update = useUpdateCase(c.case_id);
  const remove = useDeleteCase(c.case_id);
  const artifacts = useArtifacts(c.case_id);
  const dash = '—';

  if (editing) {
    return (
      <CaseForm
        initial={c}
        submitLabel={t('form.save')}
        onCancel={() => setEditing(false)}
        onSubmit={async (body) => {
          await update.mutateAsync({ version: c.version, body });
          setEditing(false);
        }}
      />
    );
  }

  const rows: [string, string][] = [
    [t('fields.caseNumber'), c.case_number ?? dash],
    [t('fields.court'), c.court_or_thana ?? dash],
    [t('fields.offenseDate'), c.alleged_offense_date ? format.dateTime(new Date(`${c.alleged_offense_date}T00:00:00+06:00`), { dateStyle: 'long' }) : dash],
    [t('fields.documents'), artifacts.data ? format.number(artifacts.data.length) : dash],
    [t('fields.updated'), format.dateTime(new Date(c.updated_at), { dateStyle: 'medium', timeStyle: 'short' })],
  ];
  return (
    <div className="space-y-6">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-sm text-[var(--muted)]">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {update.isError && isStatus(update.error, 409) && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {te('VERSION_CONFLICT')}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => setEditing(true)} className="rounded-lg border border-[var(--border)] px-4 py-2">
          {t('edit')}
        </button>
        <button type="button" onClick={() => setConfirming(true)} className="rounded-lg border border-red-300 px-4 py-2 text-red-700 dark:border-red-800 dark:text-red-300">
          {t('delete')}
        </button>
      </div>
      {confirming && (
        <div role="alertdialog" aria-labelledby="delete-title" aria-describedby="delete-body" className="space-y-3 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <p id="delete-title" className="font-medium">
            {t('deleteConfirmTitle')}
          </p>
          <p id="delete-body" className="text-sm">
            {t('deleteConfirmBody')}
          </p>
          {remove.isError && (
            <p role="alert" className="text-sm text-red-800 dark:text-red-200">
              {te(errorKey(remove.error))}
            </p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => router.replace('/cases') })}
              className="rounded-lg bg-red-700 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {t('deleteConfirm')}
            </button>
            <button type="button" autoFocus onClick={() => setConfirming(false)} className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2">
              {t('form.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  READY: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  FAILED: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
};

function Documents({ id }: { id: string }) {
  const t = useTranslations('cases.documents');
  const format = useFormatter();
  const { data, isPending, isError } = useArtifacts(id);
  if (isPending) return <p role="status" className="text-[var(--muted)]">{t('loading')}</p>;
  if (isError) return <p role="alert" className="text-red-700">{t('loadFailed')}</p>;
  if (data.length === 0) return <Placeholder text={t('empty')} />;
  return (
    <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--card)]">
      {data.map((a: Artifact) => {
        const status = a.processing_status ?? 'UPLOADED';
        return (
          <li key={a.artifact_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="font-medium">{t.has(`types.${a.artifact_type}`) ? t(`types.${a.artifact_type}`) : a.artifact_type}</p>
              <p className="text-xs text-[var(--muted)]">{format.dateTime(new Date(a.created_at), { dateStyle: 'medium', timeStyle: 'short' })}</p>
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'}`}>
              {t(`status.${status}`)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Conversation({ id }: { id: string }) {
  const t = useTranslations('cases.conversation');
  const { data, isPending, isError } = useCaseConversation(id, true);
  if (isPending) return <p role="status" className="text-[var(--muted)]">{t('loading')}</p>;
  if (isError) return <p role="alert" className="text-red-700">{t('loadFailed')}</p>;
  return <Placeholder text={t('ready', { title: data.title ?? '' })} />;
}

function Placeholder({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted)]">{text}</p>;
}
