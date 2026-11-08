import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { OnboardingGate } from '@/components/auth/onboarding-gate';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'onboarding' });
  return { title: t('title'), robots: { index: false } };
}

export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { next } = await searchParams;
  return (
    <div className="mx-auto max-w-xl py-6">
      <OnboardingGate next={next ?? null} />
    </div>
  );
}
