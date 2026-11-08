'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Field } from '@/components/field';
import type { CaseFile, CaseInput } from '@/lib/cases';
import { errorKey, type ErrorKey } from '@/lib/problem';

/** Today in Asia/Dhaka as YYYY-MM-DD (an offense date can't be in the future). */
export function dhakaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Create / edit a case file (App Flow §8.1). Every field is optional; empty fields are sent as null
 * so an edit can clear them. The offense date drives point-in-time law in the case conversation.
 */
export function CaseForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Pick<CaseFile, 'title' | 'case_number' | 'court_or_thana' | 'alleged_offense_date'>;
  submitLabel: string;
  onSubmit: (body: CaseInput) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const t = useTranslations('cases.form');
  const te = useTranslations('errors');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [caseNumber, setCaseNumber] = useState(initial?.case_number ?? '');
  const [court, setCourt] = useState(initial?.court_or_thana ?? '');
  const [offenseDate, setOffenseDate] = useState(initial?.alleged_offense_date ?? '');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [busy, setBusy] = useState(false);
  const today = dhakaToday();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (offenseDate && offenseDate > today) return setError('OFFENSE_DATE_IN_FUTURE');
    setBusy(true);
    try {
      const orNull = (v: string) => (v.trim() ? v.trim() : null);
      await onSubmit({ title: orNull(title), case_number: orNull(caseNumber), court_or_thana: orNull(court), alleged_offense_date: offenseDate || null });
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label={t('title')} hint={t('titleHint')} name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
      <Field label={t('caseNumber')} hint={t('caseNumberHint')} name="case_number" value={caseNumber} onChange={(e) => setCaseNumber(e.target.value)} maxLength={200} />
      <Field label={t('court')} name="court_or_thana" value={court} onChange={(e) => setCourt(e.target.value)} maxLength={200} />
      <Field
        label={t('offenseDate')}
        hint={t('offenseDateHint')}
        name="alleged_offense_date"
        type="date"
        max={today}
        value={offenseDate}
        onChange={(e) => setOffenseDate(e.target.value)}
      />
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {te(error)}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-50">
          {busy ? t('saving') : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border)] px-4 py-2">
            {t('cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
