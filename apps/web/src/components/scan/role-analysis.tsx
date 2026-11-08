'use client';

import { useTranslations } from 'next-intl';
import type { AnalysedSection, CitizenContent, JudgeContent, LawyerContent, RoleAnalysis } from '@/lib/scan-result';

type Sources = Extract<RoleAnalysis, { status: 'READY' }>['sources'];

/**
 * Role-specific analysis (App Flow §9.4). Every statutory point carries citation chips that name
 * the section version the server validated it against (TRD §7.4); points without a valid citation
 * were already dropped server-side.
 */
export function RoleAnalysisBlock({ analysis, sections, processing }: { analysis: RoleAnalysis | null; sections: AnalysedSection[]; processing: boolean }) {
  const t = useTranslations('scan.analysis');
  if (!analysis) return <p role="status" className="text-sm text-[var(--muted)]">{processing ? t('preparing') : t('none')}</p>;
  if (analysis.status === 'UNAVAILABLE') return <p className="text-sm text-[var(--muted)]">{t('unavailable')}</p>;
  if (analysis.status === 'FAILED') return <p role="alert" className="text-sm text-red-800 dark:text-red-200">{t('failed')}</p>;

  const name = (ref: string) => {
    const s = sections.find((x) => `${x.act?.key ?? 'UNKNOWN_ACT'}:${x.key}` === ref);
    return s ? t('ref', { act: s.act?.name ?? '', section: s.section }) : ref;
  };
  const cite = (ids: number[]) => <Citations ids={ids} sources={analysis.sources} name={name} />;

  return (
    <div className="space-y-6">
      {analysis.role === 'CITIZEN' && <Citizen c={analysis.content as CitizenContent} name={name} cite={cite} />}
      {analysis.role === 'LAWYER' && <Lawyer c={analysis.content as LawyerContent} name={name} cite={cite} />}
      {analysis.role === 'JUDGE' && <Judge c={analysis.content as JudgeContent} name={name} cite={cite} />}
      {analysis.sources.some((s) => s.currentTextUsed) && <p className="text-xs text-[var(--muted)]">{t('currentTextUsed')}</p>}
      <p className="text-xs text-[var(--muted)]">{t('disclaimer')}</p>
    </div>
  );
}

type Cite = (ids: number[]) => React.ReactNode;

function Citations({ ids, sources, name }: { ids: number[]; sources: Sources; name: (ref: string) => string }) {
  const t = useTranslations('scan.analysis');
  const known = ids.map((n) => sources.find((s) => s.n === n)).filter((s): s is Sources[number] => !!s);
  if (known.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {known.map((s) => (
        <span key={s.n} title={t('citationTitle', { version: s.versionNumber })} className="rounded bg-brand-100 px-1.5 py-0.5 text-[11px] font-medium text-brand-900 dark:bg-brand-900 dark:text-brand-100">
          [{s.n}] {name(s.sectionRef)}
        </span>
      ))}
    </span>
  );
}

function Citizen({ c, name, cite }: { c: CitizenContent; name: (r: string) => string; cite: Cite }) {
  const t = useTranslations('scan.analysis');
  return (
    <>
      <p className="leading-relaxed">{c.summary}</p>
      {c.sections.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold">{t('citizen.sections')}</h3>
          {c.sections.map((s) => (
            <div key={s.section_ref} className="rounded-lg border border-[var(--border)] p-3">
              <p className="text-sm font-medium">{name(s.section_ref)}</p>
              <p className="mt-1 text-sm">
                {s.plain_explanation}
                {cite(s.source_ids)}
              </p>
            </div>
          ))}
        </div>
      )}
      {c.next_steps.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold">{t('citizen.nextSteps')}</h3>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {c.next_steps.map((s, i) => (
              <li key={i}>
                {s.step}
                {cite(s.source_ids)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

const STATUS_STYLE = {
  ALLEGED: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  NOT_ALLEGED: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  UNCLEAR: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
} as const;

function IngredientStatus({ status }: { status: keyof typeof STATUS_STYLE }) {
  const t = useTranslations('scan.analysis.ingredient');
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{t(status)}</span>;
}

function Lawyer({ c, name, cite }: { c: LawyerContent; name: (r: string) => string; cite: Cite }) {
  const t = useTranslations('scan.analysis');
  return (
    <>
      <h3 className="font-semibold">{t('lawyer.audit')}</h3>
      {c.sections.map((s) => (
        <div key={s.section_ref} className="space-y-2">
          <p className="text-sm font-medium">{name(s.section_ref)}</p>
          <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {s.ingredients.map((g, i) => (
              <li key={i} className="space-y-1 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span>
                    {g.ingredient}
                    {cite(g.source_ids)}
                  </span>
                  <IngredientStatus status={g.status} />
                </div>
                {g.evidence_in_fir && <blockquote className="border-l-2 border-[var(--border)] pl-2 text-xs text-[var(--muted)]">“{g.evidence_in_fir}”</blockquote>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className={`rounded-lg p-3 text-sm ${c.delay.assessment === 'UNEXPLAINED' ? 'bg-amber-50 dark:bg-amber-950' : 'bg-[var(--background)]'}`}>
        <p className="font-medium">{t(`lawyer.delay.${c.delay.assessment}`)}</p>
        <p className="mt-1">{c.delay.note}</p>
        {c.delay.evidence_in_fir && <blockquote className="mt-1 border-l-2 border-[var(--border)] pl-2 text-xs text-[var(--muted)]">“{c.delay.evidence_in_fir}”</blockquote>}
      </div>
      {c.grounds.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold">{t('lawyer.grounds')}</h3>
          <ul className="space-y-2 text-sm">
            {c.grounds.map((g, i) => (
              <li key={i}>
                <span className="mr-2 rounded bg-[var(--background)] px-1.5 py-0.5 text-xs font-medium">{t(`lawyer.kind.${g.kind}`)}</span>
                {g.ground}
                {cite(g.source_ids)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Judge({ c, name, cite }: { c: JudgeContent; name: (r: string) => string; cite: Cite }) {
  const t = useTranslations('scan.analysis');
  return (
    <>
      <h3 className="font-semibold">{t('judge.matrix')}</h3>
      {c.sections.map((s) => (
        <div key={s.section_ref} className="space-y-2">
          <p className="text-sm font-medium">{name(s.section_ref)}</p>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-[var(--background)] text-left text-xs text-[var(--muted)]">
                <tr>
                  <th scope="col" className="px-3 py-2">{t('judge.ingredient')}</th>
                  <th scope="col" className="px-3 py-2">{t('judge.allegation')}</th>
                  <th scope="col" className="px-3 py-2">{t('judge.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {s.ingredients.map((g, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2">
                      {g.ingredient}
                      {cite(g.source_ids)}
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)]">{g.allegation ? `“${g.allegation}”` : t('judge.noAllegation')}</td>
                    <td className="px-3 py-2">
                      <IngredientStatus status={g.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {c.observations.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold">{t('judge.observations')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {c.observations.map((o, i) => (
              <li key={i}>
                {o.text}
                {cite(o.source_ids)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
