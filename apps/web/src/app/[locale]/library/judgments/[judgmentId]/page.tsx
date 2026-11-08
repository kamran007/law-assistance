import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { cache } from 'react';
import { Link } from '@/i18n/navigation';
import { dataOrNull, judgmentLang, serverApi } from '@/lib/server-api';

// The original-PDF link is presigned for 10 minutes, so this page is rendered per request, not cached.
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loadJudgment = cache(async (id: string) => (UUID.test(id) ? dataOrNull(serverApi(0).GET('/api/v1/judgments/{judgment_id}', { params: { path: { judgment_id: id } } })) : null));

export async function generateMetadata({ params }: { params: Promise<{ locale: string; judgmentId: string }> }): Promise<Metadata> {
  const { judgmentId } = await params;
  const j = await loadJudgment(judgmentId).catch(() => null);
  if (!j) return {};
  return {
    title: `${j.parties} · ${j.citation}`,
    description: j.key_words || undefined,
    alternates: { languages: { bn: `/bn/library/judgments/${judgmentId}`, en: `/en/library/judgments/${judgmentId}` } },
  };
}

/**
 * Judgment Viewer (App Flow §7.3): metadata, linked sections, the key ratio, the text by paragraph
 * with `#para-n` anchors (so citations and the verifier can link to a paragraph) and the original PDF.
 */
export default async function JudgmentPage({ params }: { params: Promise<{ locale: string; judgmentId: string }> }) {
  const { locale, judgmentId } = await params;
  setRequestLocale(locale);
  const j = await loadJudgment(judgmentId);
  if (!j) notFound();
  const t = await getTranslations('caseLaw');
  const format = await getFormatter();
  const lang = judgmentLang(j.language);
  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' });
  const keyRatio = new Set(j.key_ratio_paragraphs.map(Number));
  // One entry per Act + section; paragraphs from key words and body merged.
  const sections = new Map<string, { actId: number | null; title: string | null; sec: string | null; raw: string; paragraphs: Set<string> }>();
  for (const s of j.linked_sections) {
    const key = s.act_id !== null ? `${s.act_id}:${s.sec}` : `raw:${s.raw}`;
    const entry = sections.get(key) ?? { actId: s.act_id, title: s.act_title, sec: s.sec, raw: s.raw, paragraphs: new Set<string>() };
    s.paragraphs.forEach((p) => entry.paragraphs.add(p));
    sections.set(key, entry);
  }
  const linked = [...sections.values()].filter((s) => s.actId !== null);
  const unresolved = [...sections.values()].filter((s) => s.actId === null);

  return (
    <article className="space-y-6">
      <div className="space-y-2">
        <Link href="/library/judgments" className="text-sm text-brand-700 underline">
          {t('backToList')}
        </Link>
        <h1 className="text-2xl font-semibold" lang={lang}>
          {j.parties}
        </h1>
        <p className="text-sm text-[var(--muted)]">{[j.citation, t(`division.${j.division}`), j.case_number].filter(Boolean).join(' · ')}</p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--muted)]">{t('decided')}</dt>
            <dd>{j.decision_date ? date(j.decision_date) : t('dateUnknown')}</dd>
          </div>
          {j.authoring_judge && (
            <div>
              <dt className="text-xs text-[var(--muted)]">{t('author')}</dt>
              <dd>{j.authoring_judge}</dd>
            </div>
          )}
          {j.bench.length > 0 && (
            <div>
              <dt className="text-xs text-[var(--muted)]">{t('bench')}</dt>
              <dd>{j.bench.join('; ')}</dd>
            </div>
          )}
        </dl>
        <div className="flex flex-wrap gap-2 text-sm">
          {j.pdf_url && (
            <a href={j.pdf_url} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white">
              {t('openPdf')}
            </a>
          )}
          <a href={j.source_pdf_url} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-[var(--border)] px-3 py-1.5">
            {t('sourcePdf')}
          </a>
        </div>
      </div>

      {j.key_words && (
        <section aria-labelledby="kw" className="space-y-1">
          <h2 id="kw" className="text-sm font-semibold">
            {t('keyWords')}
          </h2>
          <p className="whitespace-pre-line text-sm" lang={lang}>
            {j.key_words}
          </p>
        </section>
      )}

      {(linked.length > 0 || unresolved.length > 0) && (
        <section aria-labelledby="sections" className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h2 id="sections" className="text-sm font-semibold">
            {t('linkedSections')}
          </h2>
          {linked.length > 0 && (
            <ul className="space-y-1 text-sm">
              {linked.map((s) => (
                <li key={`${s.actId}:${s.sec}`}>
                  <Link href={`/library/${s.actId}/${encodeURIComponent(s.sec ?? '')}`} className="text-brand-700 underline">
                    {t('sectionOf', { sec: s.sec ?? '', act: s.title ?? String(s.actId) })}
                  </Link>
                  {s.paragraphs.size > 0 && (
                    <span className="text-[var(--muted)]">
                      {' '}
                      ·{' '}
                      {[...s.paragraphs]
                        .sort((a, b) => Number(a) - Number(b))
                        .map((p, i) => (
                          <span key={p}>
                            {i > 0 && ', '}
                            <a href={`#para-${p}`} className="underline">
                              {t('para', { n: p })}
                            </a>
                          </span>
                        ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {unresolved.length > 0 && (
            <p className="text-xs text-[var(--muted)]" lang={lang}>
              {t('alsoCited')} {unresolved.map((s) => s.raw).join('; ')}
            </p>
          )}
        </section>
      )}

      {j.summary && (
        <section aria-labelledby="summary" className="space-y-1">
          <h2 id="summary" className="text-sm font-semibold">
            {t('summary')}
          </h2>
          <p className="whitespace-pre-line text-sm leading-relaxed" lang={lang}>
            {j.summary}
          </p>
        </section>
      )}

      {!j.text_available ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-[var(--muted)]">{t('textPendingLong')}</p>
      ) : (
        <section aria-labelledby="text" className="space-y-3">
          <h2 id="text" className="text-sm font-semibold">
            {t('judgmentText')}
          </h2>
          {j.preamble && (
            <details className="rounded-lg border border-[var(--border)] p-3 text-sm">
              <summary className="cursor-pointer font-medium">{t('preamble')}</summary>
              <p className="mt-2 whitespace-pre-line text-[var(--muted)]" lang={lang}>
                {j.preamble}
              </p>
            </details>
          )}
          <ol className="space-y-3" lang={lang}>
            {j.paragraphs.map((p) => (
              <li
                key={p.n}
                id={`para-${p.n}`}
                className={`scroll-mt-20 rounded-lg p-2 leading-relaxed target:bg-brand-50 dark:target:bg-brand-900 ${keyRatio.has(p.n) ? 'border-l-4 border-brand-600 bg-brand-50/50 dark:bg-brand-900/40' : ''}`}
              >
                <a href={`#para-${p.n}`} className="mr-2 text-sm font-semibold text-brand-700" aria-label={t('paraLink', { n: p.n })}>
                  {p.n}.
                </a>
                {keyRatio.has(p.n) && <span className="mr-2 rounded bg-brand-600 px-1.5 py-0.5 text-xs font-semibold text-white">{t('keyRatio')}</span>}
                {p.text}
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="text-xs text-[var(--muted)]">{t('sourceNote')}</p>
    </article>
  );
}
