'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Field } from '@/components/field';
import { errorKey } from '@/lib/problem';
import type { FirCorrectionsBody, StoredAnalysis } from '@/lib/scan-result';

type SectionRow = { act: string; section: string };
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** Initial section rows: the user's earlier corrections, else what the analysis found. */
function initialSections(a: StoredAnalysis): SectionRow[] {
  if (a.corrections?.cited_sections) return a.corrections.cited_sections.map((s) => ({ act: s.act_hint ?? '', section: s.section }));
  return a.sections.map((s) => ({ act: s.act?.name ?? '', section: `${s.section}${s.subsection ?? ''}` }));
}

/**
 * "Edit fields" (App Flow §9.4, TRD §8.5): fix OCR mistakes. Only changed fields are sent. Party
 * fields are fixed in place; changed dates or sections mark the analysis for a re-run.
 */
export function CorrectionsForm({ analysis, onSubmit, onCancel }: { analysis: StoredAnalysis; onSubmit: (body: FirCorrectionsBody) => Promise<unknown>; onCancel: () => void }) {
  const t = useTranslations('scan.edit');
  const tf = useTranslations('scan.fir');
  const te = useTranslations('errors');
  const fir = analysis.fir;
  const start = {
    police_station: fir?.police_station ?? '',
    district: fir?.district ?? '',
    fir_number: fir?.fir_number ?? '',
    gr_number: fir?.gr_number ?? '',
    place_of_occurrence: fir?.place_of_occurrence ?? '',
    informant: fir?.informant?.name ?? '',
    accused: (fir?.accused ?? []).map((a) => a.name).join('\n'),
    witnesses: (fir?.witnesses ?? []).map((w) => w.name).join('\n'),
    occurrence: analysis.corrections?.occurrence_datetime ?? fir?.occurrence_datetime_raw ?? '',
    reported: analysis.corrections?.reported_datetime ?? fir?.reported_datetime_raw ?? '',
  };
  const [v, setV] = useState(start);
  const [sections, setSections] = useState<SectionRow[]>(() => initialSections(analysis));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof start) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));

  const buildBody = (): FirCorrectionsBody => {
    const body: Record<string, unknown> = {};
    for (const k of ['police_station', 'district', 'fir_number', 'gr_number', 'place_of_occurrence'] as const) if (v[k] !== start[k]) body[k] = orNull(v[k]);
    if (v.informant !== start.informant) body.informant = { name: orNull(v.informant), address: fir?.informant?.address ?? null };
    if (v.accused !== start.accused) {
      // Keep what each accused is alleged to have done when the name is unchanged.
      const roles = new Map((fir?.accused ?? []).map((a) => [a.name, a.role_in_allegation]));
      body.accused = lines(v.accused).map((name) => ({ name, role_in_allegation: roles.get(name) ?? null }));
    }
    if (v.witnesses !== start.witnesses) body.witnesses = lines(v.witnesses).map((name) => ({ name }));
    if (v.occurrence !== start.occurrence) body.occurrence_datetime = orNull(v.occurrence);
    if (v.reported !== start.reported) body.reported_datetime = orNull(v.reported);
    const rows = sections.filter((r) => r.section.trim());
    const before = initialSections(analysis);
    if (JSON.stringify(rows) !== JSON.stringify(before)) body.cited_sections = rows.map((r) => ({ act_hint: orNull(r.act), section: r.section.trim() }));
    return body as FirCorrectionsBody;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = buildBody();
    if (Object.keys(body).length === 0) return onCancel();
    setBusy(true);
    try {
      await onSubmit(body);
    } catch (err) {
      setError(errorKey(err));
      setBusy(false);
    }
  };

  const area = (k: 'accused' | 'witnesses', label: string) => (
    <div className="space-y-1">
      <label htmlFor={`edit-${k}`} className="block text-sm font-medium">
        {label}
      </label>
      <textarea id={`edit-${k}`} aria-describedby="edit-one-per-line" value={v[k]} onChange={set(k)} rows={3} className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2" />
    </div>
  );

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tf('policeStation')} value={v.police_station} onChange={set('police_station')} maxLength={200} />
        <Field label={tf('district')} value={v.district} onChange={set('district')} maxLength={200} />
        <Field label={tf('firNumber')} value={v.fir_number} onChange={set('fir_number')} maxLength={100} />
        <Field label={tf('grNumber')} value={v.gr_number} onChange={set('gr_number')} maxLength={100} />
      </div>
      <Field label={tf('place')} value={v.place_of_occurrence} onChange={set('place_of_occurrence')} maxLength={500} />
      <Field label={tf('informant')} value={v.informant} onChange={set('informant')} maxLength={200} />
      {area('accused', tf('accused'))}
      {area('witnesses', tf('witnesses'))}
      <p id="edit-one-per-line" className="-mt-2 text-xs text-[var(--muted)]">
        {t('onePerLine')}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tf('occurrence')} hint={t('dateHint')} value={v.occurrence} onChange={set('occurrence')} maxLength={200} />
        <Field label={tf('reported')} value={v.reported} onChange={set('reported')} maxLength={200} />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('sections')}</legend>
        {sections.map((r, i) => (
          <div key={i} className="flex gap-2">
            <input aria-label={t('actLabel', { n: i + 1 })} value={r.act} placeholder={t('actPlaceholder')} onChange={(e) => setSections((s) => s.map((x, j) => (j === i ? { ...x, act: e.target.value } : x)))} maxLength={200} className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2" />
            <input aria-label={t('sectionLabel', { n: i + 1 })} value={r.section} onChange={(e) => setSections((s) => s.map((x, j) => (j === i ? { ...x, section: e.target.value } : x)))} maxLength={32} className="w-28 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2" />
            <button type="button" aria-label={t('removeSection', { n: i + 1 })} onClick={() => setSections((s) => s.filter((_, j) => j !== i))} className="rounded-lg border border-[var(--border)] px-3">
              ×
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setSections((s) => [...s, { act: '', section: '' }])} className="text-sm text-brand-700 underline">
          {t('addSection')}
        </button>
        <p className="text-xs text-[var(--muted)]">{t('sectionsHint')}</p>
      </fieldset>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {te.has(error) ? te(error) : te('generic')}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-50">
          {busy ? t('saving') : t('save')}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border)] px-4 py-2">
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}
