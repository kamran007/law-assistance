'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth/use-auth';
import { isProfessional, isStatus } from '@/lib/cases';
import { citation, useSectionView, type VerifierTarget } from '@/lib/verifier';
import { SectionJudgments } from '../case-law/section-judgments';
import { VersionHistory } from './version-history';

const VerifierContext = createContext<(t: VerifierTarget) => void>(() => undefined);

/** Opens the Law Verifier from anywhere below the provider (citation chips, section rows). */
export const useOpenVerifier = () => useContext(VerifierContext);

export function VerifierProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<VerifierTarget | null>(null);
  const open = useCallback((t: VerifierTarget) => setTarget(t), []);
  return (
    <VerifierContext.Provider value={open}>
      {children}
      {target && <VerifierPanel target={target} onClose={() => setTarget(null)} />}
    </VerifierContext.Provider>
  );
}

/**
 * Law Verifier panel (App Flow §7.1): verbatim text, footnotes, version, Schedule II strip; version
 * history for Lawyers / Judges. A point-in-time request (`asOf`) is only made for them; Citizens
 * always see the current text.
 */
export function VerifierPanel({ target, onClose }: { target: VerifierTarget; onClose: () => void }) {
  const t = useTranslations('verifier');
  const ts = useTranslations('scan.sections');
  const locale = useLocale();
  const format = useFormatter();
  const auth = useAuth();
  const pro = auth.status === 'signedIn' && isProfessional(auth.user);
  const effective = { ...target, asOf: pro ? (target.asOf ?? null) : null };
  const { data, isPending, isError, error } = useSectionView(effective);
  const [history, setHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-xl space-y-5 overflow-y-auto bg-[var(--card)] p-6 shadow-xl outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">
            {t('title')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('close')} className="rounded-lg border border-[var(--border)] px-2.5 py-1">
            ×
          </button>
        </div>

        {isPending ? (
          <p role="status" className="text-[var(--muted)]">{t('loading')}</p>
        ) : isError ? (
          <p role="alert" className="text-sm text-red-800 dark:text-red-200">
            {isStatus(error, 404) ? t('notFound') : t('loadFailed')}
          </p>
        ) : (
          (() => {
            const { act, section: s, schedule_ii: sched } = data;
            const lang = act.language === 'BN' ? 'bn' : 'en';
            const title = (locale === 'bn' ? act.title_bn : act.title_en) ?? act.title;
            const outdated = data.current_version !== null && data.current_version !== s.version;
            return (
              <>
                <div className="space-y-1" lang={lang}>
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {title}
                    {act.act_number && <span className="text-sm font-normal text-[var(--muted)]">({act.act_number})</span>}
                    {act.status === 'REPEALED' && <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white">{t('repealed')}</span>}
                  </p>
                  {s.chapter && <p className="text-sm text-[var(--muted)]">{s.chapter}</p>}
                  <p className="font-semibold">
                    {t('section', { section: s.section_number })}
                    {s.heading && <> — {s.heading}</>}
                  </p>
                </div>

                {data.law_as_of && (
                  <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm dark:bg-brand-900">
                    {t('asOf', { date: date(data.law_as_of) })}
                    {outdated && <span className="block text-xs">{t('currentDiffers', { version: data.current_version! })}</span>}
                  </p>
                )}

                <div lang={lang} className="whitespace-pre-wrap rounded-lg border border-[var(--border)] p-3 text-sm leading-relaxed">
                  {s.text}
                </div>

                {s.footnotes.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-sm font-semibold">{t('footnotes')}</p>
                    <ol lang={lang} className="list-decimal space-y-1 pl-5 text-xs text-[var(--muted)]">
                      {s.footnotes.map((f, i) => (
                        <li key={i}>{f.text ?? [f.action, f.by_act, f.date].filter(Boolean).join(' · ')}</li>
                      ))}
                    </ol>
                  </div>
                )}

                <p className="text-sm text-[var(--muted)]">
                  {t('versionLine', { version: s.version })}
                  {s.is_current && <> ({t('current')})</>}
                  {s.valid_from && <> · {t('validFrom', { date: date(s.valid_from) })}</>}
                </p>

                <div className="flex flex-wrap gap-2 text-sm">
                  {pro && (
                    <button type="button" aria-expanded={history} onClick={() => setHistory((h) => !h)} className="rounded-lg border border-[var(--border)] px-3 py-1.5">
                      {t('history')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard?.writeText(citation(title, s.section_number, locale, data.law_as_of));
                      setCopied(true);
                    }}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5"
                  >
                    {copied ? t('copied') : t('copy')}
                  </button>
                  <Link href={`/library/${act.act_id}`} className="rounded-lg border border-[var(--border)] px-3 py-1.5">
                    {t('openAct')}
                  </Link>
                </div>
                {pro && history && <VersionHistory actId={act.act_id} sec={s.sec} lang={lang} />}

                {sched && (
                  <div className="space-y-1 rounded-lg border border-[var(--border)] p-3 text-sm">
                    <p className="font-semibold">{t('schedule')}</p>
                    <p>
                      {[
                        sched.is_cognizable ? t('cognizable') : t('nonCognizable'),
                        sched.is_bailable ? t('bailable') : t('nonBailable'),
                        sched.is_compoundable ? t('compoundable') : t('nonCompoundable'),
                        `${ts('maxPunishment')}: ${sched.max_punishment}`,
                        sched.triable_by_court,
                      ].join(' · ')}
                    </p>
                    <p className="text-xs text-[var(--muted)]">{t('scheduleNote')}</p>
                  </div>
                )}
                <SectionJudgments actId={act.act_id} sec={s.sec} />
              </>
            );
          })()
        )}
      </div>
    </div>
  );
}
