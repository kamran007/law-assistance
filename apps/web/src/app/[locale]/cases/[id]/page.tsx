import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CaseWorkspacePage } from '@/components/cases/pages';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'cases' });
  return { title: t('workspace'), robots: { index: false } };
}

export default async function Page({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const { tab } = await searchParams;
  return <CaseWorkspacePage id={id} tab={tab ?? null} />;
}
