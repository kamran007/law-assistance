import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

/** Acts | Case law switch at the top of the Law Library (App Flow §7.2, §7.3). */
export async function LibraryTabs({ current }: { current: 'acts' | 'judgments' }) {
  const t = await getTranslations('caseLaw');
  const tab = (key: 'acts' | 'judgments', href: string, label: string) => (
    <Link
      href={href}
      aria-current={current === key ? 'page' : undefined}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${current === key ? 'bg-brand-600 text-white' : 'border border-[var(--border)] text-brand-700'}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label={t('libraryNav')} className="flex gap-2">
      {tab('acts', '/library', t('tabActs'))}
      {tab('judgments', '/library/judgments', t('tabJudgments'))}
    </nav>
  );
}
