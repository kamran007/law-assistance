import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DraftPage } from '@/components/drafts/page';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'drafts' });
  return { title: t('title'), robots: { index: false } };
}

export default async function Page({ params }: { params: Promise<{ locale: string; id: string; artId: string }> }) {
  const { locale, id, artId } = await params;
  setRequestLocale(locale);
  return <DraftPage caseId={id} artId={artId} />;
}
