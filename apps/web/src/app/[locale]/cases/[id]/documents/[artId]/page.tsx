import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ScanResultPage } from '@/components/scan/page';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'scan' });
  return { title: t('title'), robots: { index: false } };
}

export default async function Page({ params }: { params: Promise<{ locale: string; id: string; artId: string }> }) {
  const { locale, id, artId } = await params;
  setRequestLocale(locale);
  return <ScanResultPage caseId={id} artId={artId} />;
}
