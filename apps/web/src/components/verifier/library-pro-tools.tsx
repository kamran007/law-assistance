'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useAuth } from '@/lib/auth/use-auth';
import { isProfessional } from '@/lib/cases';
import { VerifierPanel } from './verifier-panel';
import { VersionHistory } from './version-history';

/**
 * Lawyer / Judge tools on a public section page (FR-A4): the text as in force on a date, and the
 * version history with diffs. Nothing is shown to Citizens or signed-out visitors.
 */
export function LibraryProTools({ actId, sec, lang }: { actId: number; sec: string; lang: 'bn' | 'en' }) {
  const t = useTranslations('verifier');
  const auth = useAuth();
  const [date, setDate] = useState('');
  const [asOf, setAsOf] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  if (auth.status !== 'signedIn' || !isProfessional(auth.user)) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

  return (
    <section aria-labelledby="pro-tools" className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <h2 id="pro-tools" className="text-sm font-semibold">
        {t('proTools')}
      </h2>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (date) setAsOf(date);
        }}
      >
        <label className="space-y-1 text-sm">
          <span className="block">{t('lawOnDate')}</span>
          <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5" />
        </label>
        <button type="submit" disabled={!date} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {t('showText')}
        </button>
        <button type="button" aria-expanded={history} onClick={() => setHistory((h) => !h)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm">
          {t('history')}
        </button>
      </form>
      {history && <VersionHistory actId={actId} sec={sec} lang={lang} />}
      {asOf && <VerifierPanel target={{ actId, sec, asOf }} onClose={() => setAsOf(null)} />}
    </section>
  );
}
