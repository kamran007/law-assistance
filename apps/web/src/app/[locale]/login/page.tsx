import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { LoginFlow } from '@/components/auth/login-flow';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'auth' });
  return { title: t('title'), robots: { index: false } };
}

export default async function LoginPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { next } = await searchParams;
  return (
    <div className="mx-auto max-w-md py-6">
      <LoginFlow next={next ?? null} />
    </div>
  );
}
