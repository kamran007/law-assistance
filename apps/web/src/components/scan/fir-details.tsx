'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { FirDateTime, StoredAnalysis } from '@/lib/scan-result';

/** FIR DETAILS block (App Flow §9.4): what the document states, parsed dates and the filing delay. */
export function FirDetails({ analysis }: { analysis: StoredAnalysis }) {
  const t = useTranslations('scan.fir');
  const fir = analysis.fir;
  const dash = t('notStated');
  const rows: [string, string][] = [
    [t('policeStation'), fir?.police_station ?? dash],
    [t('district'), fir?.district ?? dash],
    [t('firNumber'), fir?.fir_number ?? dash],
    [t('grNumber'), fir?.gr_number ?? dash],
    [t('place'), fir?.place_of_occurrence ?? dash],
  ];
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-sm text-[var(--muted)]">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <dt className="text-sm text-[var(--muted)]">{t('occurrence')}</dt>
        <dd>
          <When value={analysis.occurrence} raw={fir?.occurrence_datetime_raw ?? null} />
        </dd>
        <dt className="text-sm text-[var(--muted)]">{t('reported')}</dt>
        <dd>
          <When value={analysis.reported} raw={fir?.reported_datetime_raw ?? null} />
        </dd>
      </dl>
      <Delay delay={analysis.filingDelay} />
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="text-sm text-[var(--muted)]">{t('informant')}</dt>
        <dd>{fir?.informant?.name ?? dash}</dd>
        <dt className="text-sm text-[var(--muted)]">{t('accused')}</dt>
        <dd>
          {fir?.accused?.length ? (
            <ul className="space-y-0.5">
              {fir.accused.map((a, i) => (
                <li key={i}>
                  {a.name}
                  {a.role_in_allegation && <span className="text-sm text-[var(--muted)]"> — {a.role_in_allegation}</span>}
                </li>
              ))}
            </ul>
          ) : (
            dash
          )}
        </dd>
        <dt className="text-sm text-[var(--muted)]">{t('witnesses')}</dt>
        <dd>{fir?.witnesses?.length ? fir.witnesses.map((w) => w.name).join(', ') : dash}</dd>
      </dl>
      {fir?.narrative_summary && (
        <div className="rounded-lg bg-[var(--background)] p-3 text-sm">
          <p className="mb-1 text-xs font-medium text-[var(--muted)]">{t('summary')}</p>
          <p className="leading-relaxed">{fir.narrative_summary}</p>
        </div>
      )}
    </div>
  );
}

function When({ value, raw }: { value: FirDateTime | null; raw: string | null }) {
  const t = useTranslations('scan.fir');
  const format = useFormatter();
  if (!value) return <span>{raw ? t('unparsed', { raw }) : t('notStated')}</span>;
  const date = format.dateTime(new Date(`${value.date}T00:00:00+06:00`), { dateStyle: 'medium', timeZone: 'Asia/Dhaka' });
  const time = value.time ? format.dateTime(new Date(`${value.date}T${value.time}:00+06:00`), { timeStyle: 'short', timeZone: 'Asia/Dhaka' }) : null;
  return (
    <span>
      {time ? `${date}, ${time}` : date}
      {value.approximate && <span className="text-sm text-[var(--muted)]"> ({t('approximate')})</span>}
      {value.flags.includes('AMBIGUOUS_MERIDIEM') && <span className="block text-xs text-amber-800 dark:text-amber-200">{t('ambiguousTime')}</span>}
    </span>
  );
}

function Delay({ delay }: { delay: StoredAnalysis['filingDelay'] }) {
  const t = useTranslations('scan.fir');
  if (delay.warning === 'REPORTED_BEFORE_OCCURRENCE') return <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{t('reportedBefore')}</p>;
  if (delay.basis === 'UNKNOWN') return null;
  let text: string;
  if (delay.minutes !== null) {
    const days = Math.floor(delay.minutes / 1440);
    const hours = Math.floor((delay.minutes % 1440) / 60);
    text = t('delayDaysHours', { days, hours });
  } else text = t('delayDays', { days: delay.days ?? 0 });
  const notable = (delay.minutes ?? (delay.days ?? 0) * 1440) >= 1440;
  return (
    <p className={`rounded-lg px-3 py-2 text-sm ${notable ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100' : 'bg-[var(--background)]'}`}>
      {notable && '⚠ '}
      {text}
    </p>
  );
}
